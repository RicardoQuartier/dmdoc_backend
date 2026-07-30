import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import postgres, { type Sql } from 'postgres';
import type { StorageDriver } from '@dmdoc/storage';
import type { StorageForTenant } from './storage.js';
import { runStorageMigration } from './storage-migration.js';

/**
 * Migração de acervo entre destinos (épico E-11 / T-141).
 *
 * ## Por que estes testes usam PostgreSQL de verdade
 *
 * A parte perigosa desta tarefa é uma CONSULTA. O modo de falha que a ADR-1
 * corrigiu — seleção vazia com aparência de sucesso, seguida de um
 * `cleanup-source` que apaga o acervo nunca copiado — nasce de duas trocas
 * silenciosas: comparar `storage_provider` em vez de `storage_config_id`, e usar
 * `<>` em vez de `IS DISTINCT FROM`. Um dublê de `Sql` responderia o que o teste
 * mandasse e as duas passariam verdes. Só o banco de verdade sabe que
 * `NULL <> 'uuid'` é `NULL`, e que `NULL` no `WHERE` descarta a linha.
 *
 * O storage, esse sim, é falso: um mapa por destino. É o que permite afirmar de
 * QUAL destino cada byte saiu — inclusive no caso s3 → s3, em que
 * `storage_provider` é idêntico dos dois lados e não distingue nada.
 */

// ---------------------------------------------------------------------------
// Mundo falso de armazenamento
// ---------------------------------------------------------------------------

/** destino (bucket/drive) → chave → conteúdo. */
const buckets = new Map<string, Map<string, Buffer>>();
/** `storage_config_id` (ou `'platform'`) → nome do destino. */
const destinationOf = new Map<string, string>();

/** Chaves cujo `get` deve falhar (simula arquivo ausente / provedor fora). */
const failOnGet = new Set<string>();
/** Chaves cujo `get` devolve conteúdo ADULTERADO (hash não bate). */
const corruptOnGet = new Set<string>();
/** Chaves cujo `put` deve falhar. */
const failOnPut = new Set<string>();
/** Gancho executado a cada `put` bem-sucedido — usado para cancelar no meio. */
let afterPut: ((key: string) => Promise<void>) | null = null;

const getCalls: string[] = [];
const putCalls: string[] = [];

function bucketOf(name: string): Map<string, Buffer> {
  let bucket = buckets.get(name);
  if (bucket === undefined) {
    bucket = new Map<string, Buffer>();
    buckets.set(name, bucket);
  }
  return bucket;
}

function fakeDriver(destination: string, provider: 's3' | 'sharepoint' = 's3'): StorageDriver {
  return {
    provider,
    put: async ({ key, buffer }) => {
      if (failOnPut.has(key)) throw new Error(`put recusado em ${destination}: ${key}`);
      putCalls.push(`${destination}:${key}`);
      bucketOf(destination).set(key, buffer);
      if (afterPut !== null) await afterPut(key);
    },
    get: async (key) => {
      getCalls.push(`${destination}:${key}`);
      if (failOnGet.has(key)) throw new Error(`objeto indisponível em ${destination}: ${key}`);
      if (corruptOnGet.has(key)) return Buffer.from('conteudo adulterado na origem');
      const found = buckets.get(destination)?.get(key);
      if (found === undefined) throw new Error(`objeto inexistente em ${destination}: ${key}`);
      return found;
    },
    getDownloadUrl: async (key) => `https://${destination}.fake/${key}`,
    delete: async (key) => {
      bucketOf(destination).delete(key);
    },
    deletePrefix: async (prefix) => {
      for (const key of [...(buckets.get(destination)?.keys() ?? [])]) {
        if (key.startsWith(prefix)) bucketOf(destination).delete(key);
      }
    },
  };
}

/**
 * Resolvedor falso: mapeia `storage_config_id` → destino, exatamente como o
 * `forStorageConfig` de verdade faria depois de ler `tenant_storage_configs`.
 * `null` é o S3 da plataforma.
 */
