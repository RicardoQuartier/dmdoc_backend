import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, resetDomainTables, type TestDb } from '../test/helpers.js';
import { verifyPassword } from '../auth/password.js';

/**
 * Testes E2E do reset de senha POR ADMIN (POST /users/:id/reset-password).
 *
 * Cobre:
 *   - sucesso (admin reseta senha de quem pode gerenciar) → 204 + hash regravado
 *   - senha < 8 → 400 (ValidationError de Zod)
 *   - alvo de outro tenant → 404 (isolamento, nunca 403 por tenant)
 *   - alvo que o ator NÃO pode gerenciar (acima na hierarquia) → 403
 *   - audit log da ação registrado
 */

// UUIDs de tenant por arquivo — evita colisão no `dmdoc_test` compartilhado.
const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();

const TADMIN_A_ID = 'b0000000-0000-0000-0000-000000000001';
const UPLOADER_A_ID = 'b0000000-0000-0000-0000-000000000002';
const USER_A_ID = 'b0000000-0000-0000-0000-000000000003';
const TADMIN_B_ID = 'b0000000-0000-0000-0000-000000000004';
const SUPER_ADMIN_ID = 'b0000000-0000-0000-0000-000000000005';

const PASSWORD = 'senha-muito-secreta-123';
const NEW_PASSWORD = 'nova-senha-bem-grande-99';

let app: FastifyInstance;
let testDb: TestDb;

let tadminAToken: string;
let uploaderAToken: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = await buildApp({ config: testConfig(), db: testDb.db });
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(async () => {
  await resetDomainTables(testDb.db);

  await testDb.db`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
    VALUES
      (${TENANT_A}, 'Empresa A', ${10 * 1024 ** 3}, 50, true, NOW()),
      (${TENANT_B}, 'Empresa B', ${10 * 1024 ** 3}, 50, true, NOW())
    ON CONFLICT (id) DO NOTHING
  `;

  await seedUser(testDb.db, {
    id: SUPER_ADMIN_ID,
    tenantId: null,
    email: 'super@plataforma.com',
    password: PASSWORD,
    role: 'SUPER_ADMIN',
  });
  await seedUser(testDb.db, {
    id: TADMIN_A_ID,
    tenantId: TENANT_A,
    email: 'tadmin-a@empresa.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
  });
  await seedUser(testDb.db, {
    id: UPLOADER_A_ID,
    tenantId: TENANT_A,
    email: 'uploader-a@empresa.com',
    password: PASSWORD,
    role: 'UPLOADER',
  });
  await seedUser(testDb.db, {
    id: USER_A_ID,
    tenantId: TENANT_A,
    email: 'user-a@empresa.com',
    password: PASSWORD,
    role: 'USER',
  });
  await seedUser(testDb.db, {
    id: TADMIN_B_ID,
    tenantId: TENANT_B,
    email: 'tadmin-b@empresa.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
  });

  tadminAToken = await login('tadmin-a@empresa.com');
  uploaderAToken = await login('uploader-a@empresa.com');

  // Limpar audit logs gerados pelos logins
  await testDb.db`DELETE FROM audit_logs`;
});

async function login(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return res.json().accessToken as string;
}

