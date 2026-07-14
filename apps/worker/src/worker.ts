import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import OpenAI from 'openai';
import { createPgClient } from '@dmdoc/db-pg';
import { createExtractor } from '@dmdoc/extractor';
import { createLLMProvider } from '@dmdoc/llm-provider';
import { DocumentProcessingJobDataSchema } from '@dmdoc/shared-types';
import { config } from './config.js';
import { logger } from './logger.js';
import { createRedisConnection } from './redis.js';
import {
  DOCUMENT_PROCESSING_QUEUE,
  TENANT_DELETION_QUEUE,
  type DocumentProcessingJobData,
} from './queues.js';
import { runPipeline, type PipelineDeps } from './pipeline/index.js';
import { createWorkerS3 } from './s3.js';
import { createTenantDeletionWorker } from './tenant-deletion-worker.js';

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
    // node-fetch@2 falha ao descomprimir gzip em Docker (MTU mismatch)
    defaultHeaders: { 'Accept-Encoding': 'identity' },
  });
  logger.info({ model: config.EMBEDDING_MODEL }, 'OpenAI client criado');

  // LLM de chat — classificação automática de tipo (Fase 8). Funciona com
  // OpenAI e OpenRouter só trocando baseURL/apiKey/model (mesmas envs da API).
  const llmProvider = createLLMProvider(
    {
      provider: config.LLM_PROVIDER,
      baseURL: config.LLM_BASE_URL,
      apiKey: config.LLM_API_KEY || 'placeholder',
      model: config.LLM_MODEL,
    },
    logger
  );
  logger.info(
    { provider: config.LLM_PROVIDER, model: config.LLM_MODEL },
    'LLM provider de chat criado (classificação)'
  );

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
    llmProvider,
    chatModel: config.LLM_MODEL,
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

  // Worker de exclusão de empresa (tenant). Sobe ao lado do worker de documentos
  // e consome a fila `tenant-deletion`, executando a purga pesada em background.
  const s3 = createWorkerS3(config);
  const tenantDeletionWorker = createTenantDeletionWorker({ sql, s3, logger });

  logger.info(
    { queue: TENANT_DELETION_QUEUE },
    'worker de exclusão de tenant iniciado e ouvindo a fila'
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'encerrando worker');
    await Promise.all([worker.close(), tenantDeletionWorker.close()]);
    extractionPushConn.disconnect();
    await sql.end();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main();
