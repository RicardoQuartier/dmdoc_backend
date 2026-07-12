import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, resetDomainTables, type TestDb } from '../test/helpers.js';
import { newId } from '@dmdoc/db-pg';

/**
 * Tratamento fail-loud no POST /users (criação), espelhando o do PATCH.
 *
 * `CreateUserBodySchema` é `.strict()` (rejeita chave desconhecida) e o handler
 * tem uma guarda explícita para `departmentPermissions`, apontando para o caminho
 * canônico PUT /users/:id/permissions (aplicado após criar). Ambos → 422
 * VALIDATION_ERROR, sem criar o usuário.
 *
 * Cobre também a regressão do caminho feliz (criação válida) → 201 e persistência.
 */

// UUID de tenant por arquivo — evita colisão no `dmdoc_test` compartilhado.
const TENANT_ID = crypto.randomUUID();
const ADMIN_ID = 'f1111111-1111-1111-1111-111111111111';

const PASSWORD = 'senha-muito-secreta-123';
const NEW_USER_PASSWORD = 'senha-do-novo-usuario-123';

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
    email: 'admin-post@empresa.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
  });

  adminToken = await login('admin-post@empresa.com');
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

function createUser(body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/users',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: body,
  });
}

function validBody(email: string): Record<string, unknown> {
  return {
    email,
    name: 'Novo Usuário',
    role: 'USER',
    password: NEW_USER_PASSWORD,
  };
}

describe('POST /users — departmentPermissions é rejeitado na criação', () => {
  it('corpo com departmentPermissions → 422 VALIDATION_ERROR e usuário NÃO é criado', async () => {
    const email = 'nao-deve-existir@empresa.com';
    const res = await createUser({
      ...validBody(email),
      departmentPermissions: [{ departmentId: newId(), canRead: true, canWrite: true }],
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');

    // Nenhum usuário criado com esse e-mail.
    const users = await testDb.db`SELECT id FROM users WHERE email = ${email}`;
    expect(users).toHaveLength(0);

    // E nenhuma permissão gravada.
    const perms = await testDb.db`SELECT id FROM department_permissions WHERE tenant_id = ${TENANT_ID}`;
    expect(perms).toHaveLength(0);
  });
});

describe('POST /users — .strict() rejeita qualquer chave desconhecida', () => {
  it('campo desconhecido arbitrário → 422 VALIDATION_ERROR e usuário NÃO é criado', async () => {
    const email = 'campo-extra@empresa.com';
    const res = await createUser({ ...validBody(email), campoInexistente: 'x' });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');

    const users = await testDb.db`SELECT id FROM users WHERE email = ${email}`;
    expect(users).toHaveLength(0);
  });
});

describe('POST /users — regressão do caminho válido', () => {
  it('corpo válido → 201 e persiste', async () => {
    const email = 'valido@empresa.com';
    const res = await createUser(validBody(email));

    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created.email).toBe(email);
    expect(created.role).toBe('USER');
    expect(created.passwordHash).toBeUndefined();

    const rows = await testDb.db<Array<{ email: string; tenant_id: string; role: string }>>`
      SELECT email, tenant_id, role FROM users WHERE email = ${email} AND deleted = false
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id).toBe(TENANT_ID);
    expect(rows[0]!.role).toBe('USER');
  });
});
