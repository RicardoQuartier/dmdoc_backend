import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { startTestDb, seedUser, testConfig, type TestDb } from './test/helpers.js';

describe('GET /healthz', () => {
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

  it('retorna 200 com { status: "ok" }', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('Error handler central — corpo JSON inválido', () => {
  // Regra: requisição com `Content-Type: application/json` cujo corpo está
  // ausente ou malformado é falha do cliente → 400 BAD_REQUEST, nunca 500.
  // (card mvp-launch: corpo vazio retornava 500, poluindo métricas de erro 5xx)
  const TENANT = '11111111-1111-1111-1111-111111111111';
  const ADMIN_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const PASSWORD = 'senha-muito-secreta-123';

  let app: FastifyInstance;
  let testDb: TestDb;
  let token: string;

  beforeAll(async () => {
    testDb = await startTestDb();
    app = await buildApp({ config: testConfig(), db: testDb.db });

    await testDb.db.collection('tenants').insertOne({
      id: TENANT,
      name: 'Empresa A',
      diskQuotaBytes: 10 * 1024 ** 3,
      userQuota: 20,
      active: true,
      createdAt: new Date(),
    });
    await seedUser(testDb.db, {
      id: ADMIN_ID,
      tenantId: TENANT,
      email: 'admin@empresa.com',
      password: PASSWORD,
      role: 'TENANT_ADMIN',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@empresa.com', password: PASSWORD },
    });
    token = res.json().accessToken as string;
  });

  afterAll(async () => {
    await app.close();
    await testDb.stop();
  });

  it('POST com Content-Type application/json e corpo VAZIO → 400 (não 500)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/departments',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      // corpo deliberadamente ausente
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
  });

  it('POST com Content-Type application/json e corpo MALFORMADO → 400 (não 500)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/departments',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: '{ "name": ',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
  });
});
