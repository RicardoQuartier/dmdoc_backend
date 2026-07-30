import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { newId } from '@dmdoc/db-pg';
import {
  createStorageResolver,
  encryptSecret,
  parseSecretKey,
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
 * Endpoints da migração de acervo entre destinos (épico E-11 / T-141):
 * disparo, progresso, cancelamento e limpeza da origem.
 *
 * ## O que estes testes existem para impedir
 *
 * O `cleanup-source` é a única operação do sistema que apaga arquivo de cliente
 * sem volta. Ele só pode rodar quando NENHUM documento depende mais da origem, e
 * essa pergunta é respondida por `storage_config_id IS DISTINCT FROM <ativa>` —
 * nunca por `storage_provider`. Numa troca s3 → s3 os dois lados têm o mesmo
 * provider: o critério errado responde "ninguém depende da origem" com o acervo
 * inteiro ainda lá.
 *
 * Há ainda um segundo jeito de apagar o acervo vivo, e ele não estava na ADR-1:
 * uma configuração APOSENTADA pode apontar para o MESMO bucket da ativa (é o que
 * uma rotação de credencial produz, porque as linhas são imutáveis). Varrer "o
 * destino anterior" ali apagaria exatamente o que a migração acabou de gravar.
 *
 * A app roda com o `createStorageResolver` DE VERDADE, lendo
 * `tenant_storage_configs`; só as fábricas de driver são falsas (um balde em
 * memória por bucket).
 */

// ---------------------------------------------------------------------------
// Mundo falso de armazenamento
// ---------------------------------------------------------------------------

const world = new Map<string, Map<string, Buffer>>();

function bucketOf(name: string): Map<string, Buffer> {
  let bucket = world.get(name);
  if (bucket === undefined) {
    bucket = new Map<string, Buffer>();
    world.set(name, bucket);
  }
  return bucket;
}

/** Prefixos que o `deletePrefix` deve recusar — para exercitar a falha parcial. */
const failDeletePrefixOn = new Set<string>();

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
      if (failDeletePrefixOn.has(destination)) {
        throw new Error(`provedor recusou a remoção em ${destination}`);
      }
      for (const key of [...(world.get(destination)?.keys() ?? [])]) {
        if (key.startsWith(prefix)) bucketOf(destination).delete(key);
      }
    },
  };
}

/**
 * Bucket da plataforma: o MESMO nome que `testConfig()` injeta em
 * `AWS_S3_BUCKET`. Não é detalhe — a rota calcula a identidade física do destino
 * de plataforma a partir da config da app, e um nome diferente aqui esconderia
 * o caso "cliente assumiu o bucket da plataforma".
 */
const PLATFORM_BUCKET = 'test-bucket';
const PLATFORM_S3_CONFIG: S3Config = {
  region: 'us-east-1',
  bucket: PLATFORM_BUCKET,
  accessKeyId: 'test-key-id',
  secretAccessKey: 'test-secret-key',
  forcePathStyle: false,
};

// ---------------------------------------------------------------------------
// Fila falsa
// ---------------------------------------------------------------------------

interface EnqueuedJob {
  name: string;
  data: unknown;
  opts: unknown;
}

const enqueued: EnqueuedJob[] = [];
let queueFailure: Error | null = null;

const fakeQueue = {
  add: async (name: string, data: unknown, opts: unknown) => {
    if (queueFailure !== null) throw queueFailure;
    enqueued.push({ name, data, opts });
    return { id: 'job' };
  },
  close: async () => undefined,
} as unknown as Queue;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT = crypto.randomUUID();
const SUPER_ID = crypto.randomUUID();
const ADMIN_ID = crypto.randomUUID();
const DEPT_ID = newId();
const PASSWORD = 'senha-forte-de-teste-123';

const BUCKET_ANTIGO = 'bucket-antigo-do-cliente';
const BUCKET_NOVO = 'bucket-novo-do-cliente';

