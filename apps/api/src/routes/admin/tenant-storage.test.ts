import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { newId } from '@dmdoc/db-pg';
import {
  createStorageResolver,
  parseSecretKey,
  StorageAuthError,
  StorageNotFoundError,
  type ResolvedStorageTarget,
  type S3Config,
  type StorageDriver,
  type StorageResolver,
} from '@dmdoc/storage';
import { buildApp } from '../../app.js';
import {
  resetDomainTables,
  seedUser,
  startTestDb,
  testConfig,
  TEST_STORAGE_SECRET_KEY_HEX,
  type TestDb,
} from '../../test/helpers.js';

/**
 * E2E da administração do destino de armazenamento por empresa (E-11 / T-140).
 *
 * O que estes testes precisam provar, acima de tudo: **a troca de destino NÃO
 * destrói a configuração anterior**. Documentos já gravados apontam para ela
 * pelo `storage_config_id` e só são legíveis com as credenciais dela — um
 * `UPDATE` da linha (em vez de INSERT + aposentadoria) reintroduziria a perda
 * de dados que a ADR-1 do épico corrigiu, e o sintoma só apareceria semanas
 * depois, quando alguém tentasse abrir um arquivo antigo.
 *
 * A app roda com o `createStorageResolver` DE VERDADE, lendo
 * `tenant_storage_configs`; só as fábricas de driver são falsas (um balde em
 * memória por bucket). Assim dá para afirmar de qual destino cada arquivo é
 * lido — inclusive no caso S3→S3, em que `storage_provider` não distingue nada.
 */

// ---------------------------------------------------------------------------
// Mundo falso de armazenamento (o que o resolver da app usa)
// ---------------------------------------------------------------------------

/** destino (bucket ou drive) → chave → conteúdo. */
const world = new Map<string, Map<string, Buffer>>();

function bucketOf(name: string): Map<string, Buffer> {
  let bucket = world.get(name);
  if (bucket === undefined) {
    bucket = new Map<string, Buffer>();
    world.set(name, bucket);
  }
  return bucket;
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
      for (const key of [...(world.get(destination)?.keys() ?? [])]) {
        if (key.startsWith(prefix)) bucketOf(destination).delete(key);
      }
    },
  };
}

const PLATFORM_BUCKET = 'plataforma-dmdoc';
const PLATFORM_S3_CONFIG: S3Config = {
  region: 'us-east-1',
  bucket: PLATFORM_BUCKET,
  accessKeyId: 'test-key-id',
  secretAccessKey: 'test-secret-key',
  forcePathStyle: false,
};

// ---------------------------------------------------------------------------
// Driver do "Testar conexão" — programável, para exercitar cada falha
// ---------------------------------------------------------------------------

type TestDriverBehavior =
  | 'ok'
  | 'credencial-sharepoint'
  | 'permissao-sharepoint'
  | 'destino-sharepoint'
  | 'credencial-s3'
  | 'permissao-s3'
  | 'conteudo-diferente'
  | 'falha-ambigua-apos-gravar'
  | 'falha-na-limpeza';

let testDriverBehavior: TestDriverBehavior = 'ok';
/** O que o "Testar conexão" gravou e ainda não apagou. */
const connectionTestWorld = new Map<string, Buffer>();
/** Chaves que o "Testar conexão" TENTOU remover — inclusive sem sucesso. */
const connectionTestDeletes: string[] = [];
/** Alvos com que o driver do teste de conexão foi construído, na ordem. */
const testTargets: ResolvedStorageTarget[] = [];

/** Erro cru do `@aws-sdk/client-s3` — o `S3Driver` não os embrulha. */
function awsError(name: string, httpStatusCode: number): Error {
  return Object.assign(new Error(`${name}: erro do provedor`), {
    name,
    $metadata: { httpStatusCode },
  });
}