const storage: StorageForTenant = {
  forTenant: async () => fakeDriver(PLATFORM),
  forStorageConfig: async (_tenantId: string, storageConfigId: string | null) => {
    const destination = destinationOf.get(storageConfigId ?? 'platform');
    if (destination === undefined) {
      throw new Error(`configuração sem destino mapeado no teste: ${String(storageConfigId)}`);
    }
    return fakeDriver(destination);
  },
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PLATFORM = 'bucket-da-plataforma';
const TENANT_ID = crypto.randomUUID();
const OTHER_TENANT_ID = crypto.randomUUID();
const DEPARTMENT_ID = crypto.randomUUID();
const USER_ID = crypto.randomUUID();

const logger = pino({ level: 'silent' });

let sql: Sql;

async function seedTenantStorageConfig(params: {
  tenantId?: string;
  provider?: 's3' | 'sharepoint';
  bucket: string;
  active: boolean;
}): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO tenant_storage_configs (
      tenant_id, provider, credentials_source, config, encrypted_secret, active, retired_at
    ) VALUES (
      ${params.tenantId ?? TENANT_ID},
      ${params.provider ?? 's3'},
      'tenant',
      ${sql.json({ bucket: params.bucket, region: 'us-east-1', accessKeyId: 'AKIA' })},
      'segredo-cifrado-de-mentira',
      ${params.active},
      ${params.active ? null : new Date()}
    )
    RETURNING id
  `;
  const id = rows[0]!.id;
  destinationOf.set(id, params.bucket);
  return id;
}

interface SeededDocument {
  id: string;
  storageKey: string;
  contentHash: string;
  content: Buffer;
}

/**
 * Documento já gravado num destino: linha em `documents` apontando para a
 * configuração e o arquivo dentro do balde correspondente.
 */
async function seedDocument(params: {
  storageConfigId: string | null;
  provider?: 's3' | 'sharepoint';
  deleted?: boolean;
  /** Não gravar o arquivo no destino — simula acervo corrompido/ausente. */
  skipFile?: boolean;
  tenantId?: string;
}): Promise<SeededDocument> {
  const tenantId = params.tenantId ?? TENANT_ID;
  const content = Buffer.from(`conteudo ${crypto.randomUUID()}`);
  const contentHash = crypto.createHash('sha256').update(content).digest('hex');
  const storageKey = `tenants/${tenantId}/documents/${contentHash}/arquivo.pdf`;

  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO documents (
      tenant_id, department_id, filename, original_filename, content_hash, size_bytes,
      mime_type, storage_key, storage_provider, storage_config_id, status,
      uploaded_by_id, uploaded_at, deleted
    ) VALUES (
      ${tenantId}, ${DEPARTMENT_ID}, 'arquivo.pdf', 'arquivo.pdf', ${contentHash},
      ${content.length}, 'application/pdf', ${storageKey},
      ${params.provider ?? 's3'}, ${params.storageConfigId}, 'READY',
      ${USER_ID}, now(), ${params.deleted ?? false}
    )
    RETURNING id
  `;

  if (params.skipFile !== true) {
    const destination = destinationOf.get(params.storageConfigId ?? 'platform');
    if (destination === undefined) throw new Error('destino do documento não mapeado no teste');
    bucketOf(destination).set(storageKey, content);
  }

  return { id: rows[0]!.id, storageKey, contentHash, content };
}

