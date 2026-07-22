import { Queue, type ConnectionOptions } from 'bullmq';
import {
  type DocumentProcessingJobData,
  type TenantDeletionJobData,
  type AiReprocessJobData,
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
