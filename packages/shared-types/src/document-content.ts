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
 * `indexSuggestion` e `costBreakdown` são nulos enquanto o pipeline de IA
 * ainda não executou.
 *
 * Spec §5.3 (coleção `document_content`).
 */
export const DocumentContentSchema = z.object({
  documentId: z.string().uuid(),
  tenantId: z.string().uuid(),
  fullText: z.string(),
  extraction: ExtractionResultSchema,
  indexSuggestion: IndexSuggestionSchema.nullable(),
  costBreakdown: CostBreakdownSchema.nullable(),
});

export type DocumentContent = z.infer<typeof DocumentContentSchema>;
