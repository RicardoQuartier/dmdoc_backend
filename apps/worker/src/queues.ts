import { Queue, type ConnectionOptions } from 'bullmq';
import {
  type DocumentProcessingJobData,
  type TenantDeletionJobData,
} from '@dmdoc/shared-types';

export type {
  DocumentProcessingJobData,
  TenantDeletionJobData,
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
