import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, resetDomainTables, type TestDb } from '../test/helpers.js';
import { newId } from '@dmdoc/db-pg';

/**
 * Regressão do bug: PATCH /users/:id com `departmentPermissions` no corpo
 * respondia 200 mas NÃO persistia nada — perda silenciosa de dados.
 *
 * Correção: `PatchUserBodySchema` é `.strict()` (rejeita chave desconhecida) e o
 * handler tem uma guarda explícita para `departmentPermissions`, apontando para o
 * caminho canônico PUT /users/:id/permissions. Ambos os caminhos → 422
 * VALIDATION_ERROR, sem gravar em `department_permissions`.
 *
 * Cobre também a regressão do caminho feliz (name/active) → 200 e persistência.
 */

// UUID de tenant por arquivo — evita colisão no `dmdoc_test` compartilhado.
const TENANT_ID = crypto.randomUUID();
const ADMIN_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const USER_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

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
  await resetDomainTables(testDb.db);

  await testDb.db`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
    VALUES (${TENANT_ID}, 'Empresa A', ${10 * 1024 ** 3}, 20, true, NOW())
    ON CONFLICT (id) DO NOTHING
  `;

  await seedUser(testDb.db, {
    id: ADMIN_ID,
    tenantId: TENANT_ID,
    email: 'admin-patch@empresa.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
  });
  await seedUser(testDb.db, {
    id: USER_ID,
    tenantId: TENANT_ID,
    email: 'user-patch@empresa.com',
    password: PASSWORD,
    role: 'USER',
    name: 'Nome Original',
  });

  adminToken = await login('admin-patch@empresa.com');
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

function patchUser(body: Record<string, unknown>) {
  return app.inject({
    method: 'PATCH',
    url: `/users/${USER_ID}`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: body,
  });
}

describe('PATCH /users/:id — departmentPermissions é rejeitado (bug de perda silenciosa)', () => {
  it('corpo com departmentPermissions → 422 VALIDATION_ERROR e nenhuma permissão gravada', async () => {
    const res = await patchUser({
      departmentPermissions: [{ departmentId: newId(), canRead: true, canWrite: true }],
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');

    // Nenhuma linha deve ter sido criada em department_permissions para o alvo.
    const rows = await testDb.db`
      SELECT id FROM department_permissions WHERE user_id = ${USER_ID}
    `;
    expect(rows).toHaveLength(0);

    // E o GET oficial de permissões continua vazio.
    const getRes = await app.inject({
      method: 'GET',
      url: `/users/${USER_ID}/permissions`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().rootDepartmentIds).toEqual([]);
  });

  it('corpo misto (name válido + departmentPermissions) → 422 e o name NÃO é persistido', async () => {
    const res = await patchUser({
      name: 'Nome Que Nao Deve Persistir',
      departmentPermissions: [{ departmentId: newId(), canRead: true, canWrite: true }],
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');

    const rows = await testDb.db<Array<{ name: string }>>`
      SELECT name FROM users WHERE id = ${USER_ID}
    `;
    expect(rows[0]!.name).toBe('Nome Original');
  });
});

describe('PATCH /users/:id — .strict() rejeita qualquer chave desconhecida', () => {
  it('campo desconhecido arbitrário → 422 VALIDATION_ERROR', async () => {
    const res = await patchUser({ campoInexistente: 'x' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PATCH /users/:id — regressão do caminho válido', () => {
  it('name válido → 200 e persiste', async () => {
    const res = await patchUser({ name: 'Novo Nome' });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Novo Nome');

    const rows = await testDb.db<Array<{ name: string }>>`
      SELECT name FROM users WHERE id = ${USER_ID}
    `;
    expect(rows[0]!.name).toBe('Novo Nome');
  });

  it('active=false → 200 e persiste', async () => {
    const res = await patchUser({ active: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().active).toBe(false);

    const rows = await testDb.db<Array<{ active: boolean }>>`
      SELECT active FROM users WHERE id = ${USER_ID}
    `;
    expect(rows[0]!.active).toBe(false);
  });
});
