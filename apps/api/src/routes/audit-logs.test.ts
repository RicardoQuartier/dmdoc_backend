import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, type TestDb } from '../test/helpers.js';
import type { S3Service } from '../services/s3.js';

// ---------------------------------------------------------------------------
// Mock S3
// ---------------------------------------------------------------------------
function createMockS3(): S3Service {
  return {
    uploadFile: async () => undefined,
    getSignedDownloadUrl: async () => 'https://mock',
    deleteFile: async () => undefined,
  } as unknown as S3Service;
}

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------
const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const ADMIN_A_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ADMIN_B_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SUPER_ADMIN_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const USER_A_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const PASSWORD = 'senha-forte-de-teste-456';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
let app: FastifyInstance;
let testDb: TestDb;
let tokenAdminA: string;
let _tokenAdminB: string;
let tokenSuperAdmin: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = await buildApp({
    config: testConfig(),
    db: testDb.db,
    queue: null,
    s3: createMockS3(),
  });
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(async () => {
  // Limpar coleções
  await testDb.db.collection('users').deleteMany({});
  await testDb.db.collection('tenants').deleteMany({});

  // Inserir tenants
  await testDb.db.collection('tenants').insertMany([
    { id: TENANT_A, name: 'Empresa A', diskQuotaBytes: 10 * 1024 * 1024, userQuota: 10, active: true },
    { id: TENANT_B, name: 'Empresa B', diskQuotaBytes: 10 * 1024 * 1024, userQuota: 10, active: true },
  ]);

  // Inserir usuários
  await seedUser(testDb.db, {
    id: ADMIN_A_ID, tenantId: TENANT_A, email: 'admin-a@test.com',
    password: PASSWORD, role: 'TENANT_ADMIN',
  });
  await seedUser(testDb.db, {
    id: ADMIN_B_ID, tenantId: TENANT_B, email: 'admin-b@test.com',
    password: PASSWORD, role: 'TENANT_ADMIN',
  });
  await seedUser(testDb.db, {
    id: SUPER_ADMIN_ID, tenantId: null, email: 'super@test.com',
    password: PASSWORD, role: 'SUPER_ADMIN',
  });

  // Obter tokens via login
  const loginA = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email: 'admin-a@test.com', password: PASSWORD },
  });
  tokenAdminA = (loginA.json() as { accessToken: string }).accessToken;

  const loginB = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email: 'admin-b@test.com', password: PASSWORD },
  });
  _tokenAdminB = (loginB.json() as { accessToken: string }).accessToken;

  const loginSA = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email: 'super@test.com', password: PASSWORD },
  });
  tokenSuperAdmin = (loginSA.json() as { accessToken: string }).accessToken;

  // Limpar audit_logs APÓS os logins (os logins geram audit logs de auth.login
  // que não devem interferir nos testes dos endpoints de auditoria)
  await testDb.db.collection('audit_logs').deleteMany({});
});

