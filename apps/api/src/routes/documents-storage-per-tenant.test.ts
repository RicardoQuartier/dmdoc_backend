import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import FormData from 'form-data';
import { newId } from '@dmdoc/db-pg';
import {
  createStorageResolver,
  encryptSecret,
  parseSecretKey,
  StorageTargetError,
  type S3Config,
  type SharePointConfig,
  type StorageDriver,
  type StorageResolver,
} from '@dmdoc/storage';
import { buildApp } from '../app.js';
import {
  resetDomainTables,
  seedUser,
  startTestDb,
  testConfig,
  TEST_STORAGE_SECRET_KEY_HEX,
  type TestDb,
} from '../test/helpers.js';

/**
 * E2E do storage POR EMPRESA e POR DOCUMENTO (épico E-11 / T-137 + T-150).
 *
 * Diferente dos outros arquivos da suíte, aqui NÃO se injeta um driver único:
 * a app roda com o `createStorageResolver` de verdade, lendo
 * `tenant_storage_configs` do banco de teste. O que é falso são só as fábricas
 * de driver — em vez de abrir socket, elas escrevem num "mundo" em memória com
 * um balde por bucket. Assim dá para afirmar EM QUAL destino cada arquivo caiu,
 * que é exatamente o que a tarefa entrega.
 *
 * A tabela é VERSIONADA (ADR-1): trocar de destino é INSERT de linha nova mais
 * aposentadoria da anterior, e cada documento guarda em `storage_config_id` a
 * configuração com que foi gravado. É isso que faz o acervo antigo continuar
 * legível depois da troca — inclusive quando os dois destinos são do MESMO
 * provider (S3 da plataforma → S3 do cliente), o caso que a comparação por
 * `storage_provider` não enxergaria.
 */

// ---------------------------------------------------------------------------
// Mundo falso de armazenamento
// ---------------------------------------------------------------------------

/** bucket (ou drive do SharePoint) → chave → conteúdo. */
const world = new Map<string, Map<string, Buffer>>();
/** Configurações com que cada driver foi construído, na ordem. */
const builtS3: S3Config[] = [];
const builtSharePoint: SharePointConfig[] = [];

function bucketOf(name: string): Map<string, Buffer> {
  let bucket = world.get(name);
  if (bucket === undefined) {
    bucket = new Map<string, Buffer>();
    world.set(name, bucket);
  }
  return bucket;
}

function keysIn(name: string): string[] {
  return [...(world.get(name)?.keys() ?? [])].sort();
}

function fakeDriver(provider: 's3' | 'sharepoint', destination: string): StorageDriver {
  return {
    provider,
    put: async ({ key, buffer }) => {
      bucketOf(destination).set(key, buffer);
    },
    get: async (key) => {
      const found = world.get(destination)?.get(key);
      if (found === undefined) throw new Error(`objeto inexistente em ${destination}: ${key}`);
      return found;
    },
    getDownloadUrl: async (key) => `https://${destination}.fake/${key}`,
    delete: async (key) => {
      bucketOf(destination).delete(key);
    },
    deletePrefix: async (prefix) => {
      for (const key of keysIn(destination)) {
        if (key.startsWith(prefix)) bucketOf(destination).delete(key);
      }
    },
  };
}

