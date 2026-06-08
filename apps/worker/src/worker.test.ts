import { afterEach, describe, expect, it } from 'vitest';
import type { Queue } from 'bullmq';
import { loadConfig } from './config.js';
import {
  DOCUMENT_PROCESSING_QUEUE,
  createDocumentProcessingQueue,
  type DocumentProcessingJobData,
} from './queues.js';

/**
 * Testes unitários do scaffold do worker (Fase 0).
 *
 * Não abrem socket vivo para o Redis: a Queue é construída com opções de
 * conexão (host/port) e fechada antes de qualquer comando — o objetivo é
 * apenas validar config e a construção da fila, não exercitar a fila.
 */

describe('config', () => {
  it('aplica defaults e valida o ambiente', () => {
    const config = loadConfig({});

    expect(config.NODE_ENV).toBe('development');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.REDIS_URL).toBe('redis://localhost:6379');
  });

  it('respeita os valores fornecidos', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      REDIS_URL: 'redis://cache:6380',
    });

    expect(config.NODE_ENV).toBe('test');
    expect(config.LOG_LEVEL).toBe('silent');
    expect(config.REDIS_URL).toBe('redis://cache:6380');
  });

  it('rejeita REDIS_URL inválida', () => {
    expect(() => loadConfig({ REDIS_URL: 'not-a-url' })).toThrow(
      /Configuração de ambiente inválida/
    );
  });

  it('rejeita LOG_LEVEL fora do enum', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow(
      /Configuração de ambiente inválida/
    );
  });
});

describe('createDocumentProcessingQueue', () => {
  let queue: Queue<DocumentProcessingJobData> | undefined;

  afterEach(async () => {
    if (queue) {
      await queue.close();
      queue = undefined;
    }
  });

  it('registra a fila com o nome esperado sem enfileirar jobs', () => {
    queue = createDocumentProcessingQueue({ host: 'localhost', port: 6379 });

    expect(queue.name).toBe(DOCUMENT_PROCESSING_QUEUE);
    expect(DOCUMENT_PROCESSING_QUEUE).toBe('document-processing');
  });
});
