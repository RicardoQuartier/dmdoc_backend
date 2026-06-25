import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, type TestDb } from '../test/helpers.js';

/**
 * Testes E2E da hierarquia de papéis (spec §5.1).
 *
 * Matriz "quem cria/promove quem" segundo a regra "inferior ou igual"
 * (canManageRole = ROLE_LEVEL[ator] >= ROLE_LEVEL[alvo]):
 *
 *   SUPER_ADMIN        = 100  (GLOBAL → tenantId null)
 *   MULTI_TENANT_ADMIN = 80   (GLOBAL → tenantId null)
 *   TENANT_ADMIN       = 60   (LOCAL  → tenantId obrigatório)
 *   UPLOADER           = 40   (LOCAL)
 *   USER               = 20   (LOCAL)
 *
 * Cobre também a invariante de escopo bidirecional e o isolamento cross-tenant.
 */

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

const SUPER_ADMIN_ID = 'a0000000-0000-0000-0000-000000000001';
const MTA_ID = 'a0000000-0000-0000-0000-000000000002';
const TADMIN_A_ID = 'a0000000-0000-0000-0000-000000000003';
const UPLOADER_A_ID = 'a0000000-0000-0000-0000-000000000004';
const USER_A_ID = 'a0000000-0000-0000-0000-000000000005';
const TADMIN_B_ID = 'a0000000-0000-0000-0000-000000000006';

const PASSWORD = 'senha-muito-secreta-123';

let app: FastifyInstance;
let testDb: TestDb;

let superToken: string;
let mtaToken: string;
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
    id: MTA_ID,
    tenantId: null,
    email: 'mta@plataforma.com',
    password: PASSWORD,
    role: 'MULTI_TENANT_ADMIN',
    allowedTenantIds: [TENANT_A],
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

  superToken = await login('super@plataforma.com');
  mtaToken = await login('mta@plataforma.com');
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

let emailCounter = 0;
function uniqueEmail(prefix: string): string {
  emailCounter += 1;
  return `${prefix}-${emailCounter}@novo.com`;
}

interface CreateOpts {
  token: string;
  role: string;
  tenantId?: string;
  allowedTenantIds?: string[];
  email?: string;
}

