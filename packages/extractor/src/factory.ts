import { RedisExtractor, type RedisExtractorConfig } from './redis-extractor.js';
import { type ExtractorProvider } from './types.js';

export type ExtractorType = 'redis';

export interface ExtractorConfig {
  type: ExtractorType;
  /** Obrigatório quando type === 'redis'. */
  redis?: RedisExtractorConfig;
}

export function createExtractor(config: ExtractorConfig): ExtractorProvider {
  switch (config.type) {
    case 'redis': {
      const redisConfig = config.redis;
      if (!redisConfig) {
        throw new Error('createExtractor: redis config is required when type is "redis"');
      }
      return new RedisExtractor(redisConfig);
    }

    default: {
      const _exhaustive: never = config.type;
      throw new Error(`createExtractor: unknown extractor type "${String(_exhaustive)}"`);
    }
  }
}
