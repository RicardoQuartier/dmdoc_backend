import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, type TestDb } from '../test/helpers.js';
import { newId } from '@dmdoc/db-pg';

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
  await testDb.db`DELETE FROM audit_logs`;
  await testDb.db`DELETE FROM department_permissions`;
  await testDb.db`DELETE FROM departments`;
  await testDb.db`DELETE FROM users WHERE tenant_id IS NOT NULL OR role IN ('TENANT_ADMIN','USER')`;
  await testDb.db`DELETE FROM tenants WHERE id = ${TENANT_ID}`;

  await testDb.db`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
    VALUES (${TENANT_ID}, 'Empresa A', ${10 * 1024 ** 3}, 20, true, NOW())
    ON CONFLICT (id) DO NOTHING
  `;

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
  await testDb.db`
    INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
    VALUES
      (${rootId}, ${TENANT_ID}, NULL, 'Financeiro (raiz)', 0, '{}'::text[], false, NOW()),
      (${childId}, ${TENANT_ID}, ${rootId}, 'Contas a Pagar (filho)', 1, '{}'::text[], false, NOW())
  `;
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
    const rows = await testDb.db`SELECT id FROM department_permissions WHERE user_id = ${USER_ID}`;
    expect(rows).toHaveLength(0);
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

  it('adicionar uma raiz reenviando a já concedida → 200 (não colide com linha soft-deletada)', async () => {
    const { rootId: rootAId } = await seedRootAndChild();
    const rootBId = newId();
    await testDb.db`
      INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
      VALUES (${rootBId}, ${TENANT_ID}, NULL, 'RH (raiz)', 0, '{}'::text[], false, NOW())
    `;

    // Concessão inicial: apenas a raiz A.
    const first = await app.inject({
      method: 'PUT',
      url: `/users/${USER_ID}/permissions`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { rootDepartmentIds: [rootAId] },
    });
    expect(first.statusCode).toBe(200);

    // Agora adiciona a raiz B mantendo a A — reenvia a A já concedida.
    // Antes do fix isto batia em 23505 (uniq_dept_perm_user_dept).
    const second = await app.inject({
      method: 'PUT',
      url: `/users/${USER_ID}/permissions`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { rootDepartmentIds: [rootAId, rootBId] },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().rootDepartmentIds).toEqual(
      expect.arrayContaining([rootAId, rootBId]),
    );
    expect(second.json().rootDepartmentIds).toHaveLength(2);

    // Remove a A e mantém a B — a A deve voltar a ficar soft-deletada.
    const third = await app.inject({
      method: 'PUT',
      url: `/users/${USER_ID}/permissions`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { rootDepartmentIds: [rootBId] },
    });
    expect(third.statusCode).toBe(200);
    expect(third.json().rootDepartmentIds).toEqual([rootBId]);
  });
});
