import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';

/**
 * Testes de INVARIANTE DE CATÁLOGO da migration 0017 (épico E-11 / ADR-1),
 * contra um PostgreSQL real (o banco desta execução, migrado pelo globalSetup).
 *
 * Não há código de aplicação sob teste aqui — `tenant_storage_configs` e
 * `storage_migrations` nascem vazias e só passam a ser lidas na T-137/T-150.
 * O que se testa é o próprio DDL: cada constraint existe para fechar um modo
 * de falha concreto, e um `ALTER TABLE` distraído em qualquer migration futura
 * derruba estes testes em vez de derrubar o acervo de um cliente.
 *
 * Os quatro invariantes:
 *   1. no máximo UMA configuração ativa por empresa (o histórico é livre);
 *   2. não existe SharePoint com credenciais de plataforma;
 *   3. um documento NUNCA aponta para a configuração de OUTRA empresa
 *      (FK composta — o teste de isolamento desta tarefa);
 *   4. `storage_config_id IS NULL` (acervo na plataforma) implica
 *      `storage_provider = 's3'`.
 *
 * Mais o comportamento de NULL que a ADR-1 depende: a comparação com a
 * configuração de destino é `IS DISTINCT FROM`, nunca `<>`.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test';

const sql: Sql = postgres(DATABASE_URL);

const TENANT_A = '57012a6e-0000-0000-0000-0000000000a1';
const TENANT_B = '57012a6e-0000-0000-0000-0000000000b2';
const USER_A = '57012a6e-0000-0000-0000-0000000000c3';
const DEPT_A = '57012a6e-0000-0000-0000-0000000000d4';

const CONFIG_A1 = '57012a6e-0000-0000-0000-000000000101';
const CONFIG_A2 = '57012a6e-0000-0000-0000-000000000102';
const CONFIG_B1 = '57012a6e-0000-0000-0000-000000000201';

const DOC_1 = '57012a6e-0000-0000-0000-000000000301';

interface PgError {
  code?: string;
  constraint_name?: string;
}

/** Executa e devolve o erro do Postgres (código + constraint), ou null se passou. */
async function expectPgError(run: () => Promise<unknown>): Promise<PgError> {
  try {
    await run();
  } catch (err: unknown) {
    const { code, constraint_name } = err as PgError;
    return { code, constraint_name };
  }
  throw new Error('esperava violação de constraint, mas o comando foi aceito');
}

interface ConfigOpts {
  provider?: string;
  credentialsSource?: string;
  active?: boolean;
  retiredAt?: Date | null;
}

async function insertConfig(id: string, tenantId: string, opts: ConfigOpts = {}): Promise<void> {
  await sql`
    INSERT INTO tenant_storage_configs (
      id, tenant_id, provider, credentials_source, config, active, retired_at
    ) VALUES (
      ${id}, ${tenantId}, ${opts.provider ?? 's3'}, ${opts.credentialsSource ?? 'tenant'},
      ${sql.json({ bucket: `bucket-${id}` })}, ${opts.active ?? true}, ${opts.retiredAt ?? null}
    )
  `;
}

async function insertDocument(
  id: string,
  opts: { storageConfigId?: string | null; storageProvider?: string } = {},
): Promise<void> {
  await sql`
    INSERT INTO documents (
      id, tenant_id, department_id, filename, original_filename,
      content_hash, size_bytes, mime_type, storage_key, storage_provider,
      storage_config_id, status, uploaded_by_id
    ) VALUES (
      ${id}, ${TENANT_A}, ${DEPT_A}, 'f.pdf', 'f.pdf',
      ${`hash-${id}`}, ${1234}, 'application/pdf', ${`tenants/${TENANT_A}/${id}`},
      ${opts.storageProvider ?? 's3'}, ${opts.storageConfigId ?? null}, 'READY', ${USER_A}
    )
  `;
}

async function cleanup(): Promise<void> {
  await sql`DELETE FROM storage_migrations WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM documents WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM tenant_storage_configs WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM departments WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM users WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM tenants WHERE id IN (${TENANT_A}, ${TENANT_B})`;
}

beforeAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await cleanup();
  await sql`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota)
    VALUES
      (${TENANT_A}, 'Empresa A (storage)', ${1_000_000}, ${10}),
      (${TENANT_B}, 'Empresa B (storage)', ${1_000_000}, ${10})
  `;
  await sql`
    INSERT INTO users (id, tenant_id, email, password_hash, name, role)
    VALUES (${USER_A}, ${TENANT_A}, 'storage-a@test.dev', 'x', 'Ator A', 'TENANT_ADMIN')
  `;
  await sql`
    INSERT INTO departments (id, tenant_id, name, level)
    VALUES (${DEPT_A}, ${TENANT_A}, 'Dept A', 0)
  `;
});

afterAll(async () => {
  await cleanup();
  await sql.end();
});

describe('documents — rename para storage_key', () => {
  it('tem storage_key, storage_provider e storage_config_id; s3_key não existe mais', async () => {
    const rows = await sql<
      { column_name: string; is_nullable: string; column_default: string | null }[]
    >`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'documents'
        AND column_name IN ('s3_key', 'storage_key', 'storage_provider', 'storage_config_id')
      ORDER BY column_name
    `;

    expect(rows.map((r) => r.column_name)).toEqual([
      'storage_config_id',
      'storage_key',
      'storage_provider',
    ]);

    const provider = rows.find((r) => r.column_name === 'storage_provider');
    expect(provider?.is_nullable).toBe('NO');
    expect(provider?.column_default).toContain(`'s3'`);

    // NULLABLE é o que sustenta o zero-backfill: acervo existente = plataforma.
    expect(rows.find((r) => r.column_name === 'storage_config_id')?.is_nullable).toBe('YES');
  });

  it('documento sem configuração (acervo da plataforma) é aceito', async () => {
    await insertDocument(DOC_1);

    const [row] = await sql<{ storage_config_id: string | null }[]>`
      SELECT storage_config_id FROM documents WHERE id = ${DOC_1}
    `;
    expect(row?.storage_config_id).toBeNull();
  });
});

describe('tenant_storage_configs — no máximo uma configuração ativa por empresa', () => {
  it('rejeita uma segunda linha ativa do mesmo tenant', async () => {
    await insertConfig(CONFIG_A1, TENANT_A);

    const err = await expectPgError(() => insertConfig(CONFIG_A2, TENANT_A));

    expect(err.code).toBe('23505');
    expect(err.constraint_name).toBe('uniq_tenant_storage_active');
  });

  it('aceita várias linhas aposentadas do mesmo tenant ao lado da ativa', async () => {
    // O histórico é justamente o ponto da ADR-1: uma empresa que já trocou de
    // destino duas vezes tem documentos em três lugares e precisa das três
    // configurações para conseguir LER o acervo inteiro.
    await insertConfig(CONFIG_A1, TENANT_A, { active: false, retiredAt: new Date() });
    await insertConfig(CONFIG_A2, TENANT_A, { active: false, retiredAt: new Date() });
    await insertConfig(CONFIG_B1, TENANT_A, { active: true });

    const [row] = await sql<{ total: string }[]>`
      SELECT count(*)::text AS total FROM tenant_storage_configs WHERE tenant_id = ${TENANT_A}
    `;
    expect(row?.total).toBe('3');
  });

  it('empresas diferentes têm cada uma a sua configuração ativa', async () => {
    await insertConfig(CONFIG_A1, TENANT_A);
    await insertConfig(CONFIG_B1, TENANT_B);

    const [row] = await sql<{ total: string }[]>`
      SELECT count(*)::text AS total FROM tenant_storage_configs WHERE active
    `;
    expect(row?.total).toBe('2');
  });
});

