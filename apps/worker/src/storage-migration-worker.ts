import { Worker, type Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import { config } from './config.js';
import { createRedisConnection } from './redis.js';
import {
  STORAGE_MIGRATION_QUEUE,
  StorageMigrationJobDataSchema,
  type StorageMigrationJobData,
} from './queues.js';
import type { StorageForTenant } from './storage.js';
import { runStorageMigration } from './storage-migration.js';

/**
 * Worker de migração de acervo entre destinos de armazenamento
 * (épico E-11 / T-141). Molde do `tenant-deletion-worker.ts`: valida o payload
 * na borda, delega o trabalho pesado e traduz o resultado para o log.
 *
 * A lógica da migração mora em `storage-migration.ts`, fora deste arquivo, pelo
 * mesmo motivo do `ai-reprocess-worker`: este módulo carrega `config` (que lê o
 * ambiente no import) e a conexão do Redis, e a peça que interessa testar —
 * seleção, verificação de hash, comutação, retomada — não depende de nenhum dos
 * dois.
 */

/**
 * Migrações de EMPRESAS em paralelo.
 *
 * Uma: o paralelismo que importa é o de DOCUMENTOS, e ele acontece dentro do
 * job (`STORAGE_MIGRATION_CONCURRENCY`). Duas empresas migrando ao mesmo tempo
 * multiplicariam a banda e a pressão de 429 sem encurtar nenhuma das duas — e o
 * índice único parcial `uniq_storage_migration_running` já garante que uma
 * mesma empresa nunca tem duas migrações vivas.
 */
const STORAGE_MIGRATION_CONCURRENCY = 1;

export interface StorageMigrationWorkerDeps {
  sql: Sql;
  /** Resolve o driver de cada configuração — a origem de cada documento e o destino. */
  storage: StorageForTenant;
  logger: Logger;
}

/**
 * Processor BullMQ da migração de acervo.
 *
 * NÃO re-lança em falha de documento: uma cópia que falhou já foi contada em
 * `failed_docs` e o documento continua servível na origem. O que derruba o job
 * (e aciona o retry da fila) é falha de INFRA — banco fora, configuração de
 * destino ilegível —, situação em que uma nova tentativa faz sentido e retoma
 * do ponto em que parou.
 */
function createStorageMigrationProcessor(deps: StorageMigrationWorkerDeps) {
  return async (job: Job<StorageMigrationJobData>): Promise<void> => {
    const { tenantId, migrationId } = StorageMigrationJobDataSchema.parse(job.data);

    deps.logger.info({ jobId: job.id, tenantId, migrationId }, 'iniciando migração de acervo');

    const summary = await runStorageMigration(
      { sql: deps.sql, storage: deps.storage, logger: deps.logger },
      { tenantId, migrationId }
    );

    deps.logger.info(
      {
        jobId: job.id,
        tenantId,
        migrationId,
        outcome: summary.outcome,
        total: summary.total,
        migrated: summary.migrated,
        failed: summary.failed,
        storageConfigId: summary.destination.storageConfigId,
      },
      'migração de acervo processada'
    );
  };
}

/**
 * Cria o Worker BullMQ ligado à fila de migração de acervo. Sobe ao lado dos
 * demais workers (documentos, tenant-deletion, ai-reprocess) — não os substitui.
 */
export function createStorageMigrationWorker(
  deps: StorageMigrationWorkerDeps
): Worker<StorageMigrationJobData> {
  const connection = createRedisConnection(config);

  const worker = new Worker<StorageMigrationJobData>(
    STORAGE_MIGRATION_QUEUE,
    createStorageMigrationProcessor(deps),
    {
      connection,
      concurrency: STORAGE_MIGRATION_CONCURRENCY,
    }
  );

  worker.on('failed', (job, err) => {
    deps.logger.error(
      { jobId: job?.id, tenantId: job?.data.tenantId, migrationId: job?.data.migrationId, err },
      'job de migração de acervo falhou'
    );
  });

  worker.on('error', (err) => {
    deps.logger.error({ err }, 'erro no worker de migração de acervo');
  });

  return worker;
}
