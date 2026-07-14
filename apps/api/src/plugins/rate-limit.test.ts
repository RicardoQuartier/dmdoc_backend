import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, testConfig, type TestDb } from '../test/helpers.js';
import type { S3Service } from '../services/s3.js';

// ---------------------------------------------------------------------------
// Regressão do bug 7dbe2438 (QUOTA-7): ao exceder o limite de requisições por
// janela, a API respondia HTTP 500 em vez de 429. A causa era o
// `errorResponseBuilder` do plugin devolver um objeto simples (sem
// `statusCode`), que o error handler central não reconhecia e mapeava para
// 500. Agora devolve um `RateLimitError` (AppError → 429) com `retryAfterMs`.
//
// O limite é reduzido a 3 via override de config; a rota pública `/healthz`
// (sem auth) é chaveada por IP — todas as chamadas de `app.inject` compartilham
// o mesmo IP, logo o mesmo bucket.
// ---------------------------------------------------------------------------

function createMockS3(): S3Service {
  return {
    uploadFile: vi.fn().mockResolvedValue(undefined),
    getSignedDownloadUrl: vi.fn().mockResolvedValue('https://mock-signed-url'),
    deleteFile: vi.fn().mockResolvedValue(undefined),
  } as unknown as S3Service;
}

let app: FastifyInstance;
let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
  app = await buildApp({
    config: testConfig({ RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_MS: '60000' }),
    db: testDb.db,
    queue: null,
    s3: createMockS3(),
  });
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

describe('rate limiting — resposta 429 ao exceder o limite', () => {
  it('a requisição além do limite retorna 429 com retryAfterMs e headers, nunca 500', async () => {
    // As 3 primeiras passam.
    for (let i = 0; i < 3; i++) {
      const ok = await app.inject({ method: 'GET', url: '/healthz' });
      expect(ok.statusCode).toBe(200);
    }

    // A 4ª estoura o limite.
    const blocked = await app.inject({ method: 'GET', url: '/healthz' });

    expect(blocked.statusCode).toBe(429);
    const body = blocked.json() as {
      error: { code: string; message: string; retryAfterMs: number };
    };
    expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(typeof body.error.retryAfterMs).toBe('number');
    expect(body.error.retryAfterMs).toBeGreaterThan(0);

    // Headers de rate limit preservados.
    expect(blocked.headers['x-ratelimit-limit']).toBeDefined();
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
    expect(blocked.headers['retry-after']).toBeDefined();
  });
});
