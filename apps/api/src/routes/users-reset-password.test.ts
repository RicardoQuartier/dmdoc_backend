import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, type TestDb } from '../test/helpers.js';
import { verifyPassword } from '../auth/password.js';
import { AUDIT_LOGS_COLLECTION } from '../auth/audit.js';

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

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

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
  await testDb.db.collection('users').deleteMany({});
  await testDb.db.collection('tenants').deleteMany({});
  await testDb.db.collection(AUDIT_LOGS_COLLECTION).deleteMany({});

  await testDb.db.collection('tenants').insertMany([
    {
      id: TENANT_A,
      name: 'Empresa A',
      diskQuotaBytes: 10 * 1024 ** 3,
      userQuota: 50,
      active: true,
      createdAt: new Date(),
    },
    {
      id: TENANT_B,
      name: 'Empresa B',
      diskQuotaBytes: 10 * 1024 ** 3,
      userQuota: 50,
      active: true,
      createdAt: new Date(),
    },
  ]);

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

    const doc = (await testDb.db
      .collection('users')
      .findOne({ id: UPLOADER_A_ID })) as unknown as { passwordHash: string } | null;
    expect(doc).not.toBeNull();
    // Senha antiga não vale mais; a nova vale.
    expect(await verifyPassword(doc!.passwordHash, NEW_PASSWORD)).toBe(true);
    expect(await verifyPassword(doc!.passwordHash, PASSWORD)).toBe(false);
  });

  it('reset registra um audit log da ação (ator, alvo, tenant)', async () => {
    await resetPassword({ token: tadminAToken, targetId: USER_A_ID });

    const logs = await testDb.db
      .collection(AUDIT_LOGS_COLLECTION)
      .find({ action: 'user.reset_password' })
      .toArray();
    expect(logs).toHaveLength(1);
    const log = logs[0] as unknown as {
      tenantId: string;
      userId: string;
      resource: string;
      metadata: { targetUserId: string };
    };
    expect(log.tenantId).toBe(TENANT_A);
    expect(log.userId).toBe(TADMIN_A_ID);
    expect(log.resource).toBe(`users/${USER_A_ID}`);
    expect(log.metadata.targetUserId).toBe(USER_A_ID);
  });

  it('a nova senha em claro nunca aparece no audit log', async () => {
    await resetPassword({ token: tadminAToken, targetId: USER_A_ID });
    const logs = await testDb.db.collection(AUDIT_LOGS_COLLECTION).find({}).toArray();
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
    const doc = (await testDb.db
      .collection('users')
      .findOne({ id: UPLOADER_A_ID })) as unknown as { passwordHash: string } | null;
    expect(await verifyPassword(doc!.passwordHash, PASSWORD)).toBe(true);
  });
});

describe('POST /users/:id/reset-password — isolamento multi-tenant', () => {
  it('TENANT_ADMIN A resetando senha de usuário do tenant B → 404 (nunca 403)', async () => {
    const res = await resetPassword({ token: tadminAToken, targetId: TADMIN_B_ID });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');

    // Alvo de outro tenant permanece com a senha original.
    const doc = (await testDb.db
      .collection('users')
      .findOne({ id: TADMIN_B_ID })) as unknown as { passwordHash: string } | null;
    expect(await verifyPassword(doc!.passwordHash, PASSWORD)).toBe(true);
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

    const doc = (await testDb.db
      .collection('users')
      .findOne({ id: TADMIN_B_ID })) as unknown as { passwordHash: string } | null;
    expect(await verifyPassword(doc!.passwordHash, NEW_PASSWORD)).toBe(true);
  });
});
