import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { authPlugin } from './auth.js';
import { AppError } from '../errors/index.js';
import { TokenService } from '../auth/tokens.js';
import { startTestDb, testConfig, type TestDb } from '../test/helpers.js';

// UUID de tenant por arquivo — evita colisão no `dmdoc_test` compartilhado.
const TENANT_A = crypto.randomUUID();
const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SUPER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

let app: FastifyInstance;
let testDb: TestDb;
let tokens: TokenService;

/**
 * App mínima: só o plugin de auth + uma rota protegida que devolve o contexto
 * de tenant injetado. Isola o comportamento do middleware do resto da API.
 */
beforeAll(async () => {
  const config = testConfig();
  tokens = new TokenService(config);
  testDb = await startTestDb();

  app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code } });
    }
    if (error instanceof ZodError) {
      return reply.status(422).send({ error: { code: 'VALIDATION_ERROR' } });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR' } });
  });
  await app.register(authPlugin, { config, sql: testDb.db });
  app.get('/protected', { preHandler: app.authenticate }, async (request) => {
    return { user: request.user, tenantId: request.tenantId };
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

describe('plugin authenticate', () => {
  it('sem header Authorization → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
  });

  it('header malformado (sem Bearer) → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Token abc' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('token inválido → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer abc.def.ghi' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('usuário de empresa → popula tenantId correto', async () => {
    const accessToken = tokens.signAccessToken({
      sub: USER_ID,
      tenantId: TENANT_A,
      role: 'TENANT_ADMIN',
      allowedTenantIds: [],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tenantId).toBe(TENANT_A);
    expect(body.user).toMatchObject({ sub: USER_ID, role: 'TENANT_ADMIN', tenantId: TENANT_A });
  });

  it('SUPER_ADMIN → tenantId null (acessa empresa via parâmetro de rota)', async () => {
    const accessToken = tokens.signAccessToken({
      sub: SUPER_ID,
      tenantId: null,
      role: 'SUPER_ADMIN',
      allowedTenantIds: [],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tenantId).toBeNull();
    expect(body.user).toMatchObject({ sub: SUPER_ID, role: 'SUPER_ADMIN', tenantId: null });
  });
});
