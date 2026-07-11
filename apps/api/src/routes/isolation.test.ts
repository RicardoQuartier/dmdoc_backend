import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, resetDomainTables, type TestDb } from '../test/helpers.js';
import { newId } from '@dmdoc/db-pg';

/**
 * Testes E2E de isolamento multi-tenant.
 *
 * Verifica que recursos de tenant A são completamente invisíveis para tenant B:
 * toda operação cross-tenant retorna 404, nunca 403 ou o recurso real.
 */

// UUIDs de tenant por arquivo — evita colisão no `dmdoc_test` compartilhado.
const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();

const USER_A_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ADMIN_A_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ADMIN_B_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const PASSWORD = 'senha-muito-secreta-123';

let app: FastifyInstance;
let testDb: TestDb;
let tokenA: string;
let _tokenB: string;

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

  // Cria dois tenants
  await testDb.db`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
    VALUES
      (${TENANT_A}, 'Empresa A', ${10 * 1024 ** 3}, 20, true, NOW()),
      (${TENANT_B}, 'Empresa B', ${10 * 1024 ** 3}, 20, true, NOW())
    ON CONFLICT (id) DO NOTHING
  `;

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
  _tokenB = await login('admin-b@empresa.com');
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

describe('Isolamento multi-tenant — GET /departments', () => {
  it('tenant A não enxerga departamentos do tenant B', async () => {
    const deptIdA = newId();
    const deptIdB = newId();

    await testDb.db`
      INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
      VALUES
        (${deptIdA}, ${TENANT_A}, NULL, 'Dept do Tenant A', 0, '{}'::text[], false, NOW()),
        (${deptIdB}, ${TENANT_B}, NULL, 'Dept do Tenant B', 0, '{}'::text[], false, NOW())
    `;

    const res = await app.inject({
      method: 'GET',
      url: '/departments',
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(200);
    const items = res.json() as Array<{ id: string; tenantId: string }>;

    const ids = items.map((d) => d.id);
    expect(ids).toContain(deptIdA);
    expect(ids).not.toContain(deptIdB);

    // Todos os registros devolvidos devem ser do tenant A
    expect(items.every((d) => d.tenantId === TENANT_A)).toBe(true);
  });
});

describe('Isolamento multi-tenant — DELETE /departments/:id', () => {
  it('tenant A tentando deletar departamento do tenant B → 404', async () => {
    // Cria departamento no tenant B
    const deptId = newId();
    await testDb.db`
      INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
      VALUES (${deptId}, ${TENANT_B}, NULL, 'Dept do Tenant B', 0, '{}'::text[], false, NOW())
    `;

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
    await testDb.db`
      INSERT INTO document_types (id, tenant_id, name, description, is_global, deleted, created_at, index_fields)
      VALUES (${docTypeId}, ${TENANT_B}, 'Tipo do Tenant B', NULL, false, false, NOW(), '[]'::jsonb)
    `;

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
    await testDb.db`
      INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
      VALUES (${deptId}, ${TENANT_B}, NULL, 'Dept do Tenant B', 0, '{}'::text[], false, NOW())
    `;

    // Admin A tenta dar permissão ao usuário A numa raiz de B
    const res = await app.inject({
      method: 'PUT',
      url: `/users/${USER_A_ID}/permissions`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        rootDepartmentIds: [deptId],
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
