import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import OpenAI from 'openai';
import { createPgClient } from '@dmdoc/db-pg';
import { createExtractor } from '@dmdoc/extractor';
import { DocumentProcessingJobDataSchema } from '@dmdoc/shared-types';
import { config } from './config.js';
import { logger } from './logger.js';
import { createRedisConnection } from './redis.js';
import { DOCUMENT_PROCESSING_QUEUE, type DocumentProcessingJobData } from './queues.js';
import { runPipeline, type PipelineDeps } from './pipeline/index.js';

/**
 * Concorrência do worker (spec §8).
 */
const WORKER_CONCURRENCY = 5;

/**
 * Cria o processor do BullMQ que valida e executa o pipeline completo.
 *
 * As deps são construídas uma única vez no boot e injetadas em cada job.
 * Nenhum `process.env` é lido aqui — apenas `config` (Zod-validated).
 */
function createDocumentProcessor(deps: PipelineDeps) {
  return async (job: Job<DocumentProcessingJobData>): Promise<void> => {
    // Validar payload do job na borda do worker (spec §8)
    job.data = DocumentProcessingJobDataSchema.parse(job.data);
    await runPipeline(job, deps);
  };
}

/**
 * Cria o Worker BullMQ ligado à fila de processamento de documentos.
 */
export function createDocumentWorker(
  deps: PipelineDeps
): Worker<DocumentProcessingJobData> {
  const connection = createRedisConnection(config);

  const worker = new Worker<DocumentProcessingJobData>(
    DOCUMENT_PROCESSING_QUEUE,
    createDocumentProcessor(deps),
    {
      connection,
      concurrency: WORKER_CONCURRENCY,
    }
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, tenantId: job?.data.tenantId, documentId: job?.data.documentId, err },
      'job de processamento falhou'
    );
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'erro no worker de processamento');
  });

  worker.on('completed', (job) => {
    logger.info(
      { jobId: job.id, tenantId: job.data.tenantId, documentId: job.data.documentId },
      'job concluído com sucesso'
    );
  });

  return worker;
}

/**
 * Entrypoint do worker. Inicializa todas as dependências e cria o Worker BullMQ.
 *
 * O extractor usa comunicação assíncrona via Redis: o worker enfileira pedidos em
 * `extract:requests` e aguarda resultados via BLPOP em `extract:result:{requestId}`.
 * Isso elimina o timeout HTTP e permite que o Python processe no seu próprio ritmo.
 */
async function main(): Promise<void> {
  logger.info('inicializando dependências do worker');

  // PostgreSQL
  const sql = createPgClient(config.DATABASE_URL);
  logger.info('PostgreSQL conectado');

  // OpenAI (embeddings)
  const openai = new OpenAI({
    apiKey: config.OPENAI_API_KEY ?? '',
  });
  logger.info({ model: config.EMBEDDING_MODEL }, 'OpenAI client criado');

  // Conexão Redis dedicada para RPUSH de pedidos de extração.
  // Separada da conexão BullMQ para não interferir com os comandos bloqueantes do Worker.
  const extractionPushConn = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

  const extractor = createExtractor({
    type: 'redis',
    redis: {
      redisUrl: config.REDIS_URL,
      blpopTimeoutSecs: config.EXTRACT_BLPOP_TIMEOUT_SECS,
      pushConnection: extractionPushConn,
    },
  });
  logger.info(
    { blpopTimeoutSecs: config.EXTRACT_BLPOP_TIMEOUT_SECS },
    'extractor Redis criado'
  );

  const deps: PipelineDeps = {
    s3Bucket: config.AWS_S3_BUCKET,
    extractor,
    openai,
    embeddingModel: config.EMBEDDING_MODEL,
    sql,
    logger,
    chunkTargetTokens: config.CHUNK_TARGET_TOKENS,
    chunkOverlapTokens: config.CHUNK_OVERLAP_TOKENS,
  };

  const worker = createDocumentWorker(deps);

  logger.info(
    { queue: DOCUMENT_PROCESSING_QUEUE, concurrency: WORKER_CONCURRENCY },
    'worker iniciado e ouvindo a fila'
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'encerrando worker');
    await worker.close();
    extractionPushConn.disconnect();
    await sql.end();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main();
