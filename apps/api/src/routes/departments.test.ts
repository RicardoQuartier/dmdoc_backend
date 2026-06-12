import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, type TestDb } from '../test/helpers.js';
import { newId } from '@dmdoc/db-mongo';

/**
 * Testes E2E de exclusão de departamento.
 *
 * Regra de negócio (atual): ao excluir um departamento, apenas o próprio
 * departamento vira `deleted: true`. Documentos e permissões vinculados são
 * PRESERVADOS (continuam `deleted: false`) — assim os documentos já carregados
 * não somem e continuam encontráveis na busca e nas listagens por quem tem
 * `canRead`. A exclusão é bloqueada (409) se houver sub-departamentos ativos.
 */

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const ADMIN_A_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const PASSWORD = 'senha-muito-secreta-123';

let app: FastifyInstance;
let testDb: TestDb;
let tokenA: string;

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
  await testDb.db.collection('documents').deleteMany({});
  await testDb.db.collection('department_permissions').deleteMany({});

  await testDb.db.collection('tenants').insertOne({
    id: TENANT_A,
    name: 'Empresa A',
    diskQuotaBytes: 10 * 1024 ** 3,
    userQuota: 20,
    active: true,
    createdAt: new Date(),
  });

  await seedUser(testDb.db, {
    id: ADMIN_A_ID,
    tenantId: TENANT_A,
    email: 'admin-a@empresa.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
  });

  tokenA = await login('admin-a@empresa.com');
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

describe('DELETE /departments/:id — preserva documentos e permissões', () => {
  it('exclui apenas o departamento; documentos e permissões continuam deleted:false', async () => {
    const deptId = newId();
    const docId = newId();
    const permUserId = newId();

    await testDb.db.collection('departments').insertOne({
      id: deptId,
      tenantId: TENANT_A,
      parentId: null,
      name: 'Financeiro',
      level: 0,
      tags: [],
      deleted: false,
      createdAt: new Date(),
    });

    await testDb.db.collection('documents').insertOne({
      id: docId,
      tenantId: TENANT_A,
      departmentId: deptId,
      filename: 'nota-fiscal.pdf',
      deleted: false,
      createdAt: new Date(),
    });

    await testDb.db.collection('department_permissions').insertOne({
      userId: permUserId,
      departmentId: deptId,
      tenantId: TENANT_A,
      canRead: true,
      canWrite: false,
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/departments/${deptId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(204);

    // (a) o departamento está logicamente excluído
    const dept = await testDb.db.collection('departments').findOne({ id: deptId });
    expect(dept?.deleted).toBe(true);

    // (b) o documento foi PRESERVADO — continua deleted:false e com o departmentId
    const doc = await testDb.db.collection('documents').findOne({ id: docId });
    expect(doc?.deleted).toBe(false);
    expect(doc?.departmentId).toBe(deptId);

    // (c) a permissão foi PRESERVADA — continua presente
    const perm = await testDb.db
      .collection('department_permissions')
      .findOne({ departmentId: deptId, userId: permUserId });
    expect(perm).not.toBeNull();
    expect(perm?.deleted).not.toBe(true);
    expect(perm?.canRead).toBe(true);
  });

  it('bloqueia exclusão (409) quando há sub-departamentos ativos', async () => {
    const parentId = newId();
    const childId = newId();

    await testDb.db.collection('departments').insertMany([
      {
        id: parentId,
        tenantId: TENANT_A,
        parentId: null,
        name: 'Jurídico',
        level: 0,
        tags: [],
        deleted: false,
        createdAt: new Date(),
      },
      {
        id: childId,
        tenantId: TENANT_A,
        parentId,
        name: 'Contratos',
        level: 1,
        tags: [],
        deleted: false,
        createdAt: new Date(),
      },
    ]);

    const res = await app.inject({
      method: 'DELETE',
      url: `/departments/${parentId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');

    // O pai NÃO foi excluído
    const parent = await testDb.db.collection('departments').findOne({ id: parentId });
    expect(parent?.deleted).toBe(false);
  });

  it('departamento inexistente → 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/departments/${newId()}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