function connectionTestDriver(target: ResolvedStorageTarget): StorageDriver {
  testTargets.push(target);
  const provider = target.provider;

  return {
    provider,
    put: async ({ key, buffer }) => {
      switch (testDriverBehavior) {
        case 'credencial-sharepoint':
          throw new StorageAuthError('Entra ID recusou as credenciais da empresa (HTTP 401)', {
            provider: 'sharepoint',
            operation: 'put',
            status: 401,
            providerCode: 'invalid_client',
          });
        case 'permissao-sharepoint':
          throw new StorageAuthError('SharePoint recusou a credencial (HTTP 403)', {
            provider: 'sharepoint',
            operation: 'put',
            status: 403,
            providerCode: 'accessDenied',
          });
        case 'destino-sharepoint':
          throw new StorageNotFoundError('SharePoint não encontrou o recurso (HTTP 404)', {
            provider: 'sharepoint',
            operation: 'put',
            status: 404,
          });
        case 'credencial-s3':
          throw awsError('InvalidAccessKeyId', 403);
        case 'permissao-s3':
          throw awsError('AccessDenied', 403);
        case 'falha-ambigua-apos-gravar':
          // O objeto chegou ao destino e a RESPOSTA se perdeu — o caso que
          // deixaria resíduo se a limpeza só olhasse para o `put` bem-sucedido.
          connectionTestWorld.set(key, buffer);
          throw new Error('socket hang up');
        default:
          connectionTestWorld.set(key, buffer);
      }
    },
    get: async (key) => {
      if (testDriverBehavior === 'conteudo-diferente') return Buffer.from('conteudo trocado');
      const found = connectionTestWorld.get(key);
      if (found === undefined) throw new Error(`objeto inexistente: ${key}`);
      return found;
    },
    getDownloadUrl: async (key) => `https://teste.fake/${key}`,
    delete: async (key) => {
      connectionTestDeletes.push(key);
      if (testDriverBehavior === 'falha-na-limpeza') throw new Error('delete falhou');
      connectionTestWorld.delete(key);
    },
    deletePrefix: async () => undefined,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();
const SUPER_ID = crypto.randomUUID();
const ADMIN_A_ID = crypto.randomUUID();
const ADMIN_B_ID = crypto.randomUUID();
const DEPT_A_ID = newId();
const PASSWORD = 'senha-forte-de-teste-123';

const BUCKET_A = 'bucket-do-cliente-a';
const BUCKET_B = 'bucket-do-cliente-b';
const DRIVE_DO_CLIENTE = 'drive-do-cliente';

const SECRET_DO_CLIENTE = 'secret-access-key-do-cliente-a';

let app: FastifyInstance;
let testDb: TestDb;
let storage: StorageResolver;
let tokenSuper: string;
let tokenAdminA: string;
let tokenAdminB: string;

const secretKey = parseSecretKey(TEST_STORAGE_SECRET_KEY_HEX);

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

interface StorageConfigDbRow {
  id: string;
  provider: string;
  credentials_source: string;
  config: unknown;
  encrypted_secret: string | null;
  active: boolean;
  retired_at: Date | null;
  created_at: Date;
}

async function storageRows(tenantId: string): Promise<StorageConfigDbRow[]> {
  return testDb.db<StorageConfigDbRow[]>`
    SELECT id, provider, credentials_source, config, encrypted_secret, active, retired_at, created_at
    FROM tenant_storage_configs
    WHERE tenant_id = ${tenantId}
    ORDER BY created_at ASC, id ASC
  `;
}

async function getStorage(tenantId: string, token = tokenSuper) {
  return app.inject({
    method: 'GET',
    url: `/admin/tenants/${tenantId}/storage`,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function putStorage(tenantId: string, payload: unknown, token = tokenSuper) {
  return app.inject({
    method: 'PUT',
    url: `/admin/tenants/${tenantId}/storage`,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as Record<string, unknown>,
  });
}

async function testConnection(tenantId: string, payload: unknown, token = tokenSuper) {
  return app.inject({
    method: 'POST',
    url: `/admin/tenants/${tenantId}/storage/test`,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as Record<string, unknown>,
  });
}

/** Configuração de bucket próprio, o corpo que a tela envia. */
function s3TenantBody(bucket: string, overrides: Record<string, unknown> = {}) {
  return {
    provider: 's3',
    credentialsSource: 'tenant',
    region: 'sa-east-1',
    bucket,
    accessKeyId: 'AKIA-DO-CLIENTE',
    secretAccessKey: SECRET_DO_CLIENTE,
    forcePathStyle: false,
    ...overrides,
  };
}

function sharePointBody(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'sharepoint',
    azureTenantId: 'azure-tenant-do-cliente',
    clientId: 'client-id-do-cliente',
    clientSecret: 'client-secret-do-cliente',
    siteId: 'site-do-cliente',
    driveId: DRIVE_DO_CLIENTE,
    rootFolder: 'DMDoc',
    ...overrides,
  };
}

/**
 * Insere um documento já "gravado" no destino informado: linha em `documents`
 * apontando para a configuração e o arquivo dentro do balde correspondente.
 */
async function seedDocument(params: {
  tenantId: string;
  storageConfigId: string | null;
  destination: string;
  provider?: 's3' | 'sharepoint';
}): Promise<{ id: string; storageKey: string }> {
  const id = newId();
  const contentHash = crypto.randomBytes(32).toString('hex');
  const storageKey = `tenants/${params.tenantId}/documents/${contentHash}/arquivo.pdf`;

  await testDb.db`
    INSERT INTO documents (
      id, tenant_id, department_id, filename, original_filename, content_hash,
      size_bytes, mime_type, storage_key, storage_provider, storage_config_id,
      status, uploaded_by_id, uploaded_at, deleted
    ) VALUES (
      ${id}, ${params.tenantId}, ${DEPT_A_ID}, 'arquivo.pdf', 'arquivo.pdf', ${contentHash},
      ${1024}, 'application/pdf', ${storageKey}, ${params.provider ?? 's3'}, ${params.storageConfigId},
      'READY', ${ADMIN_A_ID}, NOW(), false
    )
  `;

  bucketOf(params.destination).set(storageKey, Buffer.from('conteudo do documento'));
  return { id, storageKey };
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

// ---------------------------------------------------------------------------

beforeAll(async () => {
  testDb = await startTestDb();
  storage = createStorageResolver({
    sql: testDb.db,
    platformS3Config: PLATFORM_S3_CONFIG,
    secretKey,
    createS3Driver: (config) => fakeDriver('s3', config.bucket),
    createSharePointDriver: (config) => fakeDriver('sharepoint', config.driveId),
  });

  app = await buildApp({
    config: testConfig(),
    db: testDb.db,
    queue: null,
    aiReprocessQueue: null,
    storage,
    buildStorageDriver: connectionTestDriver,
  });
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(async () => {
  world.clear();
  connectionTestWorld.clear();
  connectionTestDeletes.length = 0;
  testTargets.length = 0;
  testDriverBehavior = 'ok';
  storage.invalidateAll();

  await resetDomainTables(testDb.db);

  await testDb.db`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
    VALUES
      (${TENANT_A}, 'Empresa A', ${10 * 1024 * 1024}, 20, true, NOW()),
      (${TENANT_B}, 'Empresa B', ${10 * 1024 * 1024}, 20, true, NOW())
  `;
  await testDb.db`
    INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
    VALUES (${DEPT_A_ID}, ${TENANT_A}, NULL, 'Financeiro', 0, '{}'::text[], false, NOW())
  `;

  await seedUser(testDb.db, {
    id: SUPER_ID,
    tenantId: null,
    email: 'super-storage-admin@dmdoc.com',
    password: PASSWORD,
    role: 'SUPER_ADMIN',
  });
  await seedUser(testDb.db, {
    id: ADMIN_A_ID,
    tenantId: TENANT_A,
    email: 'admin-a-storage@empresa.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
  });
  await seedUser(testDb.db, {
    id: ADMIN_B_ID,
    tenantId: TENANT_B,
    email: 'admin-b-storage@empresa.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
  });

  tokenSuper = await login('super-storage-admin@dmdoc.com');
  tokenAdminA = await login('admin-a-storage@empresa.com');
  tokenAdminB = await login('admin-b-storage@empresa.com');
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

describe('GET /admin/tenants/:id/storage', () => {
  it('empresa sem configuração responde o DEFAULT da plataforma, não 404', async () => {
    const res = await getStorage(TENANT_A);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      storageConfigId: null,
      provider: 's3',
      credentialsSource: 'platform',
      config: {},
      secretConfigured: false,
      previousDestinations: [],
    });
  });

  it('empresa inexistente é 404 — id inventado não responde o default', async () => {
    const res = await getStorage(crypto.randomUUID());
    expect(res.statusCode).toBe(404);
  });

  it('nunca devolve o segredo, em nenhum formato — só secretConfigured', async () => {
    expect((await putStorage(TENANT_A, s3TenantBody(BUCKET_A))).statusCode).toBe(200);

    const res = await getStorage(TENANT_A);
    expect(res.statusCode).toBe(200);

    const body = res.json() as Record<string, unknown>;
    expect(body['secretConfigured']).toBe(true);
    expect(body['config']).toEqual({
      region: 'sa-east-1',
      bucket: BUCKET_A,
      accessKeyId: 'AKIA-DO-CLIENTE',
      forcePathStyle: false,
    });

    // Varredura do corpo INTEIRO: nem o segredo em claro, nem o texto cifrado,
    // nem um campo com nome de segredo podem aparecer.
    const raw = res.body;
    expect(raw).not.toContain(SECRET_DO_CLIENTE);
    expect(raw).not.toContain('secretAccessKey');
    expect(raw).not.toContain('encrypted_secret');
    const [stored] = await storageRows(TENANT_A);
    expect(raw).not.toContain(stored!.encrypted_secret);
  });

  it('previousDestinations conta os documentos parados no destino aposentado e no da plataforma', async () => {
    // Um documento do tempo da plataforma (`storage_config_id IS NULL`).
    await seedDocument({ tenantId: TENANT_A, storageConfigId: null, destination: PLATFORM_BUCKET });

    // Empresa vai para o bucket próprio A; um documento nasce lá.
    expect((await putStorage(TENANT_A, s3TenantBody(BUCKET_A))).statusCode).toBe(200);
    const configA = (await storageRows(TENANT_A))[0]!.id;
    await seedDocument({ tenantId: TENANT_A, storageConfigId: configA, destination: BUCKET_A });

    // ... e depois para o bucket B. Agora existem arquivos em três destinos.
    expect((await putStorage(TENANT_A, s3TenantBody(BUCKET_B))).statusCode).toBe(200);

    const body = (await getStorage(TENANT_A)).json() as {
      previousDestinations: Array<{ id: string | null; documentCount: number; config: unknown }>;
    };

    expect(body.previousDestinations).toHaveLength(2);
    const porId = new Map(body.previousDestinations.map((d) => [d.id, d]));
    expect(porId.get(configA)?.documentCount).toBe(1);
    expect(porId.get(configA)?.config).toMatchObject({ bucket: BUCKET_A });
    // O acervo da plataforma entra sob o rótulo dela, com `id: null`.
    expect(porId.get(null)?.documentCount).toBe(1);
  });

  it('destino aposentado SEM documentos não aparece na lista', async () => {
    expect((await putStorage(TENANT_A, s3TenantBody(BUCKET_A))).statusCode).toBe(200);
    expect((await putStorage(TENANT_A, s3TenantBody(BUCKET_B))).statusCode).toBe(200);

    const body = (await getStorage(TENANT_A)).json() as {
      previousDestinations: unknown[];
    };
    expect(body.previousDestinations).toEqual([]);
  });

  it('enquanto a empresa está NA plataforma, o acervo dela não é listado como destino anterior', async () => {
    await seedDocument({ tenantId: TENANT_A, storageConfigId: null, destination: PLATFORM_BUCKET });

    const body = (await getStorage(TENANT_A)).json() as { previousDestinations: unknown[] };
    expect(body.previousDestinations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PUT — versionamento
// ---------------------------------------------------------------------------

describe('PUT /admin/tenants/:id/storage', () => {
  it('grava a configuração cifrada e devolve o estado novo', async () => {
    const res = await putStorage(TENANT_A, s3TenantBody(BUCKET_A));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      provider: 's3',
      credentialsSource: 'tenant',
      secretConfigured: true,
      config: { bucket: BUCKET_A },
    });

    const rows = await storageRows(TENANT_A);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.active).toBe(true);
    expect(row.retired_at).toBeNull();

    // O segredo NÃO é legível num SELECT — está cifrado (AES-256-GCM, T-135).
    expect(row.encrypted_secret).not.toBeNull();
    expect(row.encrypted_secret).not.toContain(SECRET_DO_CLIENTE);
    expect(row.encrypted_secret!.startsWith('v1:')).toBe(true);

    // jsonb gravado com `sql.json(...)`: volta como OBJETO. Se tivesse sido
    // gravado com JSON.stringify, o postgres.js re-serializaria e a leitura
    // devolveria uma STRING double-encoded.
    expect(typeof row.config).toBe('object');
    expect(row.config).toEqual({
      region: 'sa-east-1',
      bucket: BUCKET_A,
      accessKeyId: 'AKIA-DO-CLIENTE',
      forcePathStyle: false,
    });
  });

  it('a troca APOSENTA a linha antiga e insere uma nova — nunca sobrescreve', async () => {
    expect((await putStorage(TENANT_A, s3TenantBody(BUCKET_A))).statusCode).toBe(200);
    const antiga = (await storageRows(TENANT_A))[0]!;

    expect((await putStorage(TENANT_A, s3TenantBody(BUCKET_B))).statusCode).toBe(200);

    const rows = await storageRows(TENANT_A);
    expect(rows).toHaveLength(2);

    const aposentada = rows.find((r) => r.id === antiga.id)!;
    expect(aposentada.active).toBe(false);
    expect(aposentada.retired_at).not.toBeNull();
    // Os campos de configuração continuam INTACTOS: é com eles que os
    // documentos que ficaram no bucket A ainda são lidos.
    expect(aposentada.config).toEqual(antiga.config);
    expect(aposentada.encrypted_secret).toBe(antiga.encrypted_secret);

    const nova = rows.find((r) => r.id !== antiga.id)!;
    expect(nova.active).toBe(true);
    expect(nova.retired_at).toBeNull();
    expect(nova.config).toMatchObject({ bucket: BUCKET_B });
  });

  it('TESTE-CHAVE: documento gravado ANTES da troca continua sendo lido do destino antigo', async () => {
    expect((await putStorage(TENANT_A, s3TenantBody(BUCKET_A))).statusCode).toBe(200);
    const configA = (await storageRows(TENANT_A))[0]!.id;

    const doc = await seedDocument({
      tenantId: TENANT_A,
      storageConfigId: configA,
      destination: BUCKET_A,
    });

    // A empresa troca para o bucket B.
    expect((await putStorage(TENANT_A, s3TenantBody(BUCKET_B))).statusCode).toBe(200);

    // O documento antigo continua apontando para a configuração A...
    const docRows = await testDb.db<Array<{ storage_config_id: string | null }>>`
      SELECT storage_config_id FROM documents WHERE id = ${doc.id}
    `;
    expect(docRows[0]!.storage_config_id).toBe(configA);

    // ... e o download resolve o driver DELE, não o corrente da empresa.
    const res = await app.inject({
      method: 'GET',
      url: `/documents/${doc.id}/download`,
      headers: { authorization: `Bearer ${tokenSuper}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toBe(`https://${BUCKET_A}.fake/${doc.storageKey}`);

    // Enquanto o destino de ESCRITA já é o bucket B.
    const destino = await storage.activeDestination(TENANT_A);
    expect(await destino.driver.getDownloadUrl('x', { expiresInSeconds: 60, audience: 'browser' })).toBe(
      `https://${BUCKET_B}.fake/x`
    );
  });

  it('voltar para o S3 da plataforma aposenta a ativa e NÃO insere linha nenhuma', async () => {
    expect((await putStorage(TENANT_A, s3TenantBody(BUCKET_A))).statusCode).toBe(200);
    const configA = (await storageRows(TENANT_A))[0]!.id;
    await seedDocument({ tenantId: TENANT_A, storageConfigId: configA, destination: BUCKET_A });

    const res = await putStorage(TENANT_A, { provider: 's3', credentialsSource: 'platform' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      storageConfigId: null,
      provider: 's3',
      credentialsSource: 'platform',
      secretConfigured: false,
    });

    const rows = await storageRows(TENANT_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.active).toBe(false);
    expect(rows[0]!.retired_at).not.toBeNull();

    // O destino aposentado continua listado — ainda tem um arquivo lá.
    const body = (await getStorage(TENANT_A)).json() as {
      previousDestinations: Array<{ id: string | null; documentCount: number }>;
    };
    expect(body.previousDestinations).toEqual([
      expect.objectContaining({ id: configA, documentCount: 1 }),
    ]);
  });

  it('configuração idêntica à ativa não versiona (idempotente)', async () => {
    expect((await putStorage(TENANT_A, s3TenantBody(BUCKET_A))).statusCode).toBe(200);
    const primeira = (await storageRows(TENANT_A))[0]!;

    // Mesmo corpo, mas SEM o segredo — é o que a tela reenvia depois de um GET.
    const res = await putStorage(
      TENANT_A,
      s3TenantBody(BUCKET_A, { secretAccessKey: undefined })
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ storageConfigId: primeira.id });

    const rows = await storageRows(TENANT_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(primeira.id);
    expect(rows[0]!.active).toBe(true);
  });

  it('a ordem das chaves do jsonb não conta como diferença', async () => {
    expect((await putStorage(TENANT_A, s3TenantBody(BUCKET_A))).statusCode).toBe(200);

    const res = await putStorage(TENANT_A, {
      forcePathStyle: false,
      accessKeyId: 'AKIA-DO-CLIENTE',
      bucket: BUCKET_A,
      region: 'sa-east-1',
      credentialsSource: 'tenant',
      provider: 's3',
    });
    expect(res.statusCode).toBe(200);
    expect(await storageRows(TENANT_A)).toHaveLength(1);
  });

  it('"já está na plataforma" + PUT de plataforma não cria nem aposenta nada', async () => {
    const res = await putStorage(TENANT_A, { provider: 's3', credentialsSource: 'platform' });
    expect(res.statusCode).toBe(200);
    expect(await storageRows(TENANT_A)).toHaveLength(0);
  });

  it('segredo OMITIDO preserva o já gravado — o texto cifrado é copiado, não regerado', async () => {
    expect((await putStorage(TENANT_A, s3TenantBody(BUCKET_A))).statusCode).toBe(200);
    const antiga = (await storageRows(TENANT_A))[0]!;

    const res = await putStorage(
      TENANT_A,
      s3TenantBody(BUCKET_B, { secretAccessKey: undefined })
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ secretConfigured: true, config: { bucket: BUCKET_B } });

    const nova = (await storageRows(TENANT_A)).find((r) => r.active)!;
    expect(nova.id).not.toBe(antiga.id);
    // Byte a byte o MESMO texto cifrado: copiado da linha aposentada, sem
    // decifrar e sem recifrar (o IV é aleatório — recifrar mudaria o valor).
    expect(nova.encrypted_secret).toBe(antiga.encrypted_secret);

    // E o destino novo funciona: o segredo preservado decifra.
    const destino = await storage.activeDestination(TENANT_A);
    expect(destino.storageConfigId).toBe(nova.id);
    expect(await destino.driver.getDownloadUrl('k', { expiresInSeconds: 60, audience: 'browser' })).toBe(
      `https://${BUCKET_B}.fake/k`
    );
  });

  it('segredo como STRING VAZIA é recusado (422), nunca apaga o gravado', async () => {
    expect((await putStorage(TENANT_A, s3TenantBody(BUCKET_A))).statusCode).toBe(200);

    const res = await putStorage(TENANT_A, s3TenantBody(BUCKET_B, { secretAccessKey: '' }));
    expect(res.statusCode).toBe(422);

    const rows = await storageRows(TENANT_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.config).toMatchObject({ bucket: BUCKET_A });
  });

  it('segredo omitido SEM nada compatível para copiar é 422', async () => {
    // Empresa na plataforma: não há `encrypted_secret` para preservar.
    const res = await putStorage(TENANT_A, s3TenantBody(BUCKET_A, { secretAccessKey: undefined }));
    expect(res.statusCode).toBe(422);
    expect(await storageRows(TENANT_A)).toHaveLength(0);
  });

  it('trocar de provider sem informar o segredo novo é 422 — não copia o segredo do S3 para o SharePoint', async () => {
    expect((await putStorage(TENANT_A, s3TenantBody(BUCKET_A))).statusCode).toBe(200);

    const res = await putStorage(TENANT_A, sharePointBody({ clientSecret: undefined }));
    expect(res.statusCode).toBe(422);
    expect(await storageRows(TENANT_A)).toHaveLength(1);
  });

  it("('sharepoint','platform') é recusado pelo Zod (422), antes do CHECK do banco", async () => {
    const res = await putStorage(TENANT_A, sharePointBody({ credentialsSource: 'platform' }));

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(await storageRows(TENANT_A)).toHaveLength(0);
  });

  it('bucket próprio sem campo obrigatório é 422 apontando o campo', async () => {
    const res = await putStorage(TENANT_A, s3TenantBody(BUCKET_A, { bucket: undefined }));

    expect(res.statusCode).toBe(422);
    const detalhes = JSON.stringify(res.json().error.details);
    expect(detalhes).toContain('bucket');
  });

  it('SharePoint grava o jsonb sem o segredo e o destino passa a valer', async () => {
    const res = await putStorage(TENANT_A, sharePointBody());
    expect(res.statusCode).toBe(200);

    const row = (await storageRows(TENANT_A))[0]!;
    expect(row.provider).toBe('sharepoint');
    expect(row.credentials_source).toBe('tenant');
    expect(row.config).toEqual({
      azureTenantId: 'azure-tenant-do-cliente',
      clientId: 'client-id-do-cliente',
      siteId: 'site-do-cliente',
      driveId: DRIVE_DO_CLIENTE,
      rootFolder: 'DMDoc',
    });
    expect(JSON.stringify(row.config)).not.toContain('client-secret-do-cliente');

    const destino = await storage.activeDestination(TENANT_A);
    expect(destino.driver.provider).toBe('sharepoint');
    expect(await destino.driver.getDownloadUrl('k', { expiresInSeconds: 60, audience: 'browser' })).toBe(
      `https://${DRIVE_DO_CLIENTE}.fake/k`
    );
  });

  it('empresa inexistente é 404 e não grava nada', async () => {
    const fantasma = crypto.randomUUID();
    const res = await putStorage(fantasma, s3TenantBody(BUCKET_A));
    expect(res.statusCode).toBe(404);
    expect(await storageRows(fantasma)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

describe('audit log da troca de destino', () => {
  it('registra tenant.storage.update com os ids das configurações e o segredo MASCARADO', async () => {
    expect((await putStorage(TENANT_A, s3TenantBody(BUCKET_A))).statusCode).toBe(200);
    const configA = (await storageRows(TENANT_A))[0]!.id;

    expect((await putStorage(TENANT_A, s3TenantBody(BUCKET_B))).statusCode).toBe(200);
    const configB = (await storageRows(TENANT_A)).find((r) => r.active)!.id;

    const logs = await testDb.db<Array<{ action: string; metadata: string; user_id: string | null }>>`
      SELECT action, metadata, user_id
      FROM audit_logs
      WHERE tenant_id = ${TENANT_A} AND action = 'tenant.storage.update'
      ORDER BY created_at ASC
    `;
    expect(logs).toHaveLength(2);

    // `audit_logs.metadata` é gravado com JSON.stringify (defeito conhecido —
    // T-149) e volta como STRING deste cliente; o parse aqui espelha o que a
    // rota GET /audit-logs já faz.
    const segundo = JSON.parse(logs[1]!.metadata) as Record<string, unknown>;
    expect(logs[1]!.user_id).toBe(SUPER_ID);
    expect(segundo['retiredStorageConfigId']).toBe(configA);
    expect(segundo['newStorageConfigId']).toBe(configB);
    expect(segundo['secretChanged']).toBe(true);
    expect(segundo['changes']).toMatchObject({
      provider: { before: 's3', after: 's3' },
      credentialsSource: { before: 'tenant', after: 'tenant' },
      config: { before: { bucket: BUCKET_A }, after: { bucket: BUCKET_B } },
    });

    // Nem o segredo em claro nem o texto cifrado entram no audit log — gravar
    // segredo de cliente num registro que gente lê anula a criptografia.
    expect(logs[1]!.metadata).not.toContain(SECRET_DO_CLIENTE);
    expect(logs[1]!.metadata).not.toContain('v1:');
  });

  it('PUT idempotente não registra audit log nem versiona', async () => {
    expect((await putStorage(TENANT_A, s3TenantBody(BUCKET_A))).statusCode).toBe(200);
    expect(
      (await putStorage(TENANT_A, s3TenantBody(BUCKET_A, { secretAccessKey: undefined })))
        .statusCode
    ).toBe(200);

    const logs = await testDb.db<Array<{ count: string }>>`
      SELECT COUNT(*)::int AS count FROM audit_logs
      WHERE tenant_id = ${TENANT_A} AND action = 'tenant.storage.update'
    `;
    expect(Number(logs[0]!.count)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Teste de conexão
// ---------------------------------------------------------------------------

describe('POST /admin/tenants/:id/storage/test', () => {
  it('sucesso: grava, lê, apaga e não deixa o arquivo de teste para trás', async () => {
    const res = await testConnection(TENANT_A, s3TenantBody(BUCKET_A));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, provider: 's3' });
    expect(connectionTestWorld.size).toBe(0);

    // A configuração testada é a DO CORPO, e nada foi gravado no banco.
    expect(testTargets).toEqual([
      {
        provider: 's3',
        credentialsSource: 'tenant',
        config: {
          region: 'sa-east-1',
          bucket: BUCKET_A,
          accessKeyId: 'AKIA-DO-CLIENTE',
          secretAccessKey: SECRET_DO_CLIENTE,
          forcePathStyle: false,
        },
      },
    ]);
    expect(await storageRows(TENANT_A)).toHaveLength(0);
  });

  it('a chave do arquivo de teste é escopada na empresa e fora de documents/', async () => {
    testDriverBehavior = 'falha-na-limpeza';
    const res = await testConnection(TENANT_A, s3TenantBody(BUCKET_A));

    // A limpeza falhou, mas o teste em si foi bem-sucedido — a falha da
    // remoção é best-effort e só vai para o log.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect([...connectionTestWorld.keys()]).toEqual([`tenants/${TENANT_A}/.dmdoc-connection-test`]);
  });

  it('"S3 da plataforma" também é testável', async () => {
    const res = await testConnection(TENANT_A, { provider: 's3', credentialsSource: 'platform' });

    expect(res.json()).toMatchObject({ ok: true, provider: 's3' });
    expect(testTargets).toEqual([{ provider: 's3', credentialsSource: 'platform' }]);
  });

  it('usa o segredo já gravado quando o corpo o omite', async () => {
    expect((await putStorage(TENANT_A, s3TenantBody(BUCKET_A))).statusCode).toBe(200);

    const res = await testConnection(
      TENANT_A,
      s3TenantBody(BUCKET_A, { secretAccessKey: undefined })
    );

    expect(res.json()).toMatchObject({ ok: true });
    // Decifrou o `encrypted_secret` da linha ativa — o segredo chegou ao driver.
    expect(testTargets[0]).toMatchObject({
      config: { secretAccessKey: SECRET_DO_CLIENTE },
    });
  });

  it('credencial inválida do SharePoint: mensagem de credencial, sem stack trace', async () => {
    testDriverBehavior = 'credencial-sharepoint';
    const res = await testConnection(TENANT_A, sharePointBody());

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; code: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe('INVALID_CREDENTIALS');
    expect(body.message).toContain('clientSecret');
    expect(res.body).not.toContain('at Object');
  });

  it('permissão faltando é mensagem DIFERENTE da de credencial', async () => {
    testDriverBehavior = 'permissao-sharepoint';
    const res = await testConnection(TENANT_A, sharePointBody());

    const body = res.json() as { code: string; message: string };
    expect(body.code).toBe('PERMISSION_DENIED');
    expect(body.message).toContain('Sites.ReadWrite.All');
  });

  it('site/drive inexistente é mensagem DIFERENTE das duas anteriores', async () => {
    testDriverBehavior = 'destino-sharepoint';
    const res = await testConnection(TENANT_A, sharePointBody());

    const body = res.json() as { code: string; message: string };
    expect(body.code).toBe('DESTINATION_NOT_FOUND');
    expect(body.message).toContain('driveId');
  });

  it('erro cru do SDK S3 é traduzido: credencial e permissão em códigos distintos', async () => {
    testDriverBehavior = 'credencial-s3';
    const credencial = (await testConnection(TENANT_A, s3TenantBody(BUCKET_A))).json() as {
      code: string;
      message: string;
    };
    expect(credencial.code).toBe('INVALID_CREDENTIALS');
    expect(credencial.message).toContain('InvalidAccessKeyId');

    testDriverBehavior = 'permissao-s3';
    const permissao = (await testConnection(TENANT_A, s3TenantBody(BUCKET_A))).json() as {
      code: string;
    };
    expect(permissao.code).toBe('PERMISSION_DENIED');
  });

  it('destino que devolve conteúdo diferente do gravado não passa no teste', async () => {
    testDriverBehavior = 'conteudo-diferente';
    const res = await testConnection(TENANT_A, s3TenantBody(BUCKET_A));

    expect(res.json()).toMatchObject({ ok: false, code: 'CONTENT_MISMATCH' });
    // O arquivo de teste foi removido mesmo com a verificação falhando.
    expect(connectionTestWorld.size).toBe(0);
  });

  it('falha AMBÍGUA depois de o objeto chegar ao destino também é limpa', async () => {
    // `put` que grava e só então perde a conexão: o provedor tem o arquivo, a
    // API não sabe. Limpar só quando o `put` VOLTOU deixaria o resíduo na
    // biblioteca do cliente — e ninguém o ligaria a este endpoint depois.
    testDriverBehavior = 'falha-ambigua-apos-gravar';
    const res = await testConnection(TENANT_A, s3TenantBody(BUCKET_A));

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; code: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe('UNKNOWN');
    expect(body.message).toContain('socket hang up');
    expect(res.body).not.toContain('at Object');
    expect(connectionTestDeletes).toEqual([`tenants/${TENANT_A}/.dmdoc-connection-test`]);
    expect(connectionTestWorld.size).toBe(0);
  });

  it('credencial recusada não tenta remoção especulativa — o provedor não chegou a gravar', async () => {
    // O contrapeso do teste acima: 401/403/404 acontecem ANTES da gravação, e
    // um `delete` ali só produziria um segundo erro idêntico no log, no caminho
    // de falha MAIS comum do endpoint.
    testDriverBehavior = 'credencial-s3';
    expect((await testConnection(TENANT_A, s3TenantBody(BUCKET_A))).statusCode).toBe(200);

    testDriverBehavior = 'permissao-sharepoint';
    expect((await testConnection(TENANT_A, sharePointBody())).statusCode).toBe(200);

    testDriverBehavior = 'destino-sharepoint';
    expect((await testConnection(TENANT_A, sharePointBody())).statusCode).toBe(200);

    expect(connectionTestDeletes).toEqual([]);
  });

  it('segredo ilegível no banco não chega a construir driver — 200 com INVALID_CONFIG', async () => {
    // Linha com `encrypted_secret` corrompido (chave mestra trocada, dump
    // restaurado pela metade). O corpo omite o segredo, então o teste tenta
    // usar o gravado e o `parseStorageTarget` falha ANTES de qualquer I/O — é
    // um problema de cadastro, não do provedor, e a tela precisa saber a
    // diferença.
    await testDb.db`
      INSERT INTO tenant_storage_configs (tenant_id, provider, credentials_source, config, encrypted_secret)
      VALUES (${TENANT_A}, 's3', 'tenant', ${testDb.db.json({
        region: 'sa-east-1',
        bucket: BUCKET_A,
        accessKeyId: 'AKIA',
        forcePathStyle: false,
      })}, 'v1:aaaa:bbbb:cccc')
    `;

    const res = await testConnection(
      TENANT_A,
      s3TenantBody(BUCKET_A, { secretAccessKey: undefined })
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, code: 'INVALID_CONFIG' });
    expect(testTargets).toHaveLength(0);
  });

  it('empresa inexistente é 404', async () => {
    const res = await testConnection(crypto.randomUUID(), s3TenantBody(BUCKET_A));
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Guardas de papel
// ---------------------------------------------------------------------------

describe('guardas de papel', () => {
  it('TENANT_ADMIN recebe 403 nos três endpoints, inclusive na própria empresa', async () => {
    expect((await getStorage(TENANT_A, tokenAdminA)).statusCode).toBe(403);
    expect((await putStorage(TENANT_A, s3TenantBody(BUCKET_A), tokenAdminA)).statusCode).toBe(403);
    expect((await testConnection(TENANT_A, s3TenantBody(BUCKET_A), tokenAdminA)).statusCode).toBe(
      403
    );

    expect(await storageRows(TENANT_A)).toHaveLength(0);
  });

  it('TENANT_ADMIN de outra empresa também recebe 403 — e não descobre nada da empresa A', async () => {
    expect((await putStorage(TENANT_A, s3TenantBody(BUCKET_A))).statusCode).toBe(200);

    const res = await getStorage(TENANT_A, tokenAdminB);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(BUCKET_A);
  });

  it('sem token é 401', async () => {
    const res = await app.inject({ method: 'GET', url: `/admin/tenants/${TENANT_A}/storage` });
    expect(res.statusCode).toBe(401);
  });
});