function resetPassword(opts: {
  token: string;
  targetId: string;
  newPassword?: unknown;
  tenantId?: string;
}) {
  let url = `/users/${opts.targetId}/reset-password`;
  if (opts.tenantId !== undefined) url += `?tenantId=${opts.tenantId}`;
  return app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${opts.token}` },
    payload: { newPassword: opts.newPassword ?? NEW_PASSWORD },
  });
}

describe('POST /users/:id/reset-password — sucesso', () => {
  it('TENANT_ADMIN reseta a senha de um UPLOADER do próprio tenant → 204 e hash regravado', async () => {
    const res = await resetPassword({ token: tadminAToken, targetId: UPLOADER_A_ID });
    expect(res.statusCode).toBe(204);

    const rows = await testDb.db<Array<{ password_hash: string }>>`
      SELECT password_hash FROM users WHERE id = ${UPLOADER_A_ID}
    `;
    expect(rows).toHaveLength(1);
    // Senha antiga não vale mais; a nova vale.
    expect(await verifyPassword(rows[0]!.password_hash, NEW_PASSWORD)).toBe(true);
    expect(await verifyPassword(rows[0]!.password_hash, PASSWORD)).toBe(false);
  });

  it('reset registra um audit log da ação (ator, alvo, tenant)', async () => {
    await resetPassword({ token: tadminAToken, targetId: USER_A_ID });

    const logs = await testDb.db<Array<{
      tenant_id: string;
      user_id: string;
      action: string;
      resource: string;
      metadata: Record<string, unknown>;
    }>>`SELECT * FROM audit_logs WHERE action = 'user.reset_password'`;

    expect(logs).toHaveLength(1);
    const log = logs[0]!;
    expect(log.tenant_id).toBe(TENANT_A);
    expect(log.user_id).toBe(TADMIN_A_ID);
    expect(log.resource).toBe(`users/${USER_A_ID}`);
    // postgres.js devolve jsonb como string crua — parseia antes de inspecionar.
    const metadata = (
      typeof log.metadata === 'string' ? JSON.parse(log.metadata) : log.metadata
    ) as { targetUserId?: string };
    expect(metadata['targetUserId']).toBe(USER_A_ID);
  });

  it('a nova senha em claro nunca aparece no audit log', async () => {
    await resetPassword({ token: tadminAToken, targetId: USER_A_ID });
    const logs = await testDb.db`SELECT * FROM audit_logs`;
    expect(JSON.stringify(logs)).not.toContain(NEW_PASSWORD);
  });
});

describe('POST /users/:id/reset-password — validação', () => {
  it('senha com menos de 8 caracteres → 422 (Zod)', async () => {
    const res = await resetPassword({
      token: tadminAToken,
      targetId: UPLOADER_A_ID,
      newPassword: 'curta',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');

    // Senha original permanece intacta.
    const rows = await testDb.db<Array<{ password_hash: string }>>`
      SELECT password_hash FROM users WHERE id = ${UPLOADER_A_ID}
    `;
    expect(await verifyPassword(rows[0]!.password_hash, PASSWORD)).toBe(true);
  });
});

describe('POST /users/:id/reset-password — isolamento multi-tenant', () => {
  it('TENANT_ADMIN A resetando senha de usuário do tenant B → 404 (nunca 403)', async () => {
    const res = await resetPassword({ token: tadminAToken, targetId: TADMIN_B_ID });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');

    // Alvo de outro tenant permanece com a senha original.
    const rows = await testDb.db<Array<{ password_hash: string }>>`
      SELECT password_hash FROM users WHERE id = ${TADMIN_B_ID}
    `;
    expect(await verifyPassword(rows[0]!.password_hash, PASSWORD)).toBe(true);
  });
});

describe('POST /users/:id/reset-password — hierarquia', () => {
  it('UPLOADER (não-admin) não pode resetar senha de ninguém → 403', async () => {
    // Gate base de gestão (requireRole(...ADMIN_ROLES)): UPLOADER/USER nunca
    // gerenciam — é a forma de "alvo que o ator não pode gerenciar" disponível
    // dentro de um único tenant.
    const res = await resetPassword({ token: uploaderAToken, targetId: USER_A_ID });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('SUPER_ADMIN reseta a senha de qualquer usuário, em qualquer tenant → 204', async () => {
    const superToken = await login('super@plataforma.com');
    const res = await resetPassword({
      token: superToken,
      targetId: TADMIN_B_ID,
      tenantId: TENANT_B,
    });
    expect(res.statusCode).toBe(204);

    const rows = await testDb.db<Array<{ password_hash: string }>>`
      SELECT password_hash FROM users WHERE id = ${TADMIN_B_ID}
    `;
    expect(await verifyPassword(rows[0]!.password_hash, NEW_PASSWORD)).toBe(true);
  });
});
