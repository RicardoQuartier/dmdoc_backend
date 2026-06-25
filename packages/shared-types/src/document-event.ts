import { z } from 'zod';

/**
 * Tipo de evento de documento. No MVP existe apenas `upload`, mas o campo é
 * mantido explícito para evolução futura (ex.: `reprocess`, `download`).
 *
 * Spec §5.3 (coleção `document_events`).
 */
export const DocumentEventTypeSchema = z.enum(['upload']);

export type DocumentEventType = z.infer<typeof DocumentEventTypeSchema>;

/**
 * Evento de upload — registro IMUTÁVEL e APPEND-ONLY que alimenta o relatório
 * de uso/cobrança (Fase 5).
 *
 * Diverge de propósito da coleção `documents` (spec §5.3, wiki "Histórico de
 * eventos de upload e relatório de uso"):
 *
 * - **NÃO carrega `deleted`** e **NÃO é filtrado por `deleted:false`** — o upload
 *   aconteceu e deve ser contado para sempre, mesmo após o documento ser
 *   excluído logicamente. Por isso esta coleção não passa pelo `TenantRepository`.
 * - Continua **escopado por `tenantId`** — isolamento inegociável.
 * - **Dimensões denormalizadas** no momento do upload (formato, tipo, tamanho),
 *   para um relatório de período passado não mudar quando o acervo muda.
 * - `documentId` é `null` somente em cenários teóricos de dedup sem doc novo; na
 *   prática o evento sempre referencia um documento existente (o reaproveitado
 *   na dedup, ou o recém-criado no upload normal).
 * - `pageCount` nasce `null` e recebe backfill quando o worker conclui a
 *   extração (única mutação permitida sobre um evento).
 */
export const DocumentEventSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  documentId: z.string().uuid().nullable(),
  uploadedById: z.string().uuid(),
  eventType: DocumentEventTypeSchema,
  mimeType: z.string().min(1).max(200),
  documentTypeId: z.string().uuid().nullable(),
  documentTypeName: z.string().min(1).max(200).nullable(),
  sizeBytes: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative().nullable(),
  deduplicated: z.boolean(),
  createdAt: z.date(),
});

export type DocumentEvent = z.infer<typeof DocumentEventSchema>;

/**
 * Input de criação de um evento de upload. O repositório append-only gera `id`
 * (se ausente), injeta `tenantId` do contexto e grava `createdAt`. Quem chama
 * nunca informa esses três campos.
 */
export const CreateDocumentEventInputSchema = DocumentEventSchema.omit({
  id: true,
  tenantId: true,
  createdAt: true,
}).extend({
  /** Opcional: idempotência/seed. Gerado quando ausente. */
  id: z.string().uuid().optional(),
});

export type CreateDocumentEventInput = z.infer<typeof CreateDocumentEventInputSchema>;
