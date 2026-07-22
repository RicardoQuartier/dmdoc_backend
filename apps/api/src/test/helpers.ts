import { createPgClient, type Sql } from '@dmdoc/db-pg';
import { loadConfig, type Config } from '../config.js';
import { hashPassword } from '../auth/password.js';
import type { UserDocument } from '../auth/user-store.js';

/**
 * Config hermética para testes — injeta segredos JWT e DATABASE_URL fixos,
 * sem tocar em `process.env` real. O `DATABASE_URL` aqui é um placeholder:
 * os testes que precisam de banco injetam um `Sql` real via `buildApp({ db })`,
 * então a conexão via config nunca é usada na prática.
 *
 * AWS/S3: placeholders — os testes de upload injetam um mock de S3Service via
 * `buildApp({ s3: mockS3 })`, portanto nunca chamam o SDK real.
 * REDIS_URL: placeholder — os testes injetam `queue: null` em `buildApp`,
 * portanto nunca conectam ao Redis.
 */
export function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: overrides['DATABASE_URL'] ?? 'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test',
    JWT_SECRET: 'test-access-secret',
    JWT_REFRESH_SECRET: 'test-refresh-secret',
    JWT_EXPIRES_IN: '15m',
    JWT_REFRESH_EXPIRES_IN: '7d',
    // AWS/S3 — placeholders; mock injetado via buildApp({ s3: ... })
    AWS_REGION: 'us-east-1',
    AWS_S3_BUCKET: 'test-bucket',
    AWS_ACCESS_KEY_ID: 'test-key-id',
    AWS_SECRET_ACCESS_KEY: 'test-secret-key',
    // Redis — placeholder; queue: null injetado via buildApp
    REDIS_URL: 'redis://placeholder:6379',
    // Rate limit efetivamente desligado nos testes: a suíte E2E dispara centenas
    // de requisições por arquivo numa única instância do app (contador em
    // memória, janela de 60s), o que estouraria o default de 200/min e tornaria
    // os testes dependentes de tempo/ordem. Nenhum teste exercita o rate limit.
    RATE_LIMIT_MAX: '100000000',
    ...overrides,
  });
}

export interface TestDb {
  db: Sql;
  stop: () => Promise<void>;
}

/**
 * Zera TODAS as tabelas de domínio num único `TRUNCATE ... CASCADE`
 * (ordem-independente e FK-safe) e recria o singleton de `platform_settings`.
 *
 * Usado tanto pelo setupFile (limpeza antes de cada arquivo) quanto pelos
 * `beforeEach` dos arquivos que semeiam dados por teste — substitui blocos de
 * `DELETE FROM ...` manuais que, por dependerem de ordem correta de FK, só
 * funcionavam graças a deletes globais de outros arquivos rodando em paralelo.
 */
export async function resetDomainTables(db: Sql): Promise<void> {
  await db.unsafe(`
    TRUNCATE TABLE
      ai_reprocess_batch,
      audit_logs,
      chunks,
      department_permissions,
      department_templates,
      departments,
      document_content,
      document_events,
      document_type_index_fields,
      document_types,
      documents,
      global_type_tenant_depts,
      platform_settings,
      tenants,
      users
    RESTART IDENTITY CASCADE
  `);
  await db`
    INSERT INTO platform_settings (
      ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled
    )
    VALUES (true, true, true)
  `;
}

/**
 * Cria um cliente postgres.js para testes, conectado ao DATABASE_URL de teste.
 * Usa a variável de ambiente TEST_DATABASE_URL se disponível, senão o padrão.
 *
 * Em ambiente CI, uma instância PostgreSQL deve estar rodando.
 */
export async function startTestDb(): Promise<TestDb> {
  const databaseUrl =
    process.env['TEST_DATABASE_URL'] ??
    process.env['DATABASE_URL'] ??
    'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test';

  const db = createPgClient(databaseUrl);

  return {
    db,
    stop: async () => {
      await db.end();
    },
  };
}

/**
 * Compatibilidade com testes que usavam startTestReplSetDb (MongoDB replica set).
 * Agora retorna um cliente PostgreSQL simples (sem necessidade de replica set
 * para transações — PostgreSQL suporta transações em modo standalone).
 */
export interface TestReplSetDb {
  db: Sql;
  stop: () => Promise<void>;
}

export async function startTestReplSetDb(): Promise<TestReplSetDb> {
  return startTestDb();
}

export interface SeedUserInput {
  id: string;
  tenantId: string | null;
  email: string;
  password: string;
  name?: string;
  role?: UserDocument['role'];
  active?: boolean;
  allowedTenantIds?: string[];
}

/**
 * Insere um usuário de teste com hash argon2 REAL (não um placeholder), para
 * exercitar o caminho completo de verify no login.
 */
export async function seedUser(db: Sql, input: SeedUserInput): Promise<UserDocument> {
  const passwordHash = await hashPassword(input.password);
  const now = new Date();
  const role = input.role ?? 'TENANT_ADMIN';
  const name = input.name ?? 'Usuário de Teste';
  const active = input.active ?? true;
  const allowedTenantIds = input.allowedTenantIds ?? null;

  await db`
    INSERT INTO users (id, tenant_id, email, password_hash, name, role, active, allowed_tenant_ids, created_at, deleted)
    VALUES (
      ${input.id},
      ${input.tenantId},
      ${input.email},
      ${passwordHash},
      ${name},
      ${role},
      ${active},
      ${allowedTenantIds}::uuid[],
      ${now},
      false
    )
    ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        password_hash = EXCLUDED.password_hash,
        name = EXCLUDED.name,
        role = EXCLUDED.role,
        active = EXCLUDED.active,
        allowed_tenant_ids = EXCLUDED.allowed_tenant_ids
  `;

  return {
    id: input.id,
    tenantId: input.tenantId,
    email: input.email,
    passwordHash,
    name,
    role,
    active,
    createdAt: now,
    ...(allowedTenantIds !== null ? { allowedTenantIds } : {}),
  };
}
