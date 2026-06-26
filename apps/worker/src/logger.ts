import type { Logger } from 'pino';
import { createLogger as createBaseLogger } from '@dmdoc/logger';
import { config as defaultConfig, type Config } from './config.js';

/**
 * Logger estruturado (Pino) do worker.
 *
 * Usa o padrão único do DMDoc (`@dmdoc/logger`): JSON com `service: 'worker'`,
 * timestamp `yyyy-mm-dd hh:mm:ss` em America/Sao_Paulo e `level` como label.
 *
 * Convenção DMDoc (spec §14): nunca `console.log`. Os campos de contexto
 * `tenantId`, `documentId`, `userId` e `traceId` são adicionados via
 * `logger.child({...})` quando há um job real para processar.
 */
export function createLogger(config: Config = defaultConfig): Logger {
  return createBaseLogger({ service: 'worker', level: config.LOG_LEVEL });
}

/** Logger singleton para uso da aplicação. */
export const logger: Logger = createLogger();
