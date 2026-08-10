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
  const TENANT = crypto.randomUUID();
  const ADMIN_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const PASSWORD = 'senha-muito-secreta-123';

  let app: FastifyInstance;
  let testDb: TestDb;
  let token: string;

  beforeAll(async () => {
    testDb = await startTestDb();
    app = await buildApp({ config: testConfig(), db: testDb.db });

    await testDb.db`
      INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
      VALUES (${TENANT}, 'Empresa A', ${10 * 1024 ** 3}, 20, true, NOW())
      ON CONFLICT (id) DO NOTHING
    `;
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

describe('CORS — comportamento por ambiente (épico E-12, T-152)', () => {
  // Em produção sem front e API na mesma origem, a API precisa aceitar
  // requisições cross-origin do domínio do front — mas só das origens
  // listadas explicitamente em CORS_ORIGIN. Sem essa env, o comportamento
  // deve continuar EXATAMENTE o de hoje: `origin: false`, negando qualquer
  // cross-origin (é o que preserva homolog, que serve tudo pela mesma origem
  // via proxy path-based).
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await startTestDb();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it('produção sem CORS_ORIGIN: origem cross-origin não recebe Access-Control-Allow-Origin', async () => {
    const app = await buildApp({
      config: testConfig({ NODE_ENV: 'production' }),
      db: testDb.db,
    });

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { origin: 'https://boavi.app.br' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('produção com CORS_ORIGIN: origem LISTADA recebe o header correto e credentials habilitado', async () => {
    const app = await buildApp({
      config: testConfig({ NODE_ENV: 'production', CORS_ORIGIN: 'https://boavi.app.br' }),
      db: testDb.db,
    });

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { origin: 'https://boavi.app.br' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('https://boavi.app.br');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    } finally {
      await app.close();
    }
  });

  it('produção com CORS_ORIGIN: origem NÃO listada continua sem Access-Control-Allow-Origin', async () => {
    const app = await buildApp({
      config: testConfig({ NODE_ENV: 'production', CORS_ORIGIN: 'https://boavi.app.br' }),
      db: testDb.db,
    });

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { origin: 'https://outro-site.com' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('produção com múltiplas CORS_ORIGIN separadas por vírgula: cada uma listada recebe o header', async () => {
    const app = await buildApp({
      config: testConfig({
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://boavi.app.br, https://outro-front.com.br',
      }),
      db: testDb.db,
    });

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { origin: 'https://outro-front.com.br' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('https://outro-front.com.br');
    } finally {
      await app.close();
    }
  });
});
