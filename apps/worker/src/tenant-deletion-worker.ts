import { Worker, type Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import { purgeTenantData } from '@dmdoc/db-pg';
import { TenantDeletionJobDataSchema } from '@dmdoc/shared-types';
import { config } from './config.js';
import { createRedisConnection } from './redis.js';
import { TENANT_DELETION_QUEUE, type TenantDeletionJobData } from './queues.js';
import type { WorkerS3 } from './s3.js';

/**
 * Concorrência baixa: a purga de uma empresa é pesada (transação grande no
 * Postgres + remoção em massa no storage). Processar um tenant por vez evita
 * contenção e mantém o uso de recursos previsível.
 */
const TENANT_DELETION_CONCURRENCY = 1;

/**
 * Dependências injetadas no worker de exclusão de empresa. Construídas uma única
 * vez no boot (`worker.ts main()`) e reutilizadas em cada job.
 */
export interface TenantDeletionWorkerDeps {
  sql: Sql;
  s3: WorkerS3;
  logger: Logger;
}

/**
 * Cria o processor BullMQ que valida o payload e executa a purga do tenant.
 *
 * O payload é revalidado na borda do worker com `TenantDeletionJobDataSchema`
 * (mesmo schema usado pelo produtor na API). `purgeTenantData` é idempotente,
 * então o retry exponencial da fila é seguro após falha parcial — a remoção do
 * storage é feita via callback `deleteS3Prefix`.
 */
function createTenantDeletionProcessor(deps: TenantDeletionWorkerDeps) {
  return async (job: Job<TenantDeletionJobData>): Promise<void> => {
    const { tenantId } = TenantDeletionJobDataSchema.parse(job.data);

    deps.logger.info({ jobId: job.id, tenantId }, 'iniciando purga de tenant');

    await purgeTenantData(deps.sql, tenantId, {
      deleteS3Prefix: (prefix) => deps.s3.deleteByPrefix(prefix),
      logger: deps.logger,
    });
  };
}

/**
 * Cria o Worker BullMQ ligado à fila de exclusão de empresa.
 *
 * Sobe ao lado do worker de documentos (não o substitui). Handlers de
 * `failed`/`completed`/`error` registram log estruturado incluindo `tenantId`.
 */
export function createTenantDeletionWorker(
  deps: TenantDeletionWorkerDeps
): Worker<TenantDeletionJobData> {
  const connection = createRedisConnection(config);

  const worker = new Worker<TenantDeletionJobData>(
    TENANT_DELETION_QUEUE,
    createTenantDeletionProcessor(deps),
    {
      connection,
      concurrency: TENANT_DELETION_CONCURRENCY,
    }
  );

  worker.on('failed', (job, err) => {
    deps.logger.error(
      { jobId: job?.id, tenantId: job?.data.tenantId, err },
      'job de exclusão de tenant falhou'
    );
  });

  worker.on('error', (err) => {
    deps.logger.error({ err }, 'erro no worker de exclusão de tenant');
  });

  worker.on('completed', (job) => {
    deps.logger.info(
      { jobId: job.id, tenantId: job.data.tenantId },
      'purga de tenant concluída com sucesso'
    );
  });

  return worker;
}
