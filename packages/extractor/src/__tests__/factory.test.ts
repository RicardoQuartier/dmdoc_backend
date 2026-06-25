import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { createExtractor } from '../factory.js';
import { RedisExtractor } from '../redis-extractor.js';

describe('createExtractor', () => {
  const fakeConn = {} as Redis;

  it('retorna RedisExtractor quando type === "redis"', () => {
    const extractor = createExtractor({
      type: 'redis',
      redis: { redisUrl: 'redis://localhost:6379', pushConnection: fakeConn },
    });
    expect(extractor).toBeInstanceOf(RedisExtractor);
  });

  it('lança quando type === "redis" mas config está ausente', () => {
    expect(() => createExtractor({ type: 'redis' })).toThrow('redis config is required');
  });
});
