import { Worker, type Job } from 'bullmq';
import { S3Client } from '@aws-sdk/client-s3';
import OpenAI from 'openai';
import { MongoDbClient } from '@dmdoc/db-mongo';
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
 * Cria o cliente S3 com as configurações do ambiente.
 * `endpoint` é opcional — usado para MinIO em dev ou S3-compatible em prod.
 */
function createS3Client(): S3Client {
  return new S3Client({
    region: config.AWS_REGION,
    ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT, forcePathStyle: true } : {}),
    ...(config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: config.AWS_ACCESS_KEY_ID,
            secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });
}

/**
 * Cria o processor do BullMQ que valida e executa o pipeline completo.
 *
 * As deps são construídas uma única vez no boot e injetadas em cada job.
 * Nenhum `process.env` é lido aqui — apenas `config` (Zod-validated).
 */
function createDocumentProcessor(deps: PipelineDeps) {
  return async (job: Job<DocumentProcessingJobData>): Promise<void> => {
    // Validar payload do job na borda do worker (spec §8)
    // Mutamos job.data para garantir que os tipos Zod estão validados
    job.data = DocumentProcessingJobDataSchema.parse(job.data);
    await runPipeline(job, deps);
  };
}

/**
 * Cria o Worker BullMQ ligado à fila de processamento de documentos.
 *
 * As deps (MongoDB, S3, OpenAI, extractor) são passadas por injeção para
 * permitir testes sem recursos reais.
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
 * Entrypoint do worker. Inicializa todas as dependências (MongoDB, S3, OpenAI,
 * extractor) e cria o Worker BullMQ.
 *
 * Erros não tratados são logados; o processo não é derrubado por falha de job
 * individual (spec §8: "worker nunca derruba o processo").
 */
async function main(): Promise<void> {
  logger.info('inicializando dependências do worker');

  // MongoDB
  const mongoClient = await MongoDbClient.connect(config.MONGO_URI, config.MONGO_DB);
  const db = mongoClient.getDb();
  logger.info({ db: config.MONGO_DB }, 'MongoDB conectado');

  // S3
  const s3 = createS3Client();
  logger.info({ bucket: config.AWS_S3_BUCKET, region: config.AWS_REGION }, 'S3 client criado');

  // OpenAI (embeddings)
  const openai = new OpenAI({
    apiKey: config.OPENAI_API_KEY ?? '',
  });
  logger.info({ model: config.EMBEDDING_MODEL }, 'OpenAI client criado');

  // Extractor
  const extractor = createExtractor(
    config.EXTRACTOR === 'unstructured'
      ? {
          type: 'unstructured',
          unstructured: {
            apiUrl: config.UNSTRUCTURED_URL ?? 'http://localhost:8000/general/v0/general',
            ...(config.UNSTRUCTURED_API_KEY ? { apiKey: config.UNSTRUCTURED_API_KEY } : {}),
          },
        }
      : { type: 'native' }
  );
  logger.info({ extractor: config.EXTRACTOR }, 'extractor criado');

  const deps: PipelineDeps = {
    s3,
    s3Bucket: config.AWS_S3_BUCKET,
    extractor,
    openai,
    embeddingModel: config.EMBEDDING_MODEL,
    db,
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
    await mongoClient.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main();
