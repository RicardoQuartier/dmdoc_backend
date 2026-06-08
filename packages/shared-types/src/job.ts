import { z } from 'zod';

/**
 * Payload de um job de processamento de documento na fila BullMQ.
 *
 * Este schema é a única fonte de verdade para o contrato entre o produtor de
 * jobs (API, rota POST /documents) e o consumidor (worker). Ambos importam
 * daqui — nunca duplicar.
 *
 * Validado na borda: o produtor valida com `DocumentProcessingJobDataSchema`
 * antes de enfileirar; o worker valida no início do handler antes de processar.
 *
 * Campos:
 * - `tenantId` / `documentId`: identificam o documento sem necessidade de
 *   lookup adicional no início do job.
 * - `s3Key`: chave completa no bucket S3 para o worker baixar o arquivo
 *   original sem precisar consultar o banco.
 * - `mimeType`: indica ao extrator qual parser usar sem precisar detectar
 *   o tipo novamente.
 *
 * Spec §5.3 (coleção `jobs`) e spec §8 (pipeline de processamento).
 */
export const DocumentProcessingJobDataSchema = z.object({
  tenantId: z.string().uuid(),
  documentId: z.string().uuid(),
  s3Key: z.string().min(1),
  mimeType: z.string().min(1),
});

export type DocumentProcessingJobData = z.infer<typeof DocumentProcessingJobDataSchema>;
