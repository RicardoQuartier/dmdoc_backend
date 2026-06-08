import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { startTestDb, testConfig, type TestDb } from './test/helpers.js';

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