/** Bucket da PLATAFORMA — o `.env`, o destino de quem não tem linha própria. */
const PLATFORM_BUCKET = 'plataforma-dmdoc';
const PLATFORM_S3_CONFIG: S3Config = {
  region: 'us-east-1',
  bucket: PLATFORM_BUCKET,
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin',
  endpoint: 'http://minio:9000',
  forcePathStyle: true,
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_PLATAFORMA = crypto.randomUUID();
const TENANT_PROPRIO = crypto.randomUUID();
const TENANT_SHAREPOINT = crypto.randomUUID();
const ADMIN_PLATAFORMA_ID = crypto.randomUUID();
const ADMIN_PROPRIO_ID = crypto.randomUUID();
const ADMIN_SHAREPOINT_ID = crypto.randomUUID();
const SUPER_ID = crypto.randomUUID();
const DEPT_PLATAFORMA_ID = newId();
const DEPT_PROPRIO_ID = newId();
const DEPT_SHAREPOINT_ID = newId();
const PASSWORD = 'senha-forte-de-teste-123';
const DISK_QUOTA = 10 * 1024 * 1024;

const BUCKET_DO_CLIENTE = 'bucket-do-cliente';
const DRIVE_DO_CLIENTE = 'drive-do-cliente';

let app: FastifyInstance;
let testDb: TestDb;
let storage: StorageResolver;
let tokenPlataforma: string;
let tokenProprio: string;
let tokenSharePoint: string;
let tokenSuper: string;

const secretKey = parseSecretKey(TEST_STORAGE_SECRET_KEY_HEX);

/** Valores aceitos no jsonb `config` — o `sql.json` do postgres.js é tipado. */
type StorageConfigJson = Record<string, string | number | boolean>;

/**
 * Aponta a empresa para um destino NOVO, no modelo versionado da ADR-1:
 * aposenta a configuração ativa (`active = false`, `retired_at = now()`) e
 * INSERE outra linha. Nunca um `UPDATE` dos campos de configuração — os
 * documentos já gravados apontam para a linha antiga e precisam dela para serem
 * lidos. Devolve o id da configuração nova.
 */
async function setStorageConfig(
  tenantId: string,
  provider: 's3' | 'sharepoint',
  credentialsSource: 'platform' | 'tenant',
  config: StorageConfigJson,
  secret: string | null
): Promise<string> {
  return testDb.db.begin(async (tx) => {
    await tx`
      UPDATE tenant_storage_configs
      SET active = false, retired_at = now()
      WHERE tenant_id = ${tenantId} AND active
    `;
    const rows = await tx<Array<{ id: string }>>`
      INSERT INTO tenant_storage_configs (tenant_id, provider, credentials_source, config, encrypted_secret)
      VALUES (
        ${tenantId}, ${provider}, ${credentialsSource},
        ${testDb.db.json(config)},
        ${secret === null ? null : encryptSecret(secret, secretKey)}
      )
      RETURNING id
    `;
    return rows[0]!.id;
  }) as unknown as Promise<string>;
}

/**
 * Devolve a empresa ao S3 da plataforma: aposenta a ativa e NÃO insere nada.
 * Ausência de linha ativa ≡ plataforma — é a mesma decisão da T-140.
 */
async function retireStorageConfig(tenantId: string): Promise<void> {
  await testDb.db`
    UPDATE tenant_storage_configs
    SET active = false, retired_at = now()
    WHERE tenant_id = ${tenantId} AND active
  `;
}

/** Atalho para o destino S3 próprio de uma empresa. */
function s3Config(bucket: string): StorageConfigJson {
  return { region: 'sa-east-1', bucket, accessKeyId: 'AKIA-DO-CLIENTE', forcePathStyle: false };
}

async function login(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return res.json().accessToken as string;
}

function uploadForm(departmentId: string, content: string): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const form = new FormData();
  form.append('file', Buffer.from(content), {
    filename: 'documento.pdf',
    contentType: 'application/pdf',
  });
  form.append('departmentId', departmentId);
  return { payload: form.getBuffer(), headers: form.getHeaders() as Record<string, string> };
}

interface UploadedDoc {
  id: string;
  storageKey: string;
}

