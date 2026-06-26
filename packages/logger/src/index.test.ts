import { describe, it, expect } from 'vitest';
import { pino } from 'pino';
import { baseLoggerOptions, createLogger, formatSaoPaulo } from './index.js';

describe('formatSaoPaulo', () => {
  it('formata como yyyy-mm-dd hh:mm:ss no fuso de São Paulo', () => {
    // 14:55 UTC == 11:55 em São Paulo (UTC-3, sem horário de verão desde 2019).
    const date = new Date('2026-06-26T14:55:07Z');
    expect(formatSaoPaulo(date)).toBe('2026-06-26 11:55:07');
  });

  it('produz sempre o formato yyyy-mm-dd hh:mm:ss', () => {
    expect(formatSaoPaulo(new Date('2026-01-01T02:00:00Z'))).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
    );
  });
});

describe('baseLoggerOptions / createLogger', () => {
  function capture(service: string): { logger: ReturnType<typeof createLogger>; lines: unknown[] } {
    const lines: unknown[] = [];
    const stream = {
      write: (chunk: string): void => {
        lines.push(JSON.parse(chunk));
      },
    };
    const logger = pino(baseLoggerOptions({ service, level: 'info' }), stream);
    return { logger, lines };
  }

  it('emite JSON com service, time formatado, level como label e sem pid/hostname', () => {
    const { logger, lines } = capture('worker');
    logger.info({ tenantId: 't1', documentId: 'd1', traceId: 'job-1' }, 'olá');

    const log = lines[0] as Record<string, unknown>;
    expect(log.service).toBe('worker');
    expect(log.level).toBe('info');
    expect(log.msg).toBe('olá');
    expect(log.tenantId).toBe('t1');
    expect(log.documentId).toBe('d1');
    expect(log.traceId).toBe('job-1');
    expect(log.time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(log.pid).toBeUndefined();
    expect(log.hostname).toBeUndefined();
  });

  it('propaga contexto via child', () => {
    const { logger, lines } = capture('api');
    logger.child({ userId: 'u1' }).error({ traceId: 'req-9' }, 'falhou');

    const log = lines[0] as Record<string, unknown>;
    expect(log.service).toBe('api');
    expect(log.level).toBe('error');
    expect(log.userId).toBe('u1');
    expect(log.traceId).toBe('req-9');
  });
});
