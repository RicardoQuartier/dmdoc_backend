import { pino, type Logger } from 'pino';
import { config as defaultConfig, type Config } from './config.js';

/**
 * Logger estruturado (Pino) do worker.
 *
 * Convenção DMDoc (spec §14): nunca `console.log`. Os campos de contexto
 * `tenantId`, `documentId`, `userId` e `traceId` devem ser adicionados via
 * `logger.child({...})` quando houver um job real para processar (Fase 3+).
 * No scaffold da Fase 0 expomos apenas o logger base.
 */
export function createLogger(config: Config = defaultConfig): Logger {
  return pino({
    level: config.LOG_LEVEL,
    base: { service: 'worker' },
  });
}

/** Logger singleton para uso da aplicação. */
export const logger: Logger = createLogger();
