import { Queue, type ConnectionOptions } from 'bullmq';

/**
 * Nome da fila de processamento de documentos.
 *
 * O pipeline completo (extração, chunking, embeddings, persistência) é da
 * Fase 3 — ver spec §8. Na Fase 0 a fila é apenas registrada/vazia: nenhum
 * job é enfileirado aqui.
 */
export const DOCUMENT_PROCESSING_QUEUE = 'document-processing';

/**
 * Payload esperado de um job de processamento de documento.
 *
 * Placeholder da Fase 0 — o shape definitivo (e sua validação Zod na borda da
 * fila) será definido na Fase 3 junto com o pipeline. Mantido aqui apenas
 * para tipar a `Queue`/`Worker` desde já.
 */
export interface DocumentProcessingJobData {
  tenantId: string;
  documentId: string;
}

/**
 * Fábrica da fila de processamento de documentos.
 *
 * Recebe a conexão Redis por injeção para manter `config`/`process.env` fora
 * deste módulo e facilitar testes. Default job options (retry exponencial 3x,
 * spec §8) serão configurados ao introduzir o produtor de jobs na Fase 3.
 */
export function createDocumentProcessingQueue(
  connection: ConnectionOptions
): Queue<DocumentProcessingJobData> {
  return new Queue<DocumentProcessingJobData>(DOCUMENT_PROCESSING_QUEUE, {
    connection,
  });
}
