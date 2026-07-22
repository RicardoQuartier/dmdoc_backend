import { z } from 'zod';

/**
 * Resultado da extração de texto de um documento.
 *
 * Embutido em `DocumentContent.extraction`. Registra qual engine foi usada,
 * quanto tempo levou, quais páginas precisaram de OCR e o total de páginas.
 *
 * Spec §5.3 (coleção `document_content`, campo `extraction`).
 */
export const ExtractionResultSchema = z.object({
  engine: z.enum(['unstructured', 'native']),
  engineVersion: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
  ocrPages: z.array(z.number().int().nonnegative()),
  pageCount: z.number().int().nonnegative(),
  extractedAt: z.date(),
});

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

/**
 * Sugestão de valores de índice gerada por LLM.
 *
 * Embutido em `DocumentContent.indexSuggestion`. Armazena os valores sugeridos,
 * o modelo usado, a versão do prompt e a resposta bruta do LLM para auditoria.
 *
 * Spec §5.3 (coleção `document_content`, campo `indexSuggestion`).
 */
export const IndexSuggestionSchema = z.object({
  values: z.record(z.string()),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  suggestedAt: z.date(),
  rawResponse: z.record(z.unknown()),
});

export type IndexSuggestion = z.infer<typeof IndexSuggestionSchema>;

/**
 * Sugestão de tipo de documento gerada por LLM (Fase 8) — CONSULTIVA.
 *
 * Embutido em `DocumentContent.typeSuggestion`. Espelha o padrão de
 * `IndexSuggestion`: registra o tipo sugerido, a confiança, o modelo usado, a
 * versão do prompt e a resposta bruta do LLM para auditoria.
 *
 * A sugestão NUNCA sobrescreve `documents.documentTypeId` — a escolha manual do
 * usuário sempre vence e sobrevive a reprocessamento. Quando nenhum tipo do
 * catálogo se encaixa, a IA retorna `documentTypeId`/`documentTypeName` nulos
 * com confiança baixa (fallback "nenhum tipo").
 *
 * Spec §5.3 (coleção `document_content`, campo `typeSuggestion`).
 */
export const TypeSuggestionSchema = z.object({
  documentTypeId: z.string().uuid().nullable(),
  documentTypeName: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  suggestedAt: z.date(),
  rawResponse: z.record(z.unknown()),
});

export type TypeSuggestion = z.infer<typeof TypeSuggestionSchema>;

/**
 * Subconjunto SEGURO da sugestão de tipo exposto ao usuário comum no
 * `GET /documents/:id` (Fase 8).
 *
 * Contém apenas o que a tela de qualificação precisa — tipo sugerido,
 * nome e confiança. Campos de auditoria/operação (`model`, `promptVersion`,
 * `suggestedAt`, `rawResponse`) NUNCA vazam no endpoint público; ficam
 * restritos ao `GET /documents/:id/debug` (SUPER_ADMIN), que devolve o
 * `TypeSuggestionSchema` completo.
 *
 * Derivado de `TypeSuggestionSchema` (não duplica campos): por padrão o Zod
 * remove chaves desconhecidas no `parse`, então validar o JSONB bruto com este
 * schema já descarta os campos sensíveis.
 */
export const PublicTypeSuggestionSchema = TypeSuggestionSchema.pick({
  documentTypeId: true,
  documentTypeName: true,
  confidence: true,
});

export type PublicTypeSuggestion = z.infer<typeof PublicTypeSuggestionSchema>;

/**
 * Subconjunto SEGURO da sugestão de valores de índice exposto ao usuário comum
 * no `GET /documents/:id` (Fase 7 — gatilhos automáticos da T-16).
 *
 * Contém apenas o que a tela de qualificação/revisão precisa para pré-preencher
 * os campos: os valores sugeridos (já normalizados/validados pelo worker) e o
 * instante da sugestão. Campos de auditoria/operação (`model`, `promptVersion`,
 * `rawResponse`) NUNCA vazam no endpoint público; ficam restritos ao
 * `GET /documents/:id/debug` (SUPER_ADMIN), que devolve o `IndexSuggestion`
 * completo.
 *
 * `suggestedAt` é validado como string ISO porque no JSONB persistido a data é
 * gravada serializada (diferente do `IndexSuggestionSchema`, que usa `z.date()`
 * para o modelo de domínio). O `parse` do Zod descarta as chaves desconhecidas,
 * então validar o JSONB bruto com este schema já remove os campos sensíveis.
 */
export const PublicIndexSuggestionSchema = z.object({
  values: z.record(z.string()),
  suggestedAt: z.string(),
});

export type PublicIndexSuggestion = z.infer<typeof PublicIndexSuggestionSchema>;

/**
 * Breakdown de custo em dólares para o processamento de um documento.
 *
 * Embutido em `DocumentContent.costBreakdown`. Campos separados por etapa
 * para facilitar análise de custo por operação.
 *
 * Spec §5.3 (coleção `document_content`, campo `costBreakdown`).
 */
export const CostBreakdownSchema = z.object({
  extractionUsd: z.number().nonnegative(),
  embeddingsUsd: z.number().nonnegative(),
  suggestionUsd: z.number().nonnegative(),
  classificationUsd: z.number().nonnegative().default(0),
  totalUsd: z.number().nonnegative(),
});

export type CostBreakdown = z.infer<typeof CostBreakdownSchema>;

/**
 * Conteúdo extraído de um documento. Armazena o texto completo e metadados de
 * extração, sugestão de índices e breakdown de custo.
 *
 * Relação 1-para-1 com `documents`: cada documento tem no máximo um
 * `document_content`. Referenciado por `documents.mongoContentId`.
 *
 * `indexSuggestion`, `typeSuggestion` e `costBreakdown` são nulos enquanto o
 * pipeline de IA ainda não executou.
 *
 * Spec §5.3 (coleção `document_content`).
 */
export const DocumentContentSchema = z.object({
  documentId: z.string().uuid(),
  tenantId: z.string().uuid(),
  fullText: z.string(),
  extraction: ExtractionResultSchema,
  indexSuggestion: IndexSuggestionSchema.nullable(),
  typeSuggestion: TypeSuggestionSchema.nullable(),
  costBreakdown: CostBreakdownSchema.nullable(),
});

export type DocumentContent = z.infer<typeof DocumentContentSchema>;