let app: FastifyInstance;
let testDb: TestDb;
let storage: StorageResolver;
let tokenSuper: string;
let tokenAdmin: string;

const secretKey = parseSecretKey(TEST_STORAGE_SECRET_KEY_HEX);

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

/** Insere uma configuração de armazenamento (ativa ou aposentada) da empresa. */
async function seedStorageConfig(params: {
  bucket: string;
  active: boolean;
  provider?: 's3' | 'sharepoint';
}): Promise<string> {
  const rows = await testDb.db<Array<{ id: string }>>`
    INSERT INTO tenant_storage_configs (
      tenant_id, provider, credentials_source, config, encrypted_secret, active, retired_at
    ) VALUES (
      ${TENANT},
      ${params.provider ?? 's3'},
      'tenant',
      ${testDb.db.json(
        params.provider === 'sharepoint'
          ? {
              azureTenantId: 'azure',
              clientId: 'client',
              siteId: 'site',
              driveId: params.bucket,
            }
          : {
              region: 'sa-east-1',
              bucket: params.bucket,
              accessKeyId: 'AKIA-DO-CLIENTE',
              forcePathStyle: false,
            }
      )},
      ${encryptedTestSecret()},
      ${params.active},
      ${params.active ? null : new Date()}
    )
    RETURNING id
  `;
  return rows[0]!.id;
}

/** Segredo cifrado com a chave mestra de teste — o resolver precisa decifrá-lo. */
function encryptedTestSecret(): string {
  return encryptSecret('secret-access-key-do-cliente', secretKey);
}

async function seedDocument(params: {
  storageConfigId: string | null;
  bucket: string;
  provider?: 's3' | 'sharepoint';
  deleted?: boolean;
}): Promise<{ id: string; storageKey: string }> {
  const id = newId();
  const contentHash = crypto.randomBytes(32).toString('hex');
  const storageKey = `tenants/${TENANT}/documents/${contentHash}/arquivo.pdf`;

  await testDb.db`
    INSERT INTO documents (
      id, tenant_id, department_id, filename, original_filename, content_hash,
      size_bytes, mime_type, storage_key, storage_provider, storage_config_id,
      status, uploaded_by_id, uploaded_at, deleted
    ) VALUES (
      ${id}, ${TENANT}, ${DEPT_ID}, 'arquivo.pdf', 'arquivo.pdf', ${contentHash},
      ${1024}, 'application/pdf', ${storageKey}, ${params.provider ?? 's3'},
      ${params.storageConfigId}, 'READY', ${ADMIN_ID}, NOW(), ${params.deleted ?? false}
    )
  `;

  bucketOf(params.bucket).set(storageKey, Buffer.from('conteudo do documento'));
  return { id, storageKey };
}

async function migrationRows(): Promise<
  Array<{ id: string; status: string; from_provider: string; to_provider: string }>
> {
  return testDb.db`
    SELECT id, status, from_provider, to_provider
    FROM storage_migrations
    WHERE tenant_id = ${TENANT}
    ORDER BY created_at ASC
  `;
}

async function auditEntries(action: string): Promise<Array<Record<string, unknown>>> {
  const rows = await testDb.db<Array<{ metadata: string }>>`
    SELECT metadata FROM audit_logs
    WHERE tenant_id = ${TENANT} AND action = ${action}
    ORDER BY created_at ASC
  `;
  return rows.map((row) => JSON.parse(row.metadata) as Record<string, unknown>);
}

function startMigration(token = tokenSuper) {
  return app.inject({
    method: 'POST',
    url: `/admin/tenants/${TENANT}/storage/migrate`,
    headers: { authorization: `Bearer ${token}` },
  });
}

function getMigration(token = tokenSuper) {
  return app.inject({
    method: 'GET',
    url: `/admin/tenants/${TENANT}/storage/migrate`,
    headers: { authorization: `Bearer ${token}` },
  });
}

