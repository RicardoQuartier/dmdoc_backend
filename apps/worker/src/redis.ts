import { Redis, type RedisOptions } from 'ioredis';
import { config as defaultConfig, type Config } from './config.js';

/**
 * Opções de conexão exigidas pelo BullMQ.
 *
 * `maxRetriesPerRequest: null` é requisito do BullMQ para conexões usadas por
 * Workers (comandos bloqueantes como BRPOPLPUSH não devem ter limite de
 * retries por request). Sem isso o BullMQ emite warning/erro no boot.
 */
const BULLMQ_REDIS_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: null,
};

/**
 * Cria uma conexão Redis (ioredis) pronta para uso com BullMQ.
 *
 * A conexão é compartilhada entre a fila (`queues.ts`) e o worker
 * (`worker.ts`). Não conecta de imediato em modo `lazyConnect` — aqui
 * usamos o comportamento padrão do ioredis, que conecta sob demanda.
 */
export function createRedisConnection(config: Config = defaultConfig): Redis {
  return new Redis(config.REDIS_URL, BULLMQ_REDIS_OPTIONS);
}