// ---------------------------------------------------------------------------
// Helper: inserir audit log diretamente no banco
// ---------------------------------------------------------------------------
async function insertAuditLog(
  tenantId: string,
  action: string,
  userId: string | null = null,
  createdAt: Date = new Date()
): Promise<void> {
  await testDb.db.collection('audit_logs').insertOne({
    tenantId,
    userId,
    action,
    resource: `test/resource`,
    metadata: {},
    createdAt,
  });
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

describe('GET /audit-logs', () => {
  it('retorna 401 sem token', async () => {
    const res = await app.inject({ method: 'GET', url: '/audit-logs' });
    expect(res.statusCode).toBe(401);
  });

  it('retorna 403 para USER role', async () => {
    await seedUser(testDb.db, {
      id: USER_A_ID, tenantId: TENANT_A, email: 'user-a@test.com',
      password: PASSWORD, role: 'USER',
    });
    const loginUser = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'user-a@test.com', password: PASSWORD },
    });
    const tokenUser = (loginUser.json() as { accessToken: string }).accessToken;

    const res = await app.inject({
      method: 'GET', url: '/audit-logs',
      headers: { authorization: `Bearer ${tokenUser}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('TENANT_ADMIN vê apenas os logs do próprio tenant', async () => {
    await insertAuditLog(TENANT_A, 'document.upload');
    await insertAuditLog(TENANT_A, 'auth.login');
    await insertAuditLog(TENANT_B, 'document.upload');

    const res = await app.inject({
      method: 'GET', url: '/audit-logs',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[]; total: number };
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
  });

  it('filtra por action', async () => {
    await insertAuditLog(TENANT_A, 'document.upload');
    await insertAuditLog(TENANT_A, 'auth.login');

    const res = await app.inject({
      method: 'GET', url: '/audit-logs?action=auth.login',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { action: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]?.action).toBe('auth.login');
  });

  it('filtra por intervalo de datas', async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    await insertAuditLog(TENANT_A, 'document.upload', null, yesterday);
    await insertAuditLog(TENANT_A, 'auth.login', null, now);
    await insertAuditLog(TENANT_A, 'document.delete', null, tomorrow);

    const from = new Date(now.getTime() - 1000).toISOString();
    const to = new Date(now.getTime() + 1000).toISOString();

    const res = await app.inject({
      method: 'GET', url: `/audit-logs?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[]; total: number };
    expect(body.total).toBe(1);
  });

  it('paginação por cursor funciona', async () => {
    // Inserir 5 logs em ordem crescente de data
    for (let i = 0; i < 5; i++) {
      await insertAuditLog(TENANT_A, `action.${i}`, null, new Date(2026, 0, i + 1));
    }

    // Página 1: limit=3, ordenado DESC → actions 4, 3, 2
    const res1 = await app.inject({
      method: 'GET', url: '/audit-logs?limit=3',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(res1.statusCode).toBe(200);
    const body1 = res1.json() as { items: { action: string }[]; nextCursor: string | null; total: number };
    expect(body1.items).toHaveLength(3);
    expect(body1.nextCursor).not.toBeNull();
    expect(body1.total).toBe(5);

    // Página 2: com cursor → actions 1, 0
    const res2 = await app.inject({
      method: 'GET', url: `/audit-logs?limit=3&cursor=${body1.nextCursor}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(res2.statusCode).toBe(200);
    const body2 = res2.json() as { items: unknown[]; nextCursor: string | null };
    expect(body2.items).toHaveLength(2);
    expect(body2.nextCursor).toBeNull();
  });

  it('SUPER_ADMIN sem tenantId retorna 409', async () => {
    const res = await app.inject({
      method: 'GET', url: '/audit-logs',
      headers: { authorization: `Bearer ${tokenSuperAdmin}` },
    });
    expect(res.statusCode).toBe(409);
  });

  it('SUPER_ADMIN com ?tenantId vê logs do tenant especificado', async () => {
    await insertAuditLog(TENANT_A, 'document.upload');
    await insertAuditLog(TENANT_B, 'document.upload');

    const res = await app.inject({
      method: 'GET', url: `/audit-logs?tenantId=${TENANT_A}`,
      headers: { authorization: `Bearer ${tokenSuperAdmin}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { total: number };
    expect(body.total).toBe(1);
  });

  it('TENANT_ADMIN não vê logs de outro tenant mesmo com ?tenantId forçado', async () => {
    await insertAuditLog(TENANT_B, 'document.upload');

    // Admin do tenant A tenta ver logs do tenant B via ?tenantId
    const res = await app.inject({
      method: 'GET', url: `/audit-logs?tenantId=${TENANT_B}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    // resolveTenantId ignora o param para não-SUPER_ADMIN → vê apenas TENANT_A (0 logs)
    expect(res.statusCode).toBe(200);
    const body = res.json() as { total: number };
    expect(body.total).toBe(0);
  });

  it('resposta não contém _id interno do MongoDB', async () => {
    await insertAuditLog(TENANT_A, 'document.upload');

    const res = await app.inject({
      method: 'GET', url: '/audit-logs',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Record<string, unknown>[] };
    expect(body.items[0]).not.toHaveProperty('_id');
  });
});
