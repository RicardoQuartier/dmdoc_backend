import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { AUDIT_LOGS_COLLECTION } from '../auth/audit.js';
import { startTestDb, seedUser, testConfig, type TestDb } from '../test/helpers.js';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PASSWORD = 'senha-super-secreta';

let app: FastifyInstance;
let testDb: TestDb;

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
  await testDb.db.collection(AUDIT_LOGS_COLLECTION).deleteMany({});
});

async function seedDefaultUser(active = true): Promise<void> {
  await seedUser(testDb.db, {
    id: USER_ID,
    tenantId: TENANT_A,
    email: 'admin@empresa.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
    active,
  });
}

describe('POST /auth/login', () => {
  it('login válido → 200 com access+refresh e usuário sem passwordHash', async () => {
    await seedDefaultUser();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@empresa.com', password: PASSWORD },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBeTypeOf('string');
    expect(body.refreshToken).toBeTypeOf('string');
    expect(body.user).toMatchObject({
      id: USER_ID,
      email: 'admin@empresa.com',
      role: 'TENANT_ADMIN',
      tenantId: TENANT_A,
    });
    expect(body.user.passwordHash).toBeUndefined();
  });

  it('registra audit log auth.login no login bem-sucedido', async () => {
    await seedDefaultUser();

    await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@empresa.com', password: PASSWORD },
    });

    const logs = await testDb.db.collection(AUDIT_LOGS_COLLECTION).find({}).toArray();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: 'auth.login',
      userId: USER_ID,
      tenantId: TENANT_A,
    });
  });

  it('senha errada → 401 genérico', async () => {
    await seedDefaultUser();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@empresa.com', password: 'errada' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('email inexistente → 401 (sem audit log)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'ninguem@empresa.com', password: PASSWORD },
    });

    expect(res.statusCode).toBe(401);
    const logs = await testDb.db.collection(AUDIT_LOGS_COLLECTION).find({}).toArray();
    expect(logs).toHaveLength(0);
  });

  it('usuário inativo → 401', async () => {
    await seedDefaultUser(false);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@empresa.com', password: PASSWORD },
    });

    expect(res.statusCode).toBe(401);
  });

  it('email ambíguo entre empresas → 401 (edge case documentado)', async () => {
    await seedDefaultUser();
    await seedUser(testDb.db, {
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      tenantId: '22222222-2222-2222-2222-222222222222',
      email: 'admin@empresa.com',
      password: PASSWORD,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@empresa.com', password: PASSWORD },
    });

    expect(res.statusCode).toBe(401);
  });

  it('body inválido (sem senha) → 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@empresa.com' },
    });

    expect(res.statusCode).toBe(422);
  });
});

describe('GET /auth/me', () => {
  it('sem token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('token inválido → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: 'Bearer nao-e-um-jwt' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('token válido → 200 com o usuário (sem passwordHash)', async () => {
    await seedDefaultUser();
    const accessToken = await loginAndGetAccess();

    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ id: USER_ID, email: 'admin@empresa.com', tenantId: TENANT_A });
    expect(body.passwordHash).toBeUndefined();
  });
});

describe('POST /auth/refresh', () => {
  it('refresh válido → novo par de tokens', async () => {
    await seedDefaultUser();
    const refreshToken = await loginAndGetRefresh();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBeTypeOf('string');
    expect(body.refreshToken).toBeTypeOf('string');
  });

  it('refresh inválido → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: 'token-invalido' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refresh de usuário desativado após emissão → 401', async () => {
    await seedDefaultUser();
    const refreshToken = await loginAndGetRefresh();
    await testDb.db.collection('users').updateOne({ id: USER_ID }, { $set: { active: false } });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  it('sempre 200 (stateless)', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/logout' });
    expect(res.statusCode).toBe(200);
  });
});

async function loginAndGetAccess(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'admin@empresa.com', password: PASSWORD },
  });
  return res.json().accessToken as string;
}

async function loginAndGetRefresh(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'admin@empresa.com', password: PASSWORD },
  });
  return res.json().refreshToken as string;
}