function cancelMigration(token = tokenSuper) {
  return app.inject({
    method: 'POST',
    url: `/admin/tenants/${TENANT}/storage/migrate/cancel`,
    headers: { authorization: `Bearer ${token}` },
  });
}

function cleanupSource(token = tokenSuper) {
  return app.inject({
    method: 'POST',
    url: `/admin/tenants/${TENANT}/storage/cleanup-source`,
    headers: { authorization: `Bearer ${token}` },
  });
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
    storageMigrationQueue: fakeQueue,
    storage,
  });
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(async () => {
  world.clear();
  failDeletePrefixOn.clear();
  enqueued.length = 0;
  queueFailure = null;
  storage.invalidateAll();

  await resetDomainTables(testDb.db);

  await testDb.db`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
    VALUES (${TENANT}, 'Empresa da Migração', ${10 * 1024 * 1024}, 20, true, NOW())
  `;
  await testDb.db`
    INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
    VALUES (${DEPT_ID}, ${TENANT}, NULL, 'Financeiro', 0, '{}'::text[], false, NOW())
  `;
  await seedUser(testDb.db, {
    id: SUPER_ID,
    tenantId: null,
    email: 'super-migracao@dmdoc.com',
    password: PASSWORD,
    role: 'SUPER_ADMIN',
  });
  await seedUser(testDb.db, {
    id: ADMIN_ID,
    tenantId: TENANT,
    email: 'admin-migracao@empresa.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
  });

  tokenSuper = await login('super-migracao@dmdoc.com');
  tokenAdmin = await login('admin-migracao@empresa.com');
});

// ---------------------------------------------------------------------------
// Disparo
// ---------------------------------------------------------------------------

