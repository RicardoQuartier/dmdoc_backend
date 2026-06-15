import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, type TestDb } from '../test/helpers.js';
import { newId } from '@dmdoc/db-mongo';

/**
 * Testes E2E das rotas de permissões por raiz (ACL, Fase 6).
 *
 * Foco: validação do contrato `{ rootDepartmentIds }` em PUT /users/:id/permissions.
 * Apenas departamentos RAIZ (nível 0, `parentId: null`) podem ser concedidos —
 * conceder um id que existe mas NÃO é raiz retorna 422 VALIDATION_ERROR.
 */

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const ADMIN_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const PASSWORD = 'senha-muito-secreta-123';

let app: FastifyInstance;
let testDb: TestDb;
let adminToken: string;

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
  await testDb.db.collection('departments').deleteMany({});
  await testDb.db.collection('department_permissions').deleteMany({});

  await testDb.db.collection('tenants').insertOne({
    id: TENANT_ID,
    name: 'Empresa A',
    diskQuotaBytes: 10 * 1024 ** 3,
    userQuota: 20,
    active: true,
    createdAt: new Date(),
  });

  await seedUser(testDb.db, {
    id: ADMIN_ID,
    tenantId: TENANT_ID,
    email: 'admin@empresa.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
  });
  await seedUser(testDb.db, {
    id: USER_ID,
    tenantId: TENANT_ID,
    email: 'user@empresa.com',
    password: PASSWORD,
    role: 'USER',
  });

  adminToken = await login('admin@empresa.com');
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

/**
 * Cria uma raiz (nível 0) e um filho (parentId = raiz) no tenant. Devolve os ids.
 */
async function seedRootAndChild(): Promise<{ rootId: string; childId: string }> {
  const rootId = newId();
  const childId = newId();
  await testDb.db.collection('departments').insertMany([
    {
      id: rootId,
      tenantId: TENANT_ID,
      parentId: null,
      name: 'Financeiro (raiz)',
      level: 0,
      tags: [],
      deleted: false,
      createdAt: new Date(),
    },
    {
      id: childId,
      tenantId: TENANT_ID,
      parentId: rootId,
      name: 'Contas a Pagar (filho)',
      level: 1,
      tags: [],
      deleted: false,
      createdAt: new Date(),
    },
  ]);
  return { rootId, childId };
}

describe('PUT /users/:id/permissions — validação de raiz', () => {
  it('departamento existente mas NÃO raiz (parentId != null) → 422 VALIDATION_ERROR', async () => {
    const { childId } = await seedRootAndChild();

    const res = await app.inject({
      method: 'PUT',
      url: `/users/${USER_ID}/permissions`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { rootDepartmentIds: [childId] },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');

    // Nenhuma concessão deve ter sido persistida na rejeição.
    const perms = await testDb.db
      .collection('department_permissions')
      .find({ userId: USER_ID })
      .toArray();
    expect(perms).toHaveLength(0);
  });
});

describe('PUT /users/:id/permissions — caso feliz', () => {
  it('raiz válida → 200 e GET reflete a raiz concedida', async () => {
    const { rootId } = await seedRootAndChild();

    const putRes = await app.inject({
      method: 'PUT',
      url: `/users/${USER_ID}/permissions`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { rootDepartmentIds: [rootId] },
    });

    expect(putRes.statusCode).toBe(200);
    expect(putRes.json().rootDepartmentIds).toEqual([rootId]);

    const getRes = await app.inject({
      method: 'GET',
      url: `/users/${USER_ID}/permissions`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().rootDepartmentIds).toEqual([rootId]);
  });
});
