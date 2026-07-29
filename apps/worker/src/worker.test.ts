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

/** Chave mestra de storage válida (32 bytes em hex), exigida pelo schema. */
const STORAGE_SECRET_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('config', () => {
  it('aplica defaults e valida o ambiente', () => {
    const config = loadConfig({ STORAGE_SECRET_KEY });

    expect(config.NODE_ENV).toBe('development');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.REDIS_URL).toBe('redis://localhost:6379');
  });

  it('respeita os valores fornecidos', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      REDIS_URL: 'redis://cache:6380',
      STORAGE_SECRET_KEY,
    });

    expect(config.NODE_ENV).toBe('test');
    expect(config.LOG_LEVEL).toBe('silent');
    expect(config.REDIS_URL).toBe('redis://cache:6380');
  });

  it('rejeita REDIS_URL inválida', () => {
    expect(() => loadConfig({ REDIS_URL: 'not-a-url', STORAGE_SECRET_KEY })).toThrow(
      /Configuração de ambiente inválida/
    );
  });

  it('rejeita LOG_LEVEL fora do enum', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose', STORAGE_SECRET_KEY })).toThrow(
      /Configuração de ambiente inválida/
    );
  });

  it('rejeita boot sem STORAGE_SECRET_KEY', () => {
    // Falhar no boot, e não no primeiro job de uma empresa com destino próprio.
    expect(() => loadConfig({})).toThrow(/STORAGE_SECRET_KEY/);
  });

  it('rejeita STORAGE_SECRET_KEY com tamanho errado', () => {
    expect(() => loadConfig({ STORAGE_SECRET_KEY: 'abcdef' })).toThrow(/32 bytes/);
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