function createUser(opts: CreateOpts) {
  const payload: Record<string, unknown> = {
    email: opts.email ?? uniqueEmail(opts.role.toLowerCase()),
    name: `Novo ${opts.role}`,
    role: opts.role,
    password: 'uma-senha-bem-grande',
  };
  if (opts.tenantId !== undefined) payload['tenantId'] = opts.tenantId;
  if (opts.allowedTenantIds !== undefined) payload['allowedTenantIds'] = opts.allowedTenantIds;

  let url = '/users';
  if (opts.tenantId !== undefined && !['SUPER_ADMIN', 'MULTI_TENANT_ADMIN'].includes(opts.role)) {
    // Para roles locais criados por SUPER_ADMIN/MTA, o tenant alvo vai por query.
    url = `/users?tenantId=${opts.tenantId}`;
  }

  return app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${opts.token}` },
    payload,
  });
}

// ---------------------------------------------------------------------------
// POST /users — matriz de criação
// ---------------------------------------------------------------------------

describe('POST /users — hierarquia (quem cria quem)', () => {
  it('TENANT_ADMIN NÃO cria SUPER_ADMIN → 403', async () => {
    const res = await createUser({ token: tadminAToken, role: 'SUPER_ADMIN' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('TENANT_ADMIN NÃO cria MULTI_TENANT_ADMIN → 403', async () => {
    const res = await createUser({ token: tadminAToken, role: 'MULTI_TENANT_ADMIN' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('TENANT_ADMIN cria TENANT_ADMIN (mesmo nível) → 201', async () => {
    const res = await createUser({ token: tadminAToken, role: 'TENANT_ADMIN' });
    expect(res.statusCode).toBe(201);
    expect(res.json().role).toBe('TENANT_ADMIN');
    expect(res.json().tenantId).toBe(TENANT_A);
  });

  it('TENANT_ADMIN cria UPLOADER → 201', async () => {
    const res = await createUser({ token: tadminAToken, role: 'UPLOADER' });
    expect(res.statusCode).toBe(201);
    expect(res.json().role).toBe('UPLOADER');
    expect(res.json().tenantId).toBe(TENANT_A);
  });

  it('TENANT_ADMIN cria USER → 201', async () => {
    const res = await createUser({ token: tadminAToken, role: 'USER' });
    expect(res.statusCode).toBe(201);
    expect(res.json().role).toBe('USER');
  });

  it('UPLOADER não acessa gestão de usuários (gate base) → 403', async () => {
    const res = await createUser({ token: uploaderAToken, role: 'USER' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('MTA NÃO cria SUPER_ADMIN → 403', async () => {
    const res = await createUser({ token: mtaToken, role: 'SUPER_ADMIN' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('MTA NÃO cria MULTI_TENANT_ADMIN (papel global) → 403', async () => {
    // Escalonamento de privilégio: MTA passa em canManageRole (80 >= 80), mas só
    // SUPER_ADMIN pode criar papéis globais e atribuir allowedTenantIds.
    const res = await createUser({
      token: mtaToken,
      role: 'MULTI_TENANT_ADMIN',
      allowedTenantIds: [TENANT_A, TENANT_B],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('MTA cria TENANT_ADMIN dentro do seu allowedTenantIds → 201', async () => {
    const res = await createUser({ token: mtaToken, role: 'TENANT_ADMIN', tenantId: TENANT_A });
    expect(res.statusCode).toBe(201);
    expect(res.json().role).toBe('TENANT_ADMIN');
    expect(res.json().tenantId).toBe(TENANT_A);
  });

  it('MTA NÃO cria usuário fora do allowedTenantIds → 404', async () => {
    const res = await createUser({ token: mtaToken, role: 'USER', tenantId: TENANT_B });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('SUPER_ADMIN cria SUPER_ADMIN (level 100 = 100) → 201, global', async () => {
    const res = await createUser({ token: superToken, role: 'SUPER_ADMIN' });
    expect(res.statusCode).toBe(201);
    expect(res.json().role).toBe('SUPER_ADMIN');
    expect(res.json().tenantId).toBeNull();
  });

  it('SUPER_ADMIN cria MULTI_TENANT_ADMIN → 201, global com allowedTenantIds', async () => {
    const res = await createUser({
      token: superToken,
      role: 'MULTI_TENANT_ADMIN',
      allowedTenantIds: [TENANT_A, TENANT_B],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().role).toBe('MULTI_TENANT_ADMIN');
    expect(res.json().tenantId).toBeNull();
    expect(res.json().allowedTenantIds).toEqual([TENANT_A, TENANT_B]);
  });

  it('SUPER_ADMIN cria TENANT_ADMIN num tenant qualquer → 201', async () => {
    const res = await createUser({ token: superToken, role: 'TENANT_ADMIN', tenantId: TENANT_B });
    expect(res.statusCode).toBe(201);
    expect(res.json().tenantId).toBe(TENANT_B);
  });
});

// ---------------------------------------------------------------------------
// Invariante de escopo (bidirecional)
// ---------------------------------------------------------------------------

describe('POST /users — invariante de escopo de tenantId', () => {
  it('papel GLOBAL com tenantId explícito → 403 (não pode ter tenant)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/users?tenantId=${TENANT_A}`,
      headers: { authorization: `Bearer ${superToken}` },
      payload: {
        email: uniqueEmail('global'),
        name: 'Global com tenant',
        role: 'MULTI_TENANT_ADMIN',
        password: 'uma-senha-bem-grande',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('papel GLOBAL com tenantId no body → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${superToken}` },
      payload: {
        email: uniqueEmail('global2'),
        name: 'Global com tenant body',
        role: 'SUPER_ADMIN',
        password: 'uma-senha-bem-grande',
        tenantId: TENANT_A,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('papel LOCAL sem tenantId resolvível (SUPER_ADMIN sem ?tenantId) → 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${superToken}` },
      payload: {
        email: uniqueEmail('local'),
        name: 'Local sem tenant',
        role: 'USER',
        password: 'uma-senha-bem-grande',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
  });
});

// ---------------------------------------------------------------------------
// PATCH /users/:id — hierarquia
// ---------------------------------------------------------------------------

describe('PATCH /users/:id — hierarquia', () => {
  it('TENANT_ADMIN edita UPLOADER do próprio tenant → 200', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${UPLOADER_A_ID}`,
      headers: { authorization: `Bearer ${tadminAToken}` },
      payload: { name: 'Uploader Renomeado' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Uploader Renomeado');
  });

  it('TENANT_ADMIN promove USER → UPLOADER (abaixo do seu nível) → 200', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${USER_A_ID}`,
      headers: { authorization: `Bearer ${tadminAToken}` },
      payload: { role: 'UPLOADER' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('UPLOADER');
  });

  it('TENANT_ADMIN NÃO promove USER → MULTI_TENANT_ADMIN (acima) → 403', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${USER_A_ID}`,
      headers: { authorization: `Bearer ${tadminAToken}` },
      payload: { role: 'MULTI_TENANT_ADMIN' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('TENANT_ADMIN NÃO promove USER → SUPER_ADMIN (acima) → 403', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${USER_A_ID}`,
      headers: { authorization: `Bearer ${tadminAToken}` },
      payload: { role: 'SUPER_ADMIN' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('MTA NÃO promove usuário do seu tenant → MULTI_TENANT_ADMIN (papel global) → 403', async () => {
    // O alvo está em TENANT_A (∈ allowedTenantIds do MTA), então o MTA o
    // resolve; mas atribuir papel global é exclusivo do SUPER_ADMIN.
    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${USER_A_ID}?tenantId=${TENANT_A}`,
      headers: { authorization: `Bearer ${mtaToken}` },
      payload: { role: 'MULTI_TENANT_ADMIN', allowedTenantIds: [TENANT_A, TENANT_B] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('SUPER_ADMIN promove TENANT_ADMIN → MULTI_TENANT_ADMIN (global, zera tenantId) → 200', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${TADMIN_A_ID}?tenantId=${TENANT_A}`,
      headers: { authorization: `Bearer ${superToken}` },
      payload: { role: 'MULTI_TENANT_ADMIN', allowedTenantIds: [TENANT_A] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('MULTI_TENANT_ADMIN');
    expect(res.json().tenantId).toBeNull();
    expect(res.json().allowedTenantIds).toEqual([TENANT_A]);
  });
});

// ---------------------------------------------------------------------------
// Isolamento cross-tenant em PATCH (404, nunca 403)
// ---------------------------------------------------------------------------

describe('PATCH /users/:id — cross-tenant', () => {
  it('TENANT_ADMIN A editando usuário do tenant B → 404', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${TADMIN_B_ID}`,
      headers: { authorization: `Bearer ${tadminAToken}` },
      payload: { name: 'Cross Tenant' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
