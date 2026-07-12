import { z } from 'zod';

/**
 * Status do processamento de um documento.
 *
 * Transições esperadas:
 *   PENDING → PROCESSING → READY
 *   PENDING → PROCESSING → FAILED
 *
 * Spec §5.3 (coleção `documents`, campo `status`).
 */
export const DocumentStatusSchema = z.enum(['PENDING', 'PROCESSING', 'READY', 'FAILED']);

export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

/**
 * Documento. Entidade central do sistema — representa um arquivo enviado por um
 * usuário de uma empresa.
 *
 * Invariantes:
 * - `(tenantId, contentHash)` é único (deduplicação por SHA-256 do arquivo).
 * - `documentTypeId` é nulo quando o usuário não classificou o documento ainda.
 * - `title` é o título de exibição CONFIRMADO/editado pelo usuário (Fase 8.1).
 *   Nulo até haver confirmação; enquanto nulo, listagens e telas exibem
 *   `originalFilename` como fallback. Independente de `originalFilename`.
 * - `suggestedTitle` é a sugestão BRUTA de título gerada pela IA — consultiva,
 *   nunca exibida como título oficial. Reprocessar sobrescreve `suggestedTitle`,
 *   mas NUNCA toca o `title` já confirmado. `originalFilename` permanece
 *   imutável (atrelado ao arquivo físico) e nenhuma sugestão de IA o substitui.
 * - `mongoContentId` aponta para o `_id` do documento na coleção
 *   `document_content` — preenchido após a extração de texto pelo worker.
 * - `indexValues` é um mapa aberto: chaves correspondem ao `name` dos campos
 *   de índice do `DocumentType` associado.
 * - `processedAt` é nulo enquanto o documento ainda não saiu do estado PENDING.
 * - `costUsdCents` acumula o custo de embeddings + LLM em centavos de dólar.
 *
 * Segue exclusão lógica (`deleted`). Spec §5.3 (coleção `documents`).
 */
export const DocumentSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  departmentId: z.string().uuid(),
  documentTypeId: z.string().uuid().nullable(),
  filename: z.string().min(1).max(500),
  originalFilename: z.string().min(1).max(500),
  title: z.string().nullable(),
  suggestedTitle: z.string().nullable(),
  contentHash: z.string().length(64), // SHA-256 hex
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string().min(1).max(200),
  s3Key: z.string().min(1).max(1000),
  status: DocumentStatusSchema,
  failureReason: z.string().nullable(),
  tags: z.array(z.string()),
  mongoContentId: z.string().nullable(), // ObjectId hex do document_content
  indexValues: z.record(z.union([z.string(), z.number(), z.date(), z.null()])),
  uploadedById: z.string().uuid(),
  uploadedAt: z.date(),
  processedAt: z.date().nullable(),
  costUsdCents: z.number().int().nonnegative(),
  deleted: z.boolean(),
});

export type Document = z.infer<typeof DocumentSchema>;
