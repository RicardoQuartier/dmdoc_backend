import { pino, type Logger, type LoggerOptions } from 'pino';

/**
 * Padrão único de logs do DMDoc — API, worker e extractor.
 *
 * Contrato canônico de cada linha (JSON):
 *
 *   {
 *     "level": "info",                 // label string, nunca o número do Pino
 *     "time": "2026-06-26 11:55:00",   // yyyy-mm-dd hh:mm:ss em America/Sao_Paulo
 *     "service": "api",                // nome da aplicação: api | worker | extractor
 *     "tenantId": "...",               // contexto (quando houver)
 *     "documentId": "...",
 *     "userId": "...",
 *     "traceId": "...",
 *     "msg": "mensagem"
 *   }
 *
 * Campos de contexto entram via `logger.child({...})`. Sem `pid`/`hostname`.
 *
 * O serviço Python (`services/extractor/app.py`) espelha este contrato com um
 * `JsonFormatter` próprio — manter as duas implementações alinhadas (spec §14).
 */

export type ServiceName = 'api' | 'worker' | 'extractor';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface LoggerConfig {
  /** Nome da aplicação que sai no campo `service`. */
  service: ServiceName | string;
  /** Nível mínimo do Pino. Default `info`. */
  level?: LogLevel | string;
}

const SAO_PAULO_TZ = 'America/Sao_Paulo';

/**
 * Formatter fixo no fuso de São Paulo. `formatToParts` torna a montagem
 * determinística (independe de separadores que variam por locale/versão ICU)
 * e `hourCycle: 'h23'` garante horas 00–23 (evita "24" à meia-noite).
 */
const timeParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: SAO_PAULO_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Formata uma data como `yyyy-mm-dd hh:mm:ss` no fuso America/Sao_Paulo. */
export function formatSaoPaulo(date: Date): string {
  const parts = timeParts.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/**
 * Opções Pino puras do padrão DMDoc. Retorna um objeto (não uma instância) para
 * que a API o passe direto ao Fastify (`Fastify({ logger: baseLoggerOptions(...) })`),
 * deixando o Fastify construir o próprio Pino — evita conflito entre a major do
 * Pino dos pacotes (`^9`) e a puxada transitivamente pelo Fastify 5 (`^10`).
 */
export function baseLoggerOptions({ service, level = 'info' }: LoggerConfig): LoggerOptions {
  return {
    level,
    base: { service },
    timestamp: () => `,"time":"${formatSaoPaulo(new Date())}"`,
    formatters: {
      level: (label) => ({ level: label }),
    },
  };
}

/** Cria um logger Pino já no padrão DMDoc (worker, scripts e demais processos Node). */
export function createLogger(config: LoggerConfig): Logger {
  return pino(baseLoggerOptions(config));
}

/**
 * Interface mínima de logger — compatível com o Pino `Logger` e com o
 * `FastifyBaseLogger`. Pacotes que recebem o logger por injeção devem depender
 * deste tipo em vez de `pino` diretamente.
 */
export interface MinimalLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  child(bindings: Record<string, unknown>): MinimalLogger;
}

/** Campos de contexto recomendados em todo log (spec §14). */
export interface LoggerContext {
  tenantId?: string;
  documentId?: string;
  userId?: string;
  traceId?: string;
}
