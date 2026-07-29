import { Queue, type ConnectionOptions } from 'bullmq';
import {
  type DocumentProcessingJobData,
  type TenantDeletionJobData,
  type AiReprocessJobData,
  type StorageMigrationJobData,
} from '@dmdoc/shared-types';

export type {
  DocumentProcessingJobData,
  TenantDeletionJobData,
  AiReprocessJobData,
} from '@dmdoc/shared-types';

/**
 * Nome da fila de processamento de documentos.
 *
 * O pipeline completo (extração, chunking, embeddings, persistência) é da
 * Fase 3 — ver spec §8. Na Fase 0 a fila é apenas registrada/vazia: nenhum
 * job é enfileirado aqui.
 */
export const DOCUMENT_PROCESSING_QUEUE = 'document-processing';

/**
 * Fábrica da fila de processamento de documentos.
 *
 * Recebe a conexão Redis por injeção para manter `config`/`process.env` fora
 * deste módulo e facilitar testes. Default job options (retry exponencial 3x,
 * spec §8) serão configurados ao introduzir o produtor de jobs na Fase 3.
 *
 * O tipo `DocumentProcessingJobData` agora vem de `@dmdoc/shared-types` —
 * fonte única de verdade para o contrato produtor/consumidor. Spec §8.
 */
export function createDocumentProcessingQueue(
  connection: ConnectionOptions
): Queue<DocumentProcessingJobData> {
  return new Queue<DocumentProcessingJobData>(DOCUMENT_PROCESSING_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    },
  });
}

/**
 * Nome da fila de exclusão (purga) de empresa (tenant).
 *
 * Enfileirada pela API após o soft-delete do tenant; consumida pelo worker, que
 * executa a purga pesada (banco + storage) em background (spec §14, fase 6).
 */
export const TENANT_DELETION_QUEUE = 'tenant-deletion';

/**
 * Fábrica da fila de exclusão de empresa.
 *
 * A purga é idempotente (`purgeTenantData`), então o retry exponencial do BullMQ
 * é seguro após falha parcial. A conexão Redis é injetada para manter
 * `config`/`process.env` fora deste módulo. Mesmo padrão de
 * `createDocumentProcessingQueue`.
 */
export function createTenantDeletionQueue(
  connection: ConnectionOptions
): Queue<TenantDeletionJobData> {
  return new Queue<TenantDeletionJobData>(TENANT_DELETION_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    },
  });
}

/**
 * Nome da fila DEDICADA de reprocessamento de IA em massa (épico E-4 / T-24).
 *
 * Fila separada da `document-processing` porque o payload e o processor são
 * distintos: aqui roda-se SÓ as etapas de IA (título/tipo, índices, tags) sobre
 * documentos já processados — sem re-extrair, re-embeddar nem apagar chunks.
 * Misturar na fila de processamento quebraria o processor existente, que valida
 * `DocumentProcessingJobDataSchema` para todo job daquela fila.
 */
export const AI_REPROCESS_QUEUE = 'ai-reprocess';

/**
 * Fábrica da fila de reprocessamento de IA em massa.
 *
 * `attempts: 1` (SEM retry): cada job incrementa EXATAMENTE uma vez o contador
 * do lote (`done`/`failed`). Um retry re-incrementaria e corromperia o total —
 * por isso a fila não re-tenta. Falhas de LLM por etapa já são best-effort
 * dentro do processor (não derrubam o job), então retry traria pouco ganho e
 * muito risco de contagem dupla.
 */
export function createAiReprocessQueue(
  connection: ConnectionOptions
): Queue<AiReprocessJobData> {
  return new Queue<AiReprocessJobData>(AI_REPROCESS_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 1,
    },
  });
}

/**
 * Nome da fila de migração de acervo entre destinos de armazenamento
 * (épico E-11 / T-141).
 *
 * Enfileirada pela API (`POST /admin/tenants/:id/storage/migrate`) depois de
 * criar a linha em `storage_migrations`; consumida pelo worker dedicado, que
 * copia os arquivos dos destinos anteriores para o ativo.
 */
export const STORAGE_MIGRATION_QUEUE = 'storage-migration';

/**
 * Payload do job de migração de acervo.
 *
 * `migrationId` é a linha de `storage_migrations` — a autoridade sobre o estado
 * da migração (progresso, cancelamento, resultado). O job carrega só o id: o
 * destino e a lista de documentos são resolvidos NO WORKER, no instante em que
 * ele começa, e não congelados no payload. Congelá-los reintroduziria a janela
 * em que a fila trabalha sobre um mundo que já mudou.
 *
 * O schema nasceu declarado aqui, enquanto `@dmdoc/shared-types` não tinha a
 * forma; promovido para lá (dona: violet-chan), este arquivo volta a ser só o
 * ponto de re-exportação, como já é para os outros três jobs acima. Duas
 * declarações da MESMA forma é o que produz produtor e consumidor validando
 * contratos que divergiram sem ninguém perceber.
 */
export {
  StorageMigrationJobDataSchema,
  type StorageMigrationJobData,
} from '@dmdoc/shared-types';

/**
 * Fábrica da fila de migração de acervo.
 *
 * `attempts: 3` com backoff exponencial: a migração é idempotente e RETOMÁVEL —
 * uma nova tentativa reseleciona o que ainda falta (`IS DISTINCT FROM`) e não
 * recopia o que já passou. Diferente do `ai-reprocess`, aqui o retry não
 * corrompe contador nenhum, porque os contadores são zerados a cada passada.
 */
export function createStorageMigrationQueue(
  connection: ConnectionOptions
): Queue<StorageMigrationJobData> {
  return new Queue<StorageMigrationJobData>(STORAGE_MIGRATION_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    },
  });
}
