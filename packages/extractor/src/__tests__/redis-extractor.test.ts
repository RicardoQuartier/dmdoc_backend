import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';

vi.mock('ioredis', () => {
  const MockRedis = vi.fn();
  return { Redis: MockRedis, default: MockRedis };
});

// Import after mock is registered
const { RedisExtractor } = await import('../redis-extractor.js');
const { ExtractionError } = await import('../types.js');
const { Redis: MockRedis } = await import('ioredis') as { Redis: ReturnType<typeof vi.fn> };

const INPUT = {
  s3Key: 'tenants/abc/doc.pdf',
  s3Bucket: 'dmdoc-documents',
  mimeType: 'application/pdf',
};

function makeExtractor(blpopTimeoutSecs = 30) {
  const pushConnection = { rpush: vi.fn().mockResolvedValue(1) } as unknown as Redis;
  return {
    extractor: new RedisExtractor({
      redisUrl: 'redis://localhost:6379',
      blpopTimeoutSecs,
      pushConnection,
    }),
    pushConnection,
  };
}

describe('RedisExtractor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('publica request via pushConnection e retorna ExtractionResult no caminho feliz', async () => {
    const { extractor, pushConnection } = makeExtractor();
    const disconnect = vi.fn();
    MockRedis.mockImplementationOnce(() => ({
      blpop: vi.fn().mockResolvedValueOnce([
        'extract:result:xxx',
        JSON.stringify({ text: 'hello world', pageCount: 2, ocrPages: [1], engine: 'python' }),
      ]),
      disconnect,
    }));

    const result = await extractor.extract(INPUT);

    expect(result.fullText).toBe('hello world');
    expect(result.pageCount).toBe(2);
    expect(result.ocrPages).toEqual([1]);
    expect(result.engine).toBe('native');
    expect(result.engineVersion).toBe('python-extractor-redis');
    expect(vi.mocked(pushConnection.rpush)).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('lança ExtractionError quando BLPOP faz timeout (retorna null)', async () => {
    const { extractor } = makeExtractor();
    const disconnect = vi.fn();
    MockRedis.mockImplementationOnce(() => ({
      blpop: vi.fn().mockResolvedValueOnce(null),
      disconnect,
    }));

    await expect(extractor.extract(INPUT)).rejects.toBeInstanceOf(ExtractionError);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('lança ExtractionError quando Python retorna { error }', async () => {
    const { extractor } = makeExtractor();
    const disconnect = vi.fn();
    MockRedis.mockImplementationOnce(() => ({
      blpop: vi.fn().mockResolvedValueOnce([
        'extract:result:xxx',
        JSON.stringify({ error: 'unsupported mime: application/zip', text: '', pageCount: 1, ocrPages: [] }),
      ]),
      disconnect,
    }));

    await expect(extractor.extract({ ...INPUT, mimeType: 'application/zip' }))
      .rejects.toThrow('unsupported mime: application/zip');
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('lança ExtractionError e desconecta quando JSON é inválido', async () => {
    const { extractor } = makeExtractor();
    const disconnect = vi.fn();
    MockRedis.mockImplementationOnce(() => ({
      blpop: vi.fn().mockResolvedValueOnce(['extract:result:xxx', 'NOT_JSON']),
      disconnect,
    }));

    await expect(extractor.extract(INPUT)).rejects.toBeInstanceOf(ExtractionError);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('desconecta resultConn mesmo quando BLPOP lança exceção de rede', async () => {
    const { extractor } = makeExtractor();
    const disconnect = vi.fn();
    MockRedis.mockImplementationOnce(() => ({
      blpop: vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')),
      disconnect,
    }));

    await expect(extractor.extract(INPUT)).rejects.toThrow('ECONNREFUSED');
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('usa pageCount=1 quando Python retorna pageCount inválido', async () => {
    const { extractor } = makeExtractor();
    MockRedis.mockImplementationOnce(() => ({
      blpop: vi.fn().mockResolvedValueOnce([
        'extract:result:xxx',
        JSON.stringify({ text: 'ok', pageCount: 0, ocrPages: [] }),
      ]),
      disconnect: vi.fn(),
    }));

    const result = await extractor.extract(INPUT);
    expect(result.pageCount).toBe(1);
  });
});
