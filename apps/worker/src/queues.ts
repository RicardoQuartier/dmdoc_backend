import { Queue, type ConnectionOptions } from 'bullmq';
import { type DocumentProcessingJobData } from '@dmdoc/shared-types';

export type { DocumentProcessingJobData } from '@dmdoc/shared-types';

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