async function upload(token: string, departmentId: string, content: string): Promise<UploadedDoc> {
  const { payload, headers } = uploadForm(departmentId, content);
  const res = await app.inject({
    method: 'POST',
    url: '/documents',
    headers: { authorization: `Bearer ${token}`, ...headers },
    payload,
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { id: string; storageKey: string };
  return { id: body.id, storageKey: body.storageKey };
}

interface DocStorageRow {
  storage_provider: string;
  storage_config_id: string | null;
}

/** O par (autoridade, rótulo) gravado no documento. */
async function storageOf(documentId: string): Promise<DocStorageRow> {
  const rows = await testDb.db<DocStorageRow[]>`
    SELECT storage_provider, storage_config_id FROM documents WHERE id = ${documentId}
  `;
  return rows[0]!;
}

async function downloadUrl(token: string, documentId: string): Promise<string> {
  const res = await app.inject({
    method: 'GET',
    url: `/documents/${documentId}/download`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json().url as string;
}

beforeAll(async () => {
  testDb = await startTestDb();
  storage = createStorageResolver({
    sql: testDb.db,
    platformS3Config: PLATFORM_S3_CONFIG,
    secretKey,
    createS3Driver: (config) => {
      builtS3.push(config);
      return fakeDriver('s3', config.bucket);
    },
    createSharePointDriver: (config) => {
      builtSharePoint.push(config);
      return fakeDriver('sharepoint', config.driveId);
    },
  });

  app = await buildApp({
    config: testConfig(),
    db: testDb.db,
    queue: null,
    aiReprocessQueue: null,
    storage,
  });
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(async () => {
  world.clear();
  builtS3.length = 0;
  builtSharePoint.length = 0;
  storage.invalidateAll();

  await resetDomainTables(testDb.db);

  await testDb.db`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
    VALUES
      (${TENANT_PLATAFORMA}, 'Empresa na plataforma', ${DISK_QUOTA}, 20, true, NOW()),
      (${TENANT_PROPRIO}, 'Empresa com bucket proprio', ${DISK_QUOTA}, 20, true, NOW()),
      (${TENANT_SHAREPOINT}, 'Empresa no SharePoint', ${DISK_QUOTA}, 20, true, NOW())
  `;
  await testDb.db`
    INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
    VALUES
      (${DEPT_PLATAFORMA_ID}, ${TENANT_PLATAFORMA}, NULL, 'Financeiro', 0, '{}'::text[], false, NOW()),
      (${DEPT_PROPRIO_ID}, ${TENANT_PROPRIO}, NULL, 'Financeiro', 0, '{}'::text[], false, NOW()),
      (${DEPT_SHAREPOINT_ID}, ${TENANT_SHAREPOINT}, NULL, 'Financeiro', 0, '{}'::text[], false, NOW())
  `;

  await seedUser(testDb.db, {
    id: ADMIN_PLATAFORMA_ID,
    tenantId: TENANT_PLATAFORMA,
    email: 'admin-plataforma@empresa.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
  });
  await seedUser(testDb.db, {
    id: ADMIN_PROPRIO_ID,
    tenantId: TENANT_PROPRIO,
    email: 'admin-proprio@empresa.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
  });
  await seedUser(testDb.db, {
    id: ADMIN_SHAREPOINT_ID,
    tenantId: TENANT_SHAREPOINT,
    email: 'admin-sharepoint@empresa.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
  });
  await seedUser(testDb.db, {
    id: SUPER_ID,
    tenantId: null,
    email: 'super-storage@dmdoc.com',
    password: PASSWORD,
    role: 'SUPER_ADMIN',
  });

  tokenPlataforma = await login('admin-plataforma@empresa.com');
  tokenProprio = await login('admin-proprio@empresa.com');
  tokenSharePoint = await login('admin-sharepoint@empresa.com');
  tokenSuper = await login('super-storage@dmdoc.com');
});

// ---------------------------------------------------------------------------

describe('upload — o destino é o ATIVO da empresa, e fica registrado no documento', () => {
  it('empresa SEM linha em tenant_storage_configs continua no bucket da plataforma', async () => {
    const doc = await upload(tokenPlataforma, DEPT_PLATAFORMA_ID, 'conteudo-plataforma');

    expect(keysIn(PLATFORM_BUCKET)).toEqual([doc.storageKey]);
    expect(builtS3).toEqual([PLATFORM_S3_CONFIG]);
    // `storage_config_id` nulo é a representação da plataforma — nenhum
    // backfill, nenhuma linha sintética.
    expect(await storageOf(doc.id)).toEqual({ storage_provider: 's3', storage_config_id: null });
  });

  it("('s3','tenant') apontando para outro bucket: o arquivo cai no bucket da empresa, não no da plataforma", async () => {
    const configId = await setStorageConfig(
      TENANT_PROPRIO,
      's3',
      'tenant',
      s3Config(BUCKET_DO_CLIENTE),
      'secret-access-key-do-cliente'
    );

    const doc = await upload(tokenProprio, DEPT_PROPRIO_ID, 'conteudo-do-cliente');

    expect(keysIn(BUCKET_DO_CLIENTE)).toEqual([doc.storageKey]);
    expect(keysIn(PLATFORM_BUCKET)).toEqual([]);
    // O documento aponta para a CONFIGURAÇÃO usada, não para "s3" genérico:
    // sem isso, um arquivo em bucket próprio ficaria registrado como plataforma
    // e a migração da T-141 nunca o selecionaria.
    expect(await storageOf(doc.id)).toEqual({
      storage_provider: 's3',
      storage_config_id: configId,
    });
    // O segredo chegou ao driver decifrado — prova que passou pelo AES-GCM.
    expect(builtS3).toEqual([
      {
        region: 'sa-east-1',
        bucket: BUCKET_DO_CLIENTE,
        accessKeyId: 'AKIA-DO-CLIENTE',
        secretAccessKey: 'secret-access-key-do-cliente',
        forcePathStyle: false,
      },
    ]);
  });

  it("('s3','platform') explícito grava no bucket da plataforma e continua legível pela linha", async () => {
    const configId = await setStorageConfig(TENANT_PLATAFORMA, 's3', 'platform', {}, null);

    const doc = await upload(tokenPlataforma, DEPT_PLATAFORMA_ID, 'conteudo-plataforma');

    expect(keysIn(PLATFORM_BUCKET)).toEqual([doc.storageKey]);
    expect(builtS3).toEqual([PLATFORM_S3_CONFIG]);
    expect(await storageOf(doc.id)).toEqual({
      storage_provider: 's3',
      storage_config_id: configId,
    });
    expect(await downloadUrl(tokenPlataforma, doc.id)).toBe(
      `https://${PLATFORM_BUCKET}.fake/${doc.storageKey}`
    );
  });

  it('empresa no SharePoint: o arquivo vai para o drive dela e o documento nasce coerente', async () => {
    const configId = await setStorageConfig(
      TENANT_SHAREPOINT,
      'sharepoint',
      'tenant',
      {
        azureTenantId: 'aad-do-cliente',
        clientId: 'client-id-do-cliente',
        siteId: 'site-do-cliente',
        driveId: DRIVE_DO_CLIENTE,
        rootFolder: 'DMDoc',
      },
      'client-secret-do-cliente'
    );

    const doc = await upload(tokenSharePoint, DEPT_SHAREPOINT_ID, 'conteudo-sharepoint');

    expect(keysIn(DRIVE_DO_CLIENTE)).toEqual([doc.storageKey]);
    expect(keysIn(PLATFORM_BUCKET)).toEqual([]);
    // Autoridade e rótulo coerentes: o CHECK `documents_platform_storage_is_s3`
    // só aceita 'sharepoint' com `storage_config_id` preenchido.
    expect(await storageOf(doc.id)).toEqual({
      storage_provider: 'sharepoint',
      storage_config_id: configId,
    });
    expect(builtSharePoint[0]).toMatchObject({
      driveId: DRIVE_DO_CLIENTE,
      clientSecret: 'client-secret-do-cliente',
      rootFolder: 'DMDoc',
    });
  });

  it('duas empresas com destinos diferentes na MESMA instância não se contaminam', async () => {
    await setStorageConfig(
      TENANT_PROPRIO,
      's3',
      'tenant',
      s3Config(BUCKET_DO_CLIENTE),
      'secret-do-cliente'
    );

    const naPlataforma = await upload(tokenPlataforma, DEPT_PLATAFORMA_ID, 'conteudo-a');
    const noProprio = await upload(tokenProprio, DEPT_PROPRIO_ID, 'conteudo-b');
    // Segunda rodada, alternando a ordem: um cache por empresa não pode
    // "vazar" o driver de quem falou por último.
    const naPlataforma2 = await upload(tokenPlataforma, DEPT_PLATAFORMA_ID, 'conteudo-c');
    const noProprio2 = await upload(tokenProprio, DEPT_PROPRIO_ID, 'conteudo-d');

    expect(keysIn(PLATFORM_BUCKET)).toEqual(
      [naPlataforma.storageKey, naPlataforma2.storageKey].sort()
    );
    expect(keysIn(BUCKET_DO_CLIENTE)).toEqual([noProprio.storageKey, noProprio2.storageKey].sort());
  });
});

describe('cache de driver', () => {
  it('trocar de destino vale no upload seguinte, sem esperar o TTL', async () => {
    await setStorageConfig(TENANT_PROPRIO, 's3', 'tenant', s3Config('bucket-antigo'), 'segredo');
    const antes = await upload(tokenProprio, DEPT_PROPRIO_ID, 'antes-da-troca');
    expect(keysIn('bucket-antigo')).toEqual([antes.storageKey]);

    // Nenhum `invalidate()` aqui de propósito: a configuração nova é uma LINHA
    // nova, com id novo — logo, um miss de cache automático, inclusive quando
    // quem gravou foi outra réplica da API.
    await setStorageConfig(TENANT_PROPRIO, 's3', 'tenant', s3Config('bucket-novo'), 'segredo');

    const depois = await upload(tokenProprio, DEPT_PROPRIO_ID, 'depois-da-troca');

    expect(keysIn('bucket-novo')).toEqual([depois.storageKey]);
    expect(keysIn('bucket-antigo')).toEqual([antes.storageKey]);
  });

  it('voltar para a plataforma (linha aposentada, sem nova) também vale na chamada seguinte', async () => {
    await setStorageConfig(
      TENANT_PROPRIO,
      's3',
      'tenant',
      s3Config(BUCKET_DO_CLIENTE),
      'secret-do-cliente'
    );
    await upload(tokenProprio, DEPT_PROPRIO_ID, 'no-bucket-proprio');

    await retireStorageConfig(TENANT_PROPRIO);
    const depois = await upload(tokenProprio, DEPT_PROPRIO_ID, 'de-volta-a-plataforma');

    expect(keysIn(PLATFORM_BUCKET)).toEqual([depois.storageKey]);
    expect(await storageOf(depois.id)).toMatchObject({ storage_config_id: null });
  });

  it('uploads seguidos da mesma empresa reaproveitam a instância do driver', async () => {
    await setStorageConfig(
      TENANT_PROPRIO,
      's3',
      'tenant',
      s3Config(BUCKET_DO_CLIENTE),
      'secret-do-cliente'
    );

    await upload(tokenProprio, DEPT_PROPRIO_ID, 'um');
    await upload(tokenProprio, DEPT_PROPRIO_ID, 'dois');
    await upload(tokenProprio, DEPT_PROPRIO_ID, 'tres');

    // Um driver construído, três uploads: é o que protege o token OAuth do
    // SharePoint de ser pedido de novo a cada requisição.
    expect(builtS3).toHaveLength(1);
  });
});

describe('leitura e exclusão — cada arquivo no destino da SUA empresa', () => {
  beforeEach(async () => {
    await setStorageConfig(
      TENANT_PROPRIO,
      's3',
      'tenant',
      s3Config(BUCKET_DO_CLIENTE),
      'secret-do-cliente'
    );
  });

  it('a URL de download é assinada pelo destino do documento', async () => {
    const doc = await upload(tokenProprio, DEPT_PROPRIO_ID, 'para-baixar');

    expect(await downloadUrl(tokenProprio, doc.id)).toBe(
      `https://${BUCKET_DO_CLIENTE}.fake/${doc.storageKey}`
    );
  });

  it('SUPER_ADMIN excluindo documento de outra empresa apaga no destino DAQUELA empresa', async () => {
    const naPlataforma = await upload(tokenPlataforma, DEPT_PLATAFORMA_ID, 'da-plataforma');
    const noProprio = await upload(tokenProprio, DEPT_PROPRIO_ID, 'do-cliente');

    const res = await app.inject({
      method: 'DELETE',
      url: `/documents/${noProprio.id}`,
      headers: { authorization: `Bearer ${tokenSuper}` },
    });

    expect(res.statusCode).toBe(204);
    expect(keysIn(BUCKET_DO_CLIENTE)).toEqual([]);
    // O arquivo da outra empresa não foi tocado.
    expect(keysIn(PLATFORM_BUCKET)).toEqual([naPlataforma.storageKey]);
  });

  it('bulk-delete apaga cada documento no destino da sua empresa', async () => {
    const plataforma1 = await upload(tokenPlataforma, DEPT_PLATAFORMA_ID, 'plataforma-1');
    const plataforma2 = await upload(tokenPlataforma, DEPT_PLATAFORMA_ID, 'plataforma-2');
    const proprio1 = await upload(tokenProprio, DEPT_PROPRIO_ID, 'proprio-1');
    const proprio2 = await upload(tokenProprio, DEPT_PROPRIO_ID, 'proprio-2');

    // A rota recusa seleção cross-tenant com 422 (regra anterior a esta
    // tarefa), então o SUPER_ADMIN apaga uma empresa por vez — e cada chamada
    // precisa acertar o destino DAQUELA empresa, não o da anterior.
    const primeira = await app.inject({
      method: 'POST',
      url: '/documents/bulk-delete',
      headers: { authorization: `Bearer ${tokenSuper}` },
      payload: { documentIds: [proprio1.id, proprio2.id] },
    });
    expect(primeira.statusCode).toBe(200);
    expect(keysIn(BUCKET_DO_CLIENTE)).toEqual([]);
    expect(keysIn(PLATFORM_BUCKET)).toEqual(
      [plataforma1.storageKey, plataforma2.storageKey].sort()
    );

    const segunda = await app.inject({
      method: 'POST',
      url: '/documents/bulk-delete',
      headers: { authorization: `Bearer ${tokenSuper}` },
      payload: { documentIds: [plataforma1.id, plataforma2.id] },
    });
    expect(segunda.statusCode).toBe(200);
    expect(keysIn(PLATFORM_BUCKET)).toEqual([]);
  });

  it('seleção cross-tenant continua sendo 422 e não apaga arquivo nenhum', async () => {
    const naPlataforma = await upload(tokenPlataforma, DEPT_PLATAFORMA_ID, 'plataforma');
    const noProprio = await upload(tokenProprio, DEPT_PROPRIO_ID, 'proprio');

    const res = await app.inject({
      method: 'POST',
      url: '/documents/bulk-delete',
      headers: { authorization: `Bearer ${tokenSuper}` },
      payload: { documentIds: [naPlataforma.id, noProprio.id] },
    });

    expect(res.statusCode).toBe(422);
    expect(keysIn(PLATFORM_BUCKET)).toEqual([naPlataforma.storageKey]);
    expect(keysIn(BUCKET_DO_CLIENTE)).toEqual([noProprio.storageKey]);
  });
});

/**
 * O coração da T-150 (e da ADR-1): depois que uma empresa troca de destino, o
 * acervo antigo NÃO se move sozinho. Enquanto a migração da T-141 não roda — ou
 * enquanto roda —, os documentos precisam continuar sendo lidos de onde estão.
 */
describe('acervo em mais de um destino — a leitura segue o DOCUMENTO', () => {
  it('S3 da plataforma → S3 próprio: o documento antigo continua vindo da plataforma', async () => {
    // É o caso que motivou a ADR-1: os dois lados são `storage_provider = 's3'`,
    // então qualquer decisão baseada no provider acertaria o bucket errado sem
    // dar nenhum sinal.
    const antigo = await upload(tokenProprio, DEPT_PROPRIO_ID, 'antes-da-troca');
    expect(await storageOf(antigo.id)).toMatchObject({ storage_config_id: null });

    await setStorageConfig(
      TENANT_PROPRIO,
      's3',
      'tenant',
      s3Config(BUCKET_DO_CLIENTE),
      'secret-do-cliente'
    );
    const novo = await upload(tokenProprio, DEPT_PROPRIO_ID, 'depois-da-troca');

    expect(await downloadUrl(tokenProprio, antigo.id)).toBe(
      `https://${PLATFORM_BUCKET}.fake/${antigo.storageKey}`
    );
    expect(await downloadUrl(tokenProprio, novo.id)).toBe(
      `https://${BUCKET_DO_CLIENTE}.fake/${novo.storageKey}`
    );
  });

  it('bucket próprio A → bucket próprio B: o antigo é baixado da configuração APOSENTADA', async () => {
    const configA = await setStorageConfig(
      TENANT_PROPRIO,
      's3',
      'tenant',
      s3Config('bucket-a'),
      'segredo-a'
    );
    const noA = await upload(tokenProprio, DEPT_PROPRIO_ID, 'gravado-no-a');

    const configB = await setStorageConfig(
      TENANT_PROPRIO,
      's3',
      'tenant',
      s3Config('bucket-b'),
      'segredo-b'
    );
    const noB = await upload(tokenProprio, DEPT_PROPRIO_ID, 'gravado-no-b');

    expect(await storageOf(noA.id)).toMatchObject({ storage_config_id: configA });
    expect(await storageOf(noB.id)).toMatchObject({ storage_config_id: configB });

    // A linha de A está aposentada — e continua servindo leitura.
    const aposentadas = await testDb.db<Array<{ id: string; active: boolean }>>`
      SELECT id, active FROM tenant_storage_configs WHERE id = ${configA}
    `;
    expect(aposentadas[0]).toMatchObject({ active: false });

    expect(await downloadUrl(tokenProprio, noA.id)).toBe(
      `https://bucket-a.fake/${noA.storageKey}`
    );
    expect(await downloadUrl(tokenProprio, noB.id)).toBe(
      `https://bucket-b.fake/${noB.storageKey}`
    );
  });

  it('empresa migrada para o SharePoint: o documento na plataforma continua no S3 do .env', async () => {
    const antigo = await upload(tokenSharePoint, DEPT_SHAREPOINT_ID, 'antes-do-sharepoint');

    await setStorageConfig(
      TENANT_SHAREPOINT,
      'sharepoint',
      'tenant',
      {
        azureTenantId: 'aad',
        clientId: 'client',
        siteId: 'site',
        driveId: DRIVE_DO_CLIENTE,
        rootFolder: 'DMDoc',
      },
      'client-secret'
    );
    const novo = await upload(tokenSharePoint, DEPT_SHAREPOINT_ID, 'depois-do-sharepoint');

    expect(keysIn(PLATFORM_BUCKET)).toEqual([antigo.storageKey]);
    expect(keysIn(DRIVE_DO_CLIENTE)).toEqual([novo.storageKey]);

    expect(await downloadUrl(tokenSharePoint, antigo.id)).toBe(
      `https://${PLATFORM_BUCKET}.fake/${antigo.storageKey}`
    );
    expect(await downloadUrl(tokenSharePoint, novo.id)).toBe(
      `https://${DRIVE_DO_CLIENTE}.fake/${novo.storageKey}`
    );
  });

  it('acervo em TRÊS destinos: todo download funciona, cada um no seu lugar', async () => {
    const naPlataforma = await upload(tokenProprio, DEPT_PROPRIO_ID, 'na-plataforma');
    await setStorageConfig(TENANT_PROPRIO, 's3', 'tenant', s3Config('bucket-a'), 'segredo-a');
    const noA = await upload(tokenProprio, DEPT_PROPRIO_ID, 'no-a');
    await setStorageConfig(TENANT_PROPRIO, 's3', 'tenant', s3Config('bucket-b'), 'segredo-b');
    const noB = await upload(tokenProprio, DEPT_PROPRIO_ID, 'no-b');

    expect(await downloadUrl(tokenProprio, naPlataforma.id)).toBe(
      `https://${PLATFORM_BUCKET}.fake/${naPlataforma.storageKey}`
    );
    expect(await downloadUrl(tokenProprio, noA.id)).toBe(`https://bucket-a.fake/${noA.storageKey}`);
    expect(await downloadUrl(tokenProprio, noB.id)).toBe(`https://bucket-b.fake/${noB.storageKey}`);
  });

  it('DELETE apaga o arquivo no destino ANTIGO, sem tocar no destino atual', async () => {
    const antigo = await upload(tokenProprio, DEPT_PROPRIO_ID, 'na-plataforma');
    await setStorageConfig(
      TENANT_PROPRIO,
      's3',
      'tenant',
      s3Config(BUCKET_DO_CLIENTE),
      'segredo'
    );
    const novo = await upload(tokenProprio, DEPT_PROPRIO_ID, 'no-bucket-do-cliente');

    const res = await app.inject({
      method: 'DELETE',
      url: `/documents/${antigo.id}`,
      headers: { authorization: `Bearer ${tokenProprio}` },
    });

    expect(res.statusCode).toBe(204);
    expect(keysIn(PLATFORM_BUCKET)).toEqual([]);
    expect(keysIn(BUCKET_DO_CLIENTE)).toEqual([novo.storageKey]);
  });

  it('bulk-delete com o mesmo tenant em dois destinos apaga cada arquivo no lugar certo', async () => {
    // Agrupar por tenant (o comportamento anterior) apagaria os dois no destino
    // corrente: um no-op silencioso na origem — arquivo órfão para sempre — e,
    // com chaves iguais em destinos diferentes, um objeto alheio no destino.
    const naPlataforma1 = await upload(tokenProprio, DEPT_PROPRIO_ID, 'plataforma-1');
    const naPlataforma2 = await upload(tokenProprio, DEPT_PROPRIO_ID, 'plataforma-2');

    await setStorageConfig(
      TENANT_PROPRIO,
      's3',
      'tenant',
      s3Config(BUCKET_DO_CLIENTE),
      'segredo'
    );
    const noCliente1 = await upload(tokenProprio, DEPT_PROPRIO_ID, 'cliente-1');
    const noCliente2 = await upload(tokenProprio, DEPT_PROPRIO_ID, 'cliente-2');

    const res = await app.inject({
      method: 'POST',
      url: '/documents/bulk-delete',
      headers: { authorization: `Bearer ${tokenProprio}` },
      payload: {
        documentIds: [naPlataforma1.id, noCliente1.id],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(2);
    // Sobra exatamente um arquivo em CADA destino: o que não foi selecionado.
    expect(keysIn(PLATFORM_BUCKET)).toEqual([naPlataforma2.storageKey]);
    expect(keysIn(BUCKET_DO_CLIENTE)).toEqual([noCliente2.storageKey]);
  });
});

describe('configuração quebrada e isolamento entre empresas', () => {
  it('segredo ilegível derruba o upload daquela empresa — e só dela', async () => {
    await testDb.db`
      INSERT INTO tenant_storage_configs (tenant_id, provider, credentials_source, config, encrypted_secret)
      VALUES (
        ${TENANT_PROPRIO}, 's3', 'tenant',
        ${testDb.db.json(s3Config(BUCKET_DO_CLIENTE))},
        ${encryptSecret('segredo', Buffer.alloc(32, 42))}
      )
    `;

    const { payload, headers } = uploadForm(DEPT_PROPRIO_ID, 'nao-deve-subir');
    const res = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenProprio}`, ...headers },
      payload,
    });

    expect(res.statusCode).toBe(500);
    expect(keysIn(BUCKET_DO_CLIENTE)).toEqual([]);

    // A empresa vizinha continua enviando normalmente.
    const vizinha = await upload(tokenPlataforma, DEPT_PLATAFORMA_ID, 'segue-o-jogo');
    expect(keysIn(PLATFORM_BUCKET)).toEqual([vizinha.storageKey]);
  });

  it('o banco impede um documento apontar para a configuração de OUTRA empresa', async () => {
    // A FK composta (storage_config_id, tenant_id) é a primeira barreira: sem
    // ela, um UPDATE em massa da migração poderia amarrar um documento à
    // configuração alheia — e lê-lo significaria abrir o bucket do vizinho com
    // as credenciais dele.
    const configDoProprio = await setStorageConfig(
      TENANT_PROPRIO,
      's3',
      'tenant',
      s3Config(BUCKET_DO_CLIENTE),
      'segredo'
    );
    const daPlataforma = await upload(tokenPlataforma, DEPT_PLATAFORMA_ID, 'documento-vizinho');

    await expect(
      testDb.db`
        UPDATE documents
        SET storage_config_id = ${configDoProprio}
        WHERE id = ${daPlataforma.id}
      `
    ).rejects.toThrow(/documents_storage_config_fk/);
  });

  it('o resolvedor recusa configuração de outra empresa e id inexistente — nunca cai na plataforma', async () => {
    // Segunda barreira, na aplicação: mesmo que a linha de `documents` fosse
    // forjada por outro caminho, resolver o driver exige `id` E `tenant_id`.
    const configDoProprio = await setStorageConfig(
      TENANT_PROPRIO,
      's3',
      'tenant',
      s3Config(BUCKET_DO_CLIENTE),
      'segredo'
    );

    await expect(
      storage.forStorageConfig(TENANT_PLATAFORMA, configDoProprio)
    ).rejects.toThrow(StorageTargetError);

    await expect(
      storage.forStorageConfig(TENANT_PROPRIO, crypto.randomUUID())
    ).rejects.toThrow(/não existe nesta empresa/);
  });
});

// ---------------------------------------------------------------------------
// Stream pelo backend (T-140 / motivo apurado na T-139)
// ---------------------------------------------------------------------------

describe('GET /documents/:id/raw — stream autenticado pelo backend', () => {
  /** Corpo completo do /download, com os campos que orientam o front. */
  async function downloadBody(
    token: string,
    documentId: string
  ): Promise<{ url: string; provider: string; urlEmbeddable: boolean; rawUrl: string }> {
    const res = await app.inject({
      method: 'GET',
      url: `/documents/${documentId}/download`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it('o /download avisa que a URL do S3 PODE ser embutida, e onde está o stream', async () => {
    const doc = await upload(tokenPlataforma, DEPT_PLATAFORMA_ID, 'conteudo-s3');

    expect(await downloadBody(tokenPlataforma, doc.id)).toMatchObject({
      provider: 's3',
      urlEmbeddable: true,
      rawUrl: `/documents/${doc.id}/raw`,
    });
  });

  it('o /download avisa que a URL do SharePoint NÃO pode ser embutida', async () => {
    // A URL pré-autenticada do Graph não abre em <iframe> — e não é CORS:
    // `Content-Disposition: attachment` no handler `download.aspx` e
    // `X-Frame-Options: SAMEORIGIN` (apurado por rede na T-139). O front tem de
    // trocar para `rawUrl`, e é este campo que diz quando.
    await setStorageConfig(
      TENANT_SHAREPOINT,
      'sharepoint',
      'tenant',
      {
        azureTenantId: 'aad',
        clientId: 'client',
        siteId: 'site',
        driveId: DRIVE_DO_CLIENTE,
        rootFolder: 'DMDoc',
      },
      'client-secret'
    );
    const doc = await upload(tokenSharePoint, DEPT_SHAREPOINT_ID, 'conteudo-sharepoint');

    expect(await downloadBody(tokenSharePoint, doc.id)).toMatchObject({
      provider: 'sharepoint',
      urlEmbeddable: false,
      rawUrl: `/documents/${doc.id}/raw`,
    });
  });

  it('devolve o binário do destino DO documento, inline', async () => {
    await setStorageConfig(
      TENANT_PROPRIO,
      's3',
      'tenant',
      s3Config(BUCKET_DO_CLIENTE),
      'segredo'
    );
    const doc = await upload(tokenProprio, DEPT_PROPRIO_ID, 'conteudo-para-o-visor');

    const res = await app.inject({
      method: 'GET',
      url: `/documents/${doc.id}/raw`,
      headers: { authorization: `Bearer ${tokenProprio}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('inline');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.rawPayload.toString('utf8')).toBe('conteudo-para-o-visor');
  });

  it('?open=true troca a disposição para attachment', async () => {
    const doc = await upload(tokenPlataforma, DEPT_PLATAFORMA_ID, 'conteudo-para-salvar');

    const res = await app.inject({
      method: 'GET',
      url: `/documents/${doc.id}/raw?open=true`,
      headers: { authorization: `Bearer ${tokenPlataforma}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
  });

  it('lê do destino APOSENTADO quando o documento ficou para trás', async () => {
    const antigo = await upload(tokenProprio, DEPT_PROPRIO_ID, 'gravado-na-plataforma');
    await setStorageConfig(
      TENANT_PROPRIO,
      's3',
      'tenant',
      s3Config(BUCKET_DO_CLIENTE),
      'segredo'
    );
    const novo = await upload(tokenProprio, DEPT_PROPRIO_ID, 'gravado-no-bucket-do-cliente');

    const resAntigo = await app.inject({
      method: 'GET',
      url: `/documents/${antigo.id}/raw`,
      headers: { authorization: `Bearer ${tokenProprio}` },
    });
    const resNovo = await app.inject({
      method: 'GET',
      url: `/documents/${novo.id}/raw`,
      headers: { authorization: `Bearer ${tokenProprio}` },
    });

    expect(resAntigo.rawPayload.toString('utf8')).toBe('gravado-na-plataforma');
    expect(resNovo.rawPayload.toString('utf8')).toBe('gravado-no-bucket-do-cliente');
  });

  it('documento de OUTRA empresa é 404 — nunca o binário', async () => {
    await setStorageConfig(
      TENANT_PROPRIO,
      's3',
      'tenant',
      s3Config(BUCKET_DO_CLIENTE),
      'segredo'
    );
    const doDoCliente = await upload(tokenProprio, DEPT_PROPRIO_ID, 'CONTEUDO-CONFIDENCIAL');

    const res = await app.inject({
      method: 'GET',
      url: `/documents/${doDoCliente.id}/raw`,
      headers: { authorization: `Bearer ${tokenPlataforma}` },
    });

    // 404, nunca 403: a resposta não pode nem confirmar que o documento existe.
    expect(res.statusCode).toBe(404);
    expect(res.rawPayload.toString('utf8')).not.toContain('CONTEUDO-CONFIDENCIAL');
  });

  it('sem token é 401 — a rota entrega conteúdo, não uma URL', async () => {
    const doc = await upload(tokenPlataforma, DEPT_PLATAFORMA_ID, 'conteudo-protegido');

    const res = await app.inject({ method: 'GET', url: `/documents/${doc.id}/raw` });

    expect(res.statusCode).toBe(401);
    expect(res.rawPayload.toString('utf8')).not.toContain('conteudo-protegido');
  });
});