async function createMigration(tenantId = TENANT_ID): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO storage_migrations (tenant_id, from_provider, to_provider, status)
    VALUES (${tenantId}, 's3', 's3', 'PENDING')
    RETURNING id
  `;
  return rows[0]!.id;
}

interface MigrationRow {
  status: string;
  total_docs: number;
  migrated_docs: number;
  failed_docs: number;
  last_error: string | null;
  started_at: Date | null;
  finished_at: Date | null;
}

async function migrationRow(migrationId: string): Promise<MigrationRow> {
  const rows = await sql<MigrationRow[]>`
    SELECT status, total_docs, migrated_docs, failed_docs, last_error, started_at, finished_at
    FROM storage_migrations
    WHERE id = ${migrationId}
  `;
  return rows[0]!;
}

async function documentRow(
  documentId: string
): Promise<{ storage_config_id: string | null; storage_provider: string }> {
  const rows = await sql<Array<{ storage_config_id: string | null; storage_provider: string }>>`
    SELECT storage_config_id, storage_provider FROM documents WHERE id = ${documentId}
  `;
  return rows[0]!;
}

beforeAll(async () => {
  const url =
    process.env['TEST_DATABASE_URL'] ??
    process.env['DATABASE_URL'] ??
    'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test';
  // `onnotice` silencioso: o TRUNCATE ... CASCADE do `beforeEach` emite um
  // NOTICE por tabela em cascata e afogaria a saída da suíte.
  sql = postgres(url, { max: 5, onnotice: () => undefined });
});

afterAll(async () => {
  await sql.end();
});

beforeEach(async () => {
  buckets.clear();
  destinationOf.clear();
  destinationOf.set('platform', PLATFORM);
  failOnGet.clear();
  corruptOnGet.clear();
  failOnPut.clear();
  afterPut = null;
  getCalls.length = 0;
  putCalls.length = 0;

  await sql.unsafe(`
    TRUNCATE TABLE documents, storage_migrations, tenant_storage_configs, departments, users, tenants
    RESTART IDENTITY CASCADE
  `);

  await sql`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
    VALUES
      (${TENANT_ID}, 'Empresa da Migração', ${10 * 1024 * 1024}, 20, true, now()),
      (${OTHER_TENANT_ID}, 'Outra Empresa', ${10 * 1024 * 1024}, 20, true, now())
  `;
  await sql`
    INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
    VALUES (${DEPARTMENT_ID}, ${TENANT_ID}, NULL, 'Financeiro', 0, '{}'::text[], false, now())
  `;
  await sql`
    INSERT INTO users (id, tenant_id, email, password_hash, name, role, active, created_at, deleted)
    VALUES (${USER_ID}, ${TENANT_ID}, 'migracao@empresa.com', 'hash', 'Operador', 'TENANT_ADMIN', true, now(), false)
  `;
});

// ---------------------------------------------------------------------------
// Seleção — o coração da ADR-1
// ---------------------------------------------------------------------------

describe('runStorageMigration — seleção dos documentos', () => {
  it('migra de S3 da plataforma para S3 próprio (mesmo provider dos dois lados): total_docs == N, não zero', async () => {
    // O cenário exato da ADR-1: `storage_provider` é 's3' na origem E no destino.
    // Um critério por provider selecionaria ZERO e a migração fecharia em DONE
    // sem copiar nada.
    const destino = await seedTenantStorageConfig({ bucket: 'bucket-do-cliente', active: true });
    const docs = await Promise.all([
      seedDocument({ storageConfigId: null }),
      seedDocument({ storageConfigId: null }),
      seedDocument({ storageConfigId: null }),
    ]);

    const migrationId = await createMigration();
    const summary = await runStorageMigration({ sql, storage, logger, concurrency: 1 }, {
      tenantId: TENANT_ID,
      migrationId,
    });

    expect(summary.total).toBe(3);
    expect(summary.migrated).toBe(3);
    expect(summary.failed).toBe(0);

    const row = await migrationRow(migrationId);
    expect(row.total_docs).toBe(3);
    expect(row.migrated_docs).toBe(3);
    expect(row.failed_docs).toBe(0);
    expect(row.status).toBe('DONE');

    // Os arquivos existem no destino, byte a byte.
    for (const doc of docs) {
      expect(buckets.get('bucket-do-cliente')?.get(doc.storageKey)).toEqual(doc.content);
      const after = await documentRow(doc.id);
      expect(after.storage_config_id).toBe(destino);
      expect(after.storage_provider).toBe('s3');
    }
  });

  it('seleciona o documento que ainda está na plataforma (storage_config_id IS NULL)', async () => {
    // Prova do `IS DISTINCT FROM`: com `<>`, `NULL <> 'uuid'` é NULL e a linha
    // sumiria do WHERE sem nenhum sinal.
    const destino = await seedTenantStorageConfig({ bucket: 'destino-novo', active: true });
    const naPlataforma = await seedDocument({ storageConfigId: null });

    const migrationId = await createMigration();
    const summary = await runStorageMigration({ sql, storage, logger, concurrency: 1 }, {
      tenantId: TENANT_ID,
      migrationId,
    });

    expect(summary.total).toBe(1);
    expect((await documentRow(naPlataforma.id)).storage_config_id).toBe(destino);
  });

  it('seleciona o documento que ficou num destino aposentado quando o destino ativo é a PLATAFORMA', async () => {
    // O `NULL` agora está do lado do DESTINO — o outro jeito de `<>` devolver
    // NULL e esvaziar a seleção.
    const aposentado = await seedTenantStorageConfig({ bucket: 'bucket-antigo', active: false });
    const doc = await seedDocument({ storageConfigId: aposentado });

    const migrationId = await createMigration();
    const summary = await runStorageMigration({ sql, storage, logger, concurrency: 1 }, {
      tenantId: TENANT_ID,
      migrationId,
    });

    expect(summary.total).toBe(1);
    expect(summary.migrated).toBe(1);
    expect(buckets.get(PLATFORM)?.get(doc.storageKey)).toEqual(doc.content);

    const after = await documentRow(doc.id);
    expect(after.storage_config_id).toBeNull();
    // O CHECK `documents_platform_storage_is_s3` exige 's3' quando a config é
    // nula — a comutação das duas colunas juntas é o que garante isso.
    expect(after.storage_provider).toBe('s3');
  });

  it('converge TRÊS origens diferentes numa única passada', async () => {
    const antigo = await seedTenantStorageConfig({ bucket: 'bucket-primeiro', active: false });
    const intermediario = await seedTenantStorageConfig({
      bucket: 'drive-do-cliente',
      provider: 'sharepoint',
      active: false,
    });
    const destino = await seedTenantStorageConfig({ bucket: 'bucket-final', active: true });

    const naPlataforma = await seedDocument({ storageConfigId: null });
    const noAntigo = await seedDocument({ storageConfigId: antigo });
    const noIntermediario = await seedDocument({
      storageConfigId: intermediario,
      provider: 'sharepoint',
    });
    const jaNoDestino = await seedDocument({ storageConfigId: destino });

    const migrationId = await createMigration();
    const summary = await runStorageMigration({ sql, storage, logger, concurrency: 4 }, {
      tenantId: TENANT_ID,
      migrationId,
    });

    // O que já estava no destino NÃO entra na conta nem é recopiado.
    expect(summary.total).toBe(3);
    expect(summary.migrated).toBe(3);
    expect(putCalls).not.toContain(`bucket-final:${jaNoDestino.storageKey}`);

    for (const doc of [naPlataforma, noAntigo, noIntermediario]) {
      expect(buckets.get('bucket-final')?.get(doc.storageKey)).toEqual(doc.content);
      expect((await documentRow(doc.id)).storage_config_id).toBe(destino);
    }
  });

  it('ignora documentos excluídos e documentos de outra empresa', async () => {
    const destino = await seedTenantStorageConfig({ bucket: 'bucket-destino', active: true });
    const vivo = await seedDocument({ storageConfigId: null });
    const excluido = await seedDocument({ storageConfigId: null, deleted: true });
    const deOutraEmpresa = await seedDocument({
      storageConfigId: null,
      tenantId: OTHER_TENANT_ID,
    });

    const migrationId = await createMigration();
    const summary = await runStorageMigration({ sql, storage, logger, concurrency: 1 }, {
      tenantId: TENANT_ID,
      migrationId,
    });

    expect(summary.total).toBe(1);
    expect((await documentRow(vivo.id)).storage_config_id).toBe(destino);
    // O excluído já teve o binário apagado pelo DELETE — não há o que copiar.
    expect((await documentRow(excluido.id)).storage_config_id).toBeNull();
    expect((await documentRow(deOutraEmpresa.id)).storage_config_id).toBeNull();
  });

  it('encerra em DONE com total_docs = 0 quando não há nada a migrar', async () => {
    const destino = await seedTenantStorageConfig({ bucket: 'bucket-destino', active: true });
    await seedDocument({ storageConfigId: destino });

    const migrationId = await createMigration();
    const summary = await runStorageMigration({ sql, storage, logger }, {
      tenantId: TENANT_ID,
      migrationId,
    });

    expect(summary.outcome).toBe('DONE');
    expect(summary.total).toBe(0);
    expect((await migrationRow(migrationId)).status).toBe('DONE');
  });
});

// ---------------------------------------------------------------------------
// Integridade e ordem das operações
// ---------------------------------------------------------------------------

describe('runStorageMigration — integridade', () => {
  it('conta falha e NÃO comuta o documento cujo SHA-256 diverge do content_hash', async () => {
    const destino = await seedTenantStorageConfig({ bucket: 'bucket-destino', active: true });
    const bom = await seedDocument({ storageConfigId: null });
    const adulterado = await seedDocument({ storageConfigId: null });
    corruptOnGet.add(adulterado.storageKey);

    const migrationId = await createMigration();
    const summary = await runStorageMigration({ sql, storage, logger, concurrency: 1 }, {
      tenantId: TENANT_ID,
      migrationId,
    });

    expect(summary.migrated).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.outcome).toBe('FAILED');

    const row = await migrationRow(migrationId);
    expect(row.failed_docs).toBe(1);
    expect(row.last_error).toContain('content_hash');

    // O documento adulterado permanece na ORIGEM e o arquivo ruim nunca chega
    // ao destino: copiá-lo carregaria a corrupção e o cleanup apagaria o
    // original.
    expect((await documentRow(adulterado.id)).storage_config_id).toBeNull();
    expect(buckets.get('bucket-destino')?.has(adulterado.storageKey)).toBe(false);
    expect((await documentRow(bom.id)).storage_config_id).toBe(destino);
  });

  it('não comuta o documento quando o put no destino falha', async () => {
    await seedTenantStorageConfig({ bucket: 'bucket-destino', active: true });
    const doc = await seedDocument({ storageConfigId: null });
    failOnPut.add(doc.storageKey);

    const migrationId = await createMigration();
    const summary = await runStorageMigration({ sql, storage, logger, concurrency: 1 }, {
      tenantId: TENANT_ID,
      migrationId,
    });

    expect(summary.failed).toBe(1);
    // Comutar antes de ter certeza da cópia criaria um documento apontando para
    // um arquivo que não existe — a única coisa que esta ordem nunca permite.
    expect((await documentRow(doc.id)).storage_config_id).toBeNull();
  });

  it('conta falha quando o arquivo não existe na origem, sem derrubar o restante do lote', async () => {
    const destino = await seedTenantStorageConfig({ bucket: 'bucket-destino', active: true });
    const ausente = await seedDocument({ storageConfigId: null, skipFile: true });
    const presente = await seedDocument({ storageConfigId: null });

    const migrationId = await createMigration();
    const summary = await runStorageMigration({ sql, storage, logger, concurrency: 1 }, {
      tenantId: TENANT_ID,
      migrationId,
    });

    expect(summary.failed).toBe(1);
    expect(summary.migrated).toBe(1);
    expect((await documentRow(ausente.id)).storage_config_id).toBeNull();
    expect((await documentRow(presente.id)).storage_config_id).toBe(destino);
  });
});

// ---------------------------------------------------------------------------
// Retomada e cancelamento
// ---------------------------------------------------------------------------

describe('runStorageMigration — retomada', () => {
  it('retoma sem recopiar o que já passou', async () => {
    const destino = await seedTenantStorageConfig({ bucket: 'bucket-destino', active: true });
    const primeiro = await seedDocument({ storageConfigId: null });
    const segundo = await seedDocument({ storageConfigId: null });
    const terceiro = await seedDocument({ storageConfigId: null });

    // Primeira passada: o segundo e o terceiro falham (equivalente ao processo
    // morrer no meio — a diferença é só que aqui o resultado fica registrado).
    failOnGet.add(segundo.storageKey);
    failOnGet.add(terceiro.storageKey);

    const primeira = await createMigration();
    const resumo1 = await runStorageMigration({ sql, storage, logger, concurrency: 1 }, {
      tenantId: TENANT_ID,
      migrationId: primeira,
    });
    expect(resumo1.total).toBe(3);
    expect(resumo1.migrated).toBe(1);
    expect((await migrationRow(primeira)).status).toBe('FAILED');

    // Segunda passada, com a origem de volta: só o que ficou para trás é
    // selecionado, e o primeiro NÃO é lido de novo.
    failOnGet.clear();
    getCalls.length = 0;
    putCalls.length = 0;

    const segunda = await createMigration();
    const resumo2 = await runStorageMigration({ sql, storage, logger, concurrency: 1 }, {
      tenantId: TENANT_ID,
      migrationId: segunda,
    });

    expect(resumo2.total).toBe(2);
    expect(resumo2.migrated).toBe(2);
    expect(resumo2.outcome).toBe('DONE');
    expect(getCalls.some((call) => call.endsWith(primeiro.storageKey))).toBe(false);
    expect(putCalls).toHaveLength(2);

    for (const doc of [primeiro, segundo, terceiro]) {
      expect((await documentRow(doc.id)).storage_config_id).toBe(destino);
    }
  });

  it('reassume uma migração deixada em RUNNING por uma execução que morreu', async () => {
    // É o que acontece quando o contêiner do worker cai: a linha fica RUNNING e
    // o BullMQ reentrega o job. Os contadores são zerados porque medem ESTA
    // passada sobre o que ainda falta.
    const destino = await seedTenantStorageConfig({ bucket: 'bucket-destino', active: true });
    const doc = await seedDocument({ storageConfigId: null });

    const migrationId = await createMigration();
    await sql`
      UPDATE storage_migrations
      SET status = 'RUNNING', started_at = now(), total_docs = 9, migrated_docs = 7
      WHERE id = ${migrationId}
    `;

    const summary = await runStorageMigration({ sql, storage, logger, concurrency: 1 }, {
      tenantId: TENANT_ID,
      migrationId,
    });

    expect(summary.outcome).toBe('DONE');
    const row = await migrationRow(migrationId);
    expect(row.total_docs).toBe(1);
    expect(row.migrated_docs).toBe(1);
    expect((await documentRow(doc.id)).storage_config_id).toBe(destino);
  });

  it('não faz nada quando a migração já foi cancelada antes do job começar', async () => {
    await seedTenantStorageConfig({ bucket: 'bucket-destino', active: true });
    const doc = await seedDocument({ storageConfigId: null });

    const migrationId = await createMigration();
    await sql`
      UPDATE storage_migrations SET status = 'CANCELLED', finished_at = now() WHERE id = ${migrationId}
    `;

    const summary = await runStorageMigration({ sql, storage, logger }, {
      tenantId: TENANT_ID,
      migrationId,
    });

    expect(summary.outcome).toBe('SKIPPED');
    expect(putCalls).toHaveLength(0);
    // Quem cancelou é a autoridade sobre o estado final — o job não o reescreve.
    expect((await migrationRow(migrationId)).status).toBe('CANCELLED');
    expect((await documentRow(doc.id)).storage_config_id).toBeNull();
  });

  it('para no documento corrente quando é cancelada no meio, sem desfazer o que já migrou', async () => {
    const destino = await seedTenantStorageConfig({ bucket: 'bucket-destino', active: true });
    const docs = await Promise.all([
      seedDocument({ storageConfigId: null }),
      seedDocument({ storageConfigId: null }),
      seedDocument({ storageConfigId: null }),
    ]);

    const migrationId = await createMigration();
    // Cancela assim que o primeiro arquivo chega ao destino.
    afterPut = async () => {
      afterPut = null;
      await sql`
        UPDATE storage_migrations
        SET status = 'CANCELLED', finished_at = now()
        WHERE id = ${migrationId}
      `;
    };

    const summary = await runStorageMigration({ sql, storage, logger, concurrency: 1 }, {
      tenantId: TENANT_ID,
      migrationId,
    });

    expect(summary.outcome).toBe('CANCELLED');
    expect(summary.migrated).toBe(1);

    const row = await migrationRow(migrationId);
    expect(row.status).toBe('CANCELLED');
    expect(row.finished_at).not.toBeNull();

    // O que já migrou permanece migrado; o resto continua servível na origem.
    const comutados = await Promise.all(docs.map((doc) => documentRow(doc.id)));
    expect(comutados.filter((doc) => doc.storage_config_id === destino)).toHaveLength(1);
    expect(comutados.filter((doc) => doc.storage_config_id === null)).toHaveLength(2);
  });
});
