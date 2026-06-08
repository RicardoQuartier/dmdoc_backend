import { Worker, type Job } from 'bullmq';
import { config } from './config.js';
import { logger } from './logger.js';
import { createRedisConnection } from './redis.js';
import {
  DOCUMENT_PROCESSING_QUEUE,
  type DocumentProcessingJobData,
} from './queues.js';

/**
 * Concorrência do worker. O pipeline real (spec §8) ajustará isso na Fase 3;
 * mantido baixo no scaffold.
 */
const WORKER_CONCURRENCY = 5;

/**
 * Processor placeholder da Fase 0.
 *
 * O pipeline de processamento de documentos (extração → chunking → embeddings
 * → persistência) é entregável da Fase 3. Aqui apenas registramos o no-op e
 * sinalizamos que ainda não está implementado, sem derrubar o processo —
 * invariante do worker (spec §8: "worker nunca derruba o processo").
 */
function createDocumentProcessor() {
  return async (job: Job<DocumentProcessingJobData>): Promise<void> => {
    logger.warn(
      { jobId: job.id, queue: DOCUMENT_PROCESSING_QUEUE },
      'pipeline de processamento ainda não implementado (Fase 3) — no-op'
    );
    throw new Error('document processing pipeline not implemented');
  };
}

/**
 * Cria o Worker BullMQ ligado à fila de processamento de documentos.
 *
 * A conexão Redis é injetada para manter `config`/`process.env` fora deste
 * helper e permitir testes sem socket vivo.
 */
export function createDocumentWorker(): Worker<DocumentProcessingJobData> {
  const connection = createRedisConnection(config);

  const worker = new Worker<DocumentProcessingJobData>(
    DOCUMENT_PROCESSING_QUEUE,
    createDocumentProcessor(),
    {
      connection,
      concurrency: WORKER_CONCURRENCY,
    }
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, err },
      'job de processamento falhou'
    );
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'erro no worker de processamento');
  });

  return worker;
}

/**
 * Entrypoint do worker. Cria o Worker (que conecta ao Redis sob demanda) e
 * registra desligamento gracioso. Erros não tratados são logados; o processo
 * não é derrubado por falha de job individual.
 */
async function main(): Promise<void> {
  const worker = createDocumentWorker();

  logger.info(
    { queue: DOCUMENT_PROCESSING_QUEUE, concurrency: WORKER_CONCURRENCY },
    'worker iniciado e ouvindo a fila'
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'encerrando worker');
    await worker.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main();
