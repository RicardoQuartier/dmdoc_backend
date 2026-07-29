import { Worker, type Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import { purgeTenantData } from '@dmdoc/db-pg';
import { TenantDeletionJobDataSchema } from '@dmdoc/shared-types';
import type { S3Config } from '@dmdoc/storage';
import { config } from './config.js';
import { createRedisConnection } from './redis.js';
import { TENANT_DELETION_QUEUE, type TenantDeletionJobData } from './queues.js';
import type { StorageForTenant } from './storage.js';
import { purgeTenantStorage } from './tenant-storage-purge.js';

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
  /** Resolve o destino de armazenamento — por CONFIGURAÇÃO, não só o ativo. */
  storage: StorageForTenant;
  logger: Logger;
  /**
   * Bucket DA PLATAFORMA. Necessário para identificar o destino de plataforma na
   * varredura: ele é o único que não tem linha em `tenant_storage_configs`.
   */
  platformS3Config: S3Config;
}

/**
 * Cria o processor BullMQ que valida o payload e executa a purga do tenant.
 *
 * O payload é revalidado na borda do worker com `TenantDeletionJobDataSchema`
 * (mesmo schema usado pelo produtor na API). `purgeTenantData` é idempotente,
 * então o retry exponencial da fila é seguro após falha parcial — a remoção dos
 * arquivos é feita via callback `deleteStoragePrefix`.
 *
 * ## O que o callback faz (T-142)
 *
 * Varre o prefixo em TODOS os destinos que a empresa já usou, não apenas no
 * atual: configurações ativas e aposentadas, mais o bucket da plataforma quando
 * ainda houver documento apontando para lugar nenhum. Uma empresa com migração
 * pela metade — ou concluída sem `cleanup-source` — tem o acervo em dois lugares
 * ao mesmo tempo, e varrer só o corrente deixaria arquivo de cliente para trás.
 * O levantamento, a deduplicação por lugar físico e a tolerância a falha por
 * destino estão em `tenant-storage-purge.ts`.
 *
 * A resolução acontece DENTRO do callback, e não no boot, porque o destino é por
 * empresa e este worker atende todas. E o callback roda ANTES da transação de
 * banco (inversão deliberada da T-142): é lá que estão tanto as credenciais
 * (`tenant_storage_configs.encrypted_secret`) quanto o inventário de destinos
 * (`documents.storage_config_id`) — depois da purga, nenhum dos dois existe.
 */
function createTenantDeletionProcessor(deps: TenantDeletionWorkerDeps) {
  return async (job: Job<TenantDeletionJobData>): Promise<void> => {
    const { tenantId } = TenantDeletionJobDataSchema.parse(job.data);

    deps.logger.info({ jobId: job.id, tenantId }, 'iniciando purga de tenant');

    await purgeTenantData(deps.sql, tenantId, {
      // `tenantId` vem do contrato (e não do closure) de propósito: é a chave
      // com que a varredura levanta os destinos.
      deleteStoragePrefix: async ({ tenantId: target, prefix }) => {
        await purgeTenantStorage(
          {
            sql: deps.sql,
            storage: deps.storage,
            logger: deps.logger,
            platformS3Config: deps.platformS3Config,
          },
          target,
          prefix
        );
      },
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
