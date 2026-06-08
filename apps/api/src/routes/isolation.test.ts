import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, type TestDb } from '../test/helpers.js';
import { newId } from '@dmdoc/db-mongo';

/**
 * Testes E2E de isolamento multi-tenant.
 *
 * Verifica que recursos de tenant A são completamente invisíveis para tenant B:
 * toda operação cross-tenant retorna 404, nunca 403 ou o recurso real.
 */

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

const USER_A_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ADMIN_A_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ADMIN_B_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const PASSWORD = 'senha-muito-secreta-123';

let app: FastifyInstance;
let testDb: TestDb;
let tokenA: string;
let tokenB: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = await buildApp({ config: testConfig(), db: testDb.db });
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(async () => {
  // Limpa todas as coleções relevantes
  await testDb.db.collection('users').deleteMany({});
  await testDb.db.collection('tenants').deleteMany({});
  await testDb.db.collection('departments').deleteMany({});
  await testDb.db.collection('document_types').deleteMany({});
  await testDb.db.collection('department_permissions').deleteMany({});

  // Cria dois tenants
  await testDb.db.collection('tenants').insertMany([
    { id: TENANT_A, name: 'Empresa A', diskQuotaBytes: 10 * 1024 ** 3, userQuota: 20, active: true, createdAt: new Date() },
    { id: TENANT_B, name: 'Empresa B', diskQuotaBytes: 10 * 1024 ** 3, userQuota: 20, active: true, createdAt: new Date() },
  ]);

  // Cria admin e usuário em cada tenant
  await seedUser(testDb.db, {
    id: ADMIN_A_ID,
    tenantId: TENANT_A,
    email: 'admin-a@empresa.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
  });
  await seedUser(testDb.db, {
    id: USER_A_ID,
    tenantId: TENANT_A,
    email: 'user-a@empresa.com',
    password: PASSWORD,
    role: 'USER',
  });
  await seedUser(testDb.db, {
    id: ADMIN_B_ID,
    tenantId: TENANT_B,
    email: 'admin-b@empresa.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
  });
  await seedUser(testDb.db, {
    id: USER_B_ID,
    tenantId: TENANT_B,
    email: 'user-b@empresa.com',
    password: PASSWORD,
    role: 'USER',
  });

  // Obtém tokens para cada admin
  tokenA = await login('admin-a@empresa.com');
  tokenB = await login('admin-b@empresa.com');
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

describe('Isolamento multi-tenant — GET /users', () => {
  it('tenant A não enxerga usuários do tenant B', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/users',
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ids = body.items.map((u: { id: string }) => u.id);

    // Admin A vê seus próprios usuários
    expect(ids).toContain(ADMIN_A_ID);
    expect(ids).toContain(USER_A_ID);

    // Admin A NÃO vê usuários do tenant B
    expect(ids).not.toContain(ADMIN_B_ID);
    expect(ids).not.toContain(USER_B_ID);
  });
});

describe('Isolamento multi-tenant — PATCH /users/:id', () => {
  it('tenant A tentando atualizar usuário do tenant B → 404', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${USER_B_ID}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: 'Tentativa Cross-Tenant' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('Isolamento multi-tenant — DELETE /departments/:id', () => {
  it('tenant A tentando deletar departamento do tenant B → 404', async () => {
    // Cria departamento no tenant B
    const deptId = newId();
    await testDb.db.collection('departments').insertOne({
      id: deptId,
      tenantId: TENANT_B,
      parentId: null,
      name: 'Dept do Tenant B',
      level: 0,
      tags: [],
      deleted: false,
      createdAt: new Date(),
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/departments/${deptId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('Isolamento multi-tenant — PATCH /document-types/:id', () => {
  it('tenant A tentando atualizar tipo de documento do tenant B → 404', async () => {
    // Cria tipo no tenant B
    const docTypeId = newId();
    await testDb.db.collection('document_types').insertOne({
      id: docTypeId,
      tenantId: TENANT_B,
      name: 'Tipo do Tenant B',
      description: null,
      isGlobal: false,
      deleted: false,
      createdAt: new Date(),
      indexFields: [],
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/document-types/${docTypeId}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: 'Tentativa Cross-Tenant' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('Isolamento multi-tenant — PUT /users/:id/permissions', () => {
  it('tenant A tentando atribuir permissão com departmentId de outro tenant → 404', async () => {
    // Cria departamento no tenant B
    const deptId = newId();
    await testDb.db.collection('departments').insertOne({
      id: deptId,
      tenantId: TENANT_B,
      parentId: null,
      name: 'Dept do Tenant B',
      level: 0,
      tags: [],
      deleted: false,
      createdAt: new Date(),
    });

    // Admin A tenta dar permissão ao usuário A num departamento de B
    const res = await app.inject({
      method: 'PUT',
      url: `/users/${USER_A_ID}/permissions`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        permissions: [{ departmentId: deptId, canRead: true, canWrite: false }],
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