describe('tenant_storage_configs — não existe SharePoint da plataforma', () => {
  it('rejeita (sharepoint, platform) pelo CHECK', async () => {
    const err = await expectPgError(() =>
      insertConfig(CONFIG_A1, TENANT_A, {
        provider: 'sharepoint',
        credentialsSource: 'platform',
      }),
    );

    expect(err.code).toBe('23514');
    expect(err.constraint_name).toBe('storage_platform_creds_only_s3');
  });

  it('aceita (s3, platform) e (sharepoint, tenant)', async () => {
    await insertConfig(CONFIG_A1, TENANT_A, { provider: 's3', credentialsSource: 'platform' });
    await insertConfig(CONFIG_B1, TENANT_B, {
      provider: 'sharepoint',
      credentialsSource: 'tenant',
    });

    const [row] = await sql<{ total: string }[]>`
      SELECT count(*)::text AS total FROM tenant_storage_configs
    `;
    expect(Number(row?.total)).toBeGreaterThanOrEqual(2);
  });

  it('o CHECK vale também para configuração aposentada', async () => {
    // Uma linha histórica inválida seria igualmente impossível de resolver na
    // hora de ler o acervo antigo — por isso o CHECK não é parcial.
    const err = await expectPgError(() =>
      insertConfig(CONFIG_A1, TENANT_A, {
        provider: 'sharepoint',
        credentialsSource: 'platform',
        active: false,
        retiredAt: new Date(),
      }),
    );

    expect(err.constraint_name).toBe('storage_platform_creds_only_s3');
  });
});

describe('documents — isolamento entre empresas na FK composta', () => {
  it('rejeita apontar para a configuração de OUTRA empresa', async () => {
    // O pior vazamento imaginável no E-11: resolver este driver seria ler o
    // bucket do tenant B com as credenciais do tenant B, servindo o arquivo
    // como se fosse do tenant A. O catálogo impede — não a aplicação.
    await insertConfig(CONFIG_B1, TENANT_B);
    await insertDocument(DOC_1);

    const err = await expectPgError(
      () => sql`
        UPDATE documents SET storage_config_id = ${CONFIG_B1} WHERE id = ${DOC_1}
      `,
    );

    expect(err.code).toBe('23503');
    expect(err.constraint_name).toBe('documents_storage_config_fk');
  });

  it('rejeita INSERT de documento já apontando para configuração de outra empresa', async () => {
    await insertConfig(CONFIG_B1, TENANT_B);

    const err = await expectPgError(() =>
      insertDocument(DOC_1, { storageConfigId: CONFIG_B1 }),
    );

    expect(err.code).toBe('23503');
    expect(err.constraint_name).toBe('documents_storage_config_fk');
  });

  it('aceita a configuração da própria empresa', async () => {
    await insertConfig(CONFIG_A1, TENANT_A, { provider: 'sharepoint' });
    await insertDocument(DOC_1, { storageConfigId: CONFIG_A1, storageProvider: 'sharepoint' });

    const [row] = await sql<{ storage_config_id: string }[]>`
      SELECT storage_config_id FROM documents WHERE id = ${DOC_1}
    `;
    expect(row?.storage_config_id).toBe(CONFIG_A1);
  });

  it('impede apagar uma configuração que ainda tem documento apontando para ela', async () => {
    // É o que garante, na purga (T-142), que os ARQUIVOS sejam apagados antes
    // das credenciais — sem as credenciais eles ficariam inalcançáveis.
    await insertConfig(CONFIG_A1, TENANT_A);
    await insertDocument(DOC_1, { storageConfigId: CONFIG_A1 });

    const err = await expectPgError(
      () => sql`DELETE FROM tenant_storage_configs WHERE id = ${CONFIG_A1}`,
    );

    expect(err.code).toBe('23503');
    expect(err.constraint_name).toBe('documents_storage_config_fk');
  });
});