describe('POST /admin/tenants/:id/storage/migrate', () => {
  it('enfileira a migração e enxerga os documentos numa troca s3 → s3', async () => {
    // O cenário da ADR-1: plataforma (s3) → bucket do cliente (s3). Se a
    // seleção fosse por `storage_provider`, `totalDocs` viria 0 e a tela
    // mostraria uma migração "concluída" sem nada copiado.
    const destino = await seedStorageConfig({ bucket: BUCKET_NOVO, active: true });
    await seedDocument({ storageConfigId: null, bucket: PLATFORM_BUCKET });
    await seedDocument({ storageConfigId: null, bucket: PLATFORM_BUCKET });

    const res = await startMigration();
    expect(res.statusCode).toBe(202);

    const body = res.json();
    expect(body.migration.status).toBe('PENDING');
    expect(body.destination.storageConfigId).toBe(destino);
    expect(body.pendingDocuments).toBe(2);
    expect(body.pendingSources).toEqual([
      { storageConfigId: null, provider: 's3', documentCount: 2 },
    ]);
    expect(body.cleanupAvailable).toBe(false);

    // O job carrega só tenant + migração, e o `jobId` é a própria migração —
    // dois jobs para a mesma linha não coexistem.
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.data).toEqual({ tenantId: TENANT, migrationId: body.migration.id });
    expect(enqueued[0]!.opts).toMatchObject({ jobId: body.migration.id });
  });

  it('recusa com 409 quando já existe uma migração ativa', async () => {
    await seedStorageConfig({ bucket: BUCKET_NOVO, active: true });
    await seedDocument({ storageConfigId: null, bucket: PLATFORM_BUCKET });

    expect((await startMigration()).statusCode).toBe(202);

    const segunda = await startMigration();
    expect(segunda.statusCode).toBe(409);
    expect(segunda.json().error.code).toBe('CONFLICT');
    // A garantia real é o índice único parcial: nenhuma linha extra nasceu.
    expect(await migrationRows()).toHaveLength(1);
    expect(enqueued).toHaveLength(1);
  });

  it('encerra a linha quando o enfileiramento falha, para não travar a empresa', async () => {
    await seedStorageConfig({ bucket: BUCKET_NOVO, active: true });
    queueFailure = new Error('redis fora do ar');

    const res = await startMigration();
    expect(res.statusCode).toBe(502);

    // A linha existe (para o histórico) mas está encerrada — sem isso, o índice
    // único parcial manteria uma migração fantasma viva para sempre e nenhuma
    // outra poderia ser disparada.
    const [migration] = await migrationRows();
    expect(migration!.status).toBe('FAILED');

    // Com o Redis de volta, disparar de novo funciona: a linha encerrada saiu
    // do índice único parcial.
    queueFailure = null;
    expect((await startMigration()).statusCode).toBe(202);
  });

  it('registra audit log do disparo com as origens envolvidas', async () => {
    const aposentada = await seedStorageConfig({ bucket: BUCKET_ANTIGO, active: false });
    await seedStorageConfig({ bucket: BUCKET_NOVO, active: true });
    await seedDocument({ storageConfigId: aposentada, bucket: BUCKET_ANTIGO });
    await seedDocument({ storageConfigId: null, bucket: PLATFORM_BUCKET });

    await startMigration();

    const [entry] = await auditEntries('tenant.storage.migrate.requested');
    expect(entry).toBeDefined();
    expect(entry!['totalDocs']).toBe(2);
    expect(entry!['sourceStorageConfigIds']).toEqual(
      expect.arrayContaining([aposentada, null])
    );
  });

  it('só o SUPER_ADMIN dispara; empresa inexistente é 404', async () => {
    await seedStorageConfig({ bucket: BUCKET_NOVO, active: true });

    expect((await startMigration(tokenAdmin)).statusCode).toBe(403);

    const inexistente = await app.inject({
      method: 'POST',
      url: `/admin/tenants/${crypto.randomUUID()}/storage/migrate`,
      headers: { authorization: `Bearer ${tokenSuper}` },
    });
    expect(inexistente.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Guarda do PUT
// ---------------------------------------------------------------------------

describe('PUT /admin/tenants/:id/storage durante migração', () => {
  it('recusa a troca de destino com 409 enquanto há migração ativa', async () => {
    await seedStorageConfig({ bucket: BUCKET_NOVO, active: true });
    await seedDocument({ storageConfigId: null, bucket: PLATFORM_BUCKET });
    await startMigration();

    const res = await app.inject({
      method: 'PUT',
      url: `/admin/tenants/${TENANT}/storage`,
      headers: { authorization: `Bearer ${tokenSuper}` },
      payload: {
        provider: 's3',
        credentialsSource: 'tenant',
        region: 'sa-east-1',
        bucket: 'terceiro-bucket',
        accessKeyId: 'AKIA-OUTRA',
        secretAccessKey: 'outro-segredo',
      },
    });

    expect(res.statusCode).toBe(409);
    // Nenhuma linha nova de configuração: o destino continua sendo o alvo para
    // o qual o job está convergindo.
    const configs = await testDb.db<Array<{ id: string }>>`
      SELECT id FROM tenant_storage_configs WHERE tenant_id = ${TENANT}
    `;
    expect(configs).toHaveLength(1);
  });

  it('libera a troca depois que a migração é cancelada', async () => {
    await seedStorageConfig({ bucket: BUCKET_NOVO, active: true });
    await startMigration();
    await cancelMigration();

    const res = await app.inject({
      method: 'PUT',
      url: `/admin/tenants/${TENANT}/storage`,
      headers: { authorization: `Bearer ${tokenSuper}` },
      payload: {
        provider: 's3',
        credentialsSource: 'tenant',
        region: 'sa-east-1',
        bucket: 'terceiro-bucket',
        accessKeyId: 'AKIA-OUTRA',
        secretAccessKey: 'outro-segredo',
      },
    });

    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Progresso e cancelamento
// ---------------------------------------------------------------------------

describe('GET e cancelamento da migração', () => {
  it('devolve null quando a empresa nunca migrou, com o destino corrente', async () => {
    const res = await getMigration();
    expect(res.statusCode).toBe(200);
    expect(res.json().migration).toBeNull();
    expect(res.json().destination).toEqual({ storageConfigId: null, provider: 's3' });
  });

  it('acompanha o progresso gravado pelo worker', async () => {
    await seedStorageConfig({ bucket: BUCKET_NOVO, active: true });
    await seedDocument({ storageConfigId: null, bucket: PLATFORM_BUCKET });
    await seedDocument({ storageConfigId: null, bucket: PLATFORM_BUCKET });
    const started = (await startMigration()).json();

    await testDb.db`
      UPDATE storage_migrations
      SET status = 'RUNNING', started_at = now(), total_docs = 2, migrated_docs = 1
      WHERE id = ${started.migration.id as string}
    `;

    const body = (await getMigration()).json();
    expect(body.migration.status).toBe('RUNNING');
    expect(body.migration.migratedDocs).toBe(1);
    // `pendingDocuments` vem do BANCO, não do contador: o worker ainda não
    // comutou nenhuma linha, então continuam 2 dependendo da origem.
    expect(body.pendingDocuments).toBe(2);
    expect(body.cleanupAvailable).toBe(false);
  });

  it('cancela a migração em andamento e recusa o cancelamento seguinte', async () => {
    await seedStorageConfig({ bucket: BUCKET_NOVO, active: true });
    await startMigration();

    const cancelada = await cancelMigration();
    expect(cancelada.statusCode).toBe(200);
    expect(cancelada.json().migration.status).toBe('CANCELLED');
    expect(cancelada.json().migration.finishedAt).not.toBeNull();

    expect((await cancelMigration()).statusCode).toBe(409);

    const [entry] = await auditEntries('tenant.storage.migrate.cancelled');
    expect(entry).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Limpeza da origem — a operação sem volta
// ---------------------------------------------------------------------------

describe('POST /admin/tenants/:id/storage/cleanup-source', () => {
  it('recusa enquanto houver documento apontando para a origem, mesmo com provider igual dos dois lados', async () => {
    // s3 → s3: `storage_provider` é 's3' na origem e no destino. A guarda
    // precisa olhar `storage_config_id`, senão apaga o acervo inteiro aqui.
    await seedStorageConfig({ bucket: BUCKET_NOVO, active: true });
    const doc = await seedDocument({ storageConfigId: null, bucket: PLATFORM_BUCKET });

    const res = await cleanupSource();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('1 documento');

    // Nada foi apagado.
    expect(world.get(PLATFORM_BUCKET)?.has(doc.storageKey)).toBe(true);
    expect(await auditEntries('tenant.storage.cleanup_source')).toHaveLength(0);
  });

  it('recusa enquanto há migração ativa', async () => {
    await seedStorageConfig({ bucket: BUCKET_NOVO, active: true });
    await startMigration();

    expect((await cleanupSource()).statusCode).toBe(409);
  });

  it('apaga o acervo dos destinos anteriores depois que todos os documentos comutaram', async () => {
    const aposentada = await seedStorageConfig({ bucket: BUCKET_ANTIGO, active: false });
    const destino = await seedStorageConfig({ bucket: BUCKET_NOVO, active: true });

    // Estado pós-migração: todo documento aponta para o destino e o arquivo
    // existe nos DOIS lados (a migração copia, nunca move).
    const migrado = await seedDocument({ storageConfigId: destino, bucket: BUCKET_NOVO });
    bucketOf(BUCKET_ANTIGO).set(migrado.storageKey, Buffer.from('copia antiga'));
    bucketOf(PLATFORM_BUCKET).set(migrado.storageKey, Buffer.from('copia mais antiga'));

    const res = await cleanupSource();
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    // As origens ficam vazias; o destino ativo permanece intacto.
    expect(world.get(BUCKET_ANTIGO)?.size ?? 0).toBe(0);
    expect(world.get(PLATFORM_BUCKET)?.size ?? 0).toBe(0);
    expect(world.get(BUCKET_NOVO)?.get(migrado.storageKey)).toBeDefined();

    const [entry] = await auditEntries('tenant.storage.cleanup_source');
    expect(entry!['sweptStorageConfigIds']).toEqual(expect.arrayContaining([aposentada, null]));
    expect(entry!['activeStorageConfigId']).toBe(destino);
  });

  it('NÃO varre uma configuração aposentada que aponta para o MESMO bucket da ativa', async () => {
    // Rotação de credencial: linha nova, mesmo bucket (as linhas são
    // imutáveis). Varrer "a anterior" apagaria o acervo vivo.
    const credencialAntiga = await seedStorageConfig({ bucket: BUCKET_NOVO, active: false });
    const credencialNova = await seedStorageConfig({ bucket: BUCKET_NOVO, active: true });
    const doc = await seedDocument({ storageConfigId: credencialNova, bucket: BUCKET_NOVO });

    const res = await cleanupSource();
    expect(res.statusCode).toBe(200);
    expect(res.json().skipped).toEqual([
      { storageConfigId: credencialAntiga, provider: 's3', reason: 'MESMO_DESTINO_FISICO' },
    ]);

    // O arquivo continua lá — este é o teste que separa "limpeza" de "perda".
    expect(world.get(BUCKET_NOVO)?.get(doc.storageKey)).toBeDefined();
  });

  it('NÃO varre a plataforma quando o destino ativo é o próprio bucket da plataforma', async () => {
    await seedStorageConfig({ bucket: PLATFORM_BUCKET, active: true });
    const doc = await seedDocument({ storageConfigId: null, bucket: PLATFORM_BUCKET });
    // O documento ainda está na configuração NULA (plataforma) — precisa migrar
    // antes; comutamos para o destino, como o worker faria.
    await testDb.db`
      UPDATE documents
      SET storage_config_id = (
        SELECT id FROM tenant_storage_configs WHERE tenant_id = ${TENANT} AND active
      )
      WHERE id = ${doc.id}
    `;

    const res = await cleanupSource();
    expect(res.statusCode).toBe(200);
    expect(res.json().swept).toHaveLength(0);
    expect(res.json().skipped).toHaveLength(1);
    expect(world.get(PLATFORM_BUCKET)?.get(doc.storageKey)).toBeDefined();
  });

  it('reporta a origem que não pôde ser apagada sem impedir as outras', async () => {
    const aposentada = await seedStorageConfig({ bucket: BUCKET_ANTIGO, active: false });
    const destino = await seedStorageConfig({ bucket: BUCKET_NOVO, active: true });
    const doc = await seedDocument({ storageConfigId: destino, bucket: BUCKET_NOVO });
    bucketOf(BUCKET_ANTIGO).set(doc.storageKey, Buffer.from('copia antiga'));
    bucketOf(PLATFORM_BUCKET).set(doc.storageKey, Buffer.from('copia mais antiga'));

    failDeletePrefixOn.add(BUCKET_ANTIGO);

    const res = await cleanupSource();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.swept).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ storageConfigId: aposentada, ok: false }),
        expect.objectContaining({ storageConfigId: null, ok: true }),
      ])
    );

    // A origem que falhou continua com os arquivos; a que deu certo foi varrida.
    expect(world.get(BUCKET_ANTIGO)?.size).toBe(1);
    expect(world.get(PLATFORM_BUCKET)?.size ?? 0).toBe(0);

    const [entry] = await auditEntries('tenant.storage.cleanup_source');
    expect(entry!['failedStorageConfigIds']).toEqual([aposentada]);
  });

  it('só o SUPER_ADMIN limpa a origem', async () => {
    await seedStorageConfig({ bucket: BUCKET_NOVO, active: true });
    expect((await cleanupSource(tokenAdmin)).statusCode).toBe(403);
  });
});
