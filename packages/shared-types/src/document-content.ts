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
 * Teto de tags geradas por IA por documento (Fase 9 / E-3, pedido do Owner:
 * "até no máximo 30"). Também aplicado no schema de saída do LLM
 * (`generate-tags.ts`). Excedente é truncado no núcleo, nunca rejeitado.
 */
export const MAX_GENERATED_TAGS = 30;

/** Tamanho máximo (em caracteres) de uma tag — defensivo contra tag-lixo. */
export const MAX_TAG_LENGTH = 60;

/**
 * Sugestão de TAGS gerada por LLM (Fase 9 / E-3) — CONSULTIVA.
 *
 * Embutido em `DocumentContent.suggestedTags`. Espelha o padrão de
 * `IndexSuggestion`/`TypeSuggestion`: além das tags, registra o modelo usado, a
 * versão do prompt, o instante e a resposta bruta do LLM para auditoria.
 *
 * A sugestão NUNCA sobrescreve `documents.tags` (tags CONFIRMADAS pelo
 * usuário) — a decisão do usuário sempre vence e sobrevive a reprocessamento.
 * O worker/endpoint sob demanda apenas gravam aqui; a confirmação é um gesto
 * explícito do usuário (aceitar no card de sugestão da tela de detalhe).
 */
export const SuggestedTagsSchema = z.object({
  tags: z.array(z.string().min(1).max(MAX_TAG_LENGTH)).max(MAX_GENERATED_TAGS),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  generatedAt: z.date(),
  rawResponse: z.record(z.unknown()),
});

export type SuggestedTags = z.infer<typeof SuggestedTagsSchema>;

/**
 * Subconjunto SEGURO da sugestão de tags exposto ao usuário comum no
 * `GET /documents/:id` e no `POST /documents/:id/generate-tags` (Fase 9).
 *
 * Contém só o que o card de sugestão da tela de detalhe precisa — as tags e o
 * instante da geração. Campos de auditoria/operação (`model`, `promptVersion`,
 * `rawResponse`) NUNCA vazam no endpoint público; ficam restritos ao
 * `GET /documents/:id/debug` (SUPER_ADMIN).
 *
 * `generatedAt` é validado como string ISO porque no JSONB persistido a data é
 * gravada serializada (mesmo tratamento de `PublicIndexSuggestionSchema`). O
 * `parse` do Zod descarta as chaves desconhecidas, então validar o JSONB bruto
 * com este schema já remove os campos sensíveis.
 */
export const PublicSuggestedTagsSchema = z.object({
  tags: z.array(z.string()),
  generatedAt: z.string(),
});

export type PublicSuggestedTags = z.infer<typeof PublicSuggestedTagsSchema>;

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
  // Custo da geração automática de tags por IA (Fase 9 / E-3). Default 0 para
  // compatibilidade com breakdowns persistidos antes desta etapa existir.
  tagGenerationUsd: z.number().nonnegative().default(0),
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
  suggestedTags: SuggestedTagsSchema.nullable(),
  costBreakdown: CostBreakdownSchema.nullable(),
});

export type DocumentContent = z.infer<typeof DocumentContentSchema>;