describe('documents — coerência entre storage_config_id e storage_provider', () => {
  it('rejeita documento sem configuração com provider diferente de s3', async () => {
    const err = await expectPgError(() =>
      insertDocument(DOC_1, { storageConfigId: null, storageProvider: 'sharepoint' }),
    );

    expect(err.code).toBe('23514');
    expect(err.constraint_name).toBe('documents_platform_storage_is_s3');
  });

  it('rejeita comutar o provider sem comutar a configuração', async () => {
    await insertDocument(DOC_1);

    const err = await expectPgError(
      () => sql`
        UPDATE documents SET storage_provider = 'sharepoint' WHERE id = ${DOC_1}
      `,
    );

    expect(err.constraint_name).toBe('documents_platform_storage_is_s3');
  });
});

describe('seleção da migração de acervo — IS DISTINCT FROM, nunca <>', () => {
  it('`<>` perde o documento na plataforma; `IS DISTINCT FROM` o encontra', async () => {
    // Este é o modo de falha que motivou a ADR-1, reproduzido em SQL: com NULL
    // de um dos lados o `<>` devolve NULL, o WHERE descarta a linha e a
    // migração fecha em DONE com total_docs = 0 sem ter copiado nada — e o
    // cleanup-source apaga a origem em seguida.
    await insertConfig(CONFIG_A1, TENANT_A);
    await insertDocument(DOC_1); // acervo da plataforma: storage_config_id NULL

    const comOperadorErrado = await sql<{ id: string }[]>`
      SELECT id FROM documents
      WHERE tenant_id = ${TENANT_A} AND deleted = false
        AND storage_config_id <> ${CONFIG_A1}
    `;
    expect(comOperadorErrado).toHaveLength(0);

    const comOperadorCerto = await sql<{ id: string }[]>`
      SELECT id FROM documents
      WHERE tenant_id = ${TENANT_A} AND deleted = false
        AND storage_config_id IS DISTINCT FROM ${CONFIG_A1}
    `;
    expect(comOperadorCerto.map((r) => r.id)).toEqual([DOC_1]);
  });

  it('destino de volta para a plataforma (NULL) seleciona quem está em outra config', async () => {
    // Simétrico do anterior: agora o NULL está no parâmetro de destino.
    await insertConfig(CONFIG_A1, TENANT_A);
    await insertDocument(DOC_1, { storageConfigId: CONFIG_A1 });

    const destino: string | null = null;
    const selecionados = await sql<{ id: string }[]>`
      SELECT id FROM documents
      WHERE tenant_id = ${TENANT_A} AND deleted = false
        AND storage_config_id IS DISTINCT FROM ${destino}
    `;
    expect(selecionados.map((r) => r.id)).toEqual([DOC_1]);
  });

  it('o índice docs_by_storage_config existe para essa varredura', async () => {
    const rows = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'documents' AND indexname = 'docs_by_storage_config'
    `;
    expect(rows).toHaveLength(1);
  });
});

describe('storage_migrations — uma migração ativa por empresa', () => {
  async function insertMigration(status: string, tenantId = TENANT_A): Promise<void> {
    await sql`
      INSERT INTO storage_migrations (tenant_id, from_provider, to_provider, status)
      VALUES (${tenantId}, 's3', 'sharepoint', ${status})
    `;
  }

  it('rejeita uma segunda migração RUNNING do mesmo tenant', async () => {
    await insertMigration('RUNNING');

    const err = await expectPgError(() => insertMigration('RUNNING'));

    expect(err.code).toBe('23505');
    expect(err.constraint_name).toBe('uniq_storage_migration_running');
  });

  it('rejeita PENDING ao lado de RUNNING (as duas contam como ativas)', async () => {
    await insertMigration('RUNNING');

    const err = await expectPgError(() => insertMigration('PENDING'));

    expect(err.constraint_name).toBe('uniq_storage_migration_running');
  });

  it('migrações encerradas acumulam e não bloqueiam a próxima', async () => {
    await insertMigration('DONE');
    await insertMigration('FAILED');
    await insertMigration('CANCELLED');
    await insertMigration('RUNNING');

    const [row] = await sql<{ total: string }[]>`
      SELECT count(*)::text AS total FROM storage_migrations WHERE tenant_id = ${TENANT_A}
    `;
    expect(row?.total).toBe('4');
  });
});
