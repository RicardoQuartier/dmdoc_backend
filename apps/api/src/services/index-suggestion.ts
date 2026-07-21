import type { Sql, JSONValue } from '@dmdoc/db-pg';
import {
  suggestIndexValues,
  SUGGEST_INDEXES_PROMPT,
  type LLMProvider,
  type IndexFieldRow,
  type SuggestedIndexField,
} from '@dmdoc/llm-provider';
import type { IndexSuggestion, CostBreakdown } from '@dmdoc/shared-types';
import { NotFoundError, ValidationError } from '../errors/index.js';

/**
 * Interface mínima de logger — compatível com Pino Logger e FastifyBaseLogger.
 * Mesmo padrão de `openai-provider.ts` e `embedding.ts`.
 */
interface MinimalLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  child(bindings: Record<string, unknown>): MinimalLogger;
}

export interface SuggestDocumentIndexesParams {
  tenantId: string;
  documentId: string;
  /**
   * Tipo de documento a usar na sugestão. Quando FORNECIDO (caminho do worker,
   * que passa o tipo SUGERIDO pela classificação), é usado diretamente e o
   * `documents.document_type_id` NÃO é lido/exigido — CONSULTIVO, nunca toca a
   * escolha manual. Quando AUSENTE (caminho on-demand `POST
   * /documents/:id/suggest-indexes`), o service lê `documents.document_type_id`
   * e lança `ValidationError` se estiver `null` — comportamento HTTP inalterado.
   */
  documentTypeId?: string;
}

export interface SuggestDocumentIndexesDeps {
  sql: Sql;
  llmProvider: LLMProvider;
  logger: MinimalLogger;
}

/**
 * Reexporta o tipo por campo do núcleo compartilhado — é exatamente o array
 * `fields` da resposta HTTP de `POST /documents/:id/suggest-indexes`.
 */
export type { SuggestedIndexField };

export interface SuggestDocumentIndexesResult {
  /** Sugestão persistida em `document_content.index_suggestion`. */
  indexSuggestion: IndexSuggestion;
  /**
   * Sugestão por campo, derivada dos campos REAIS do tipo — pronta para a
   * resposta HTTP. Campos alucinados pelo LLM são descartados no núcleo.
   */
  fields: SuggestedIndexField[];
  /** `cost_breakdown` completo já atualizado (acumulado) do documento. */
  costBreakdown: CostBreakdown;
  /** Custo em USD APENAS desta chamada (não o acumulado) — para exibição/log. */
  costUsd: number;
}

/**
 * Serviço de sugestão de valores de índice por IA (Fase 7) — ORQUESTRADOR
 * on-demand (com banco). A lógica de IA (LLM + normalize pt-BR + validate +
 * prompt) vive no núcleo compartilhado `suggestIndexValues`
 * (`@dmdoc/llm-provider`); aqui ficam apenas as leituras/escritas de banco e a
 * acumulação de custo — mesmo padrão de `classify-document.ts`/`classify.ts`.
 *
 * Fluxo:
 * 1. Resolve o `documentTypeId`: usa o EXPLÍCITO quando fornecido (worker, tipo
 *    sugerido); senão lê `documents.document_type_id` (on-demand) — `NotFoundError`
 *    se o documento não existir, `ValidationError` se ainda não tiver tipo.
 * 2. Lê `document_content.full_text` (texto completo) e os campos do tipo.
 * 3. Chama o núcleo (`suggestIndexValues`) — normaliza/valida cada campo.
 * 4. Persiste `document_content.index_suggestion` e acumula
 *    `cost_breakdown.suggestionUsd` (nunca sobrescreve extraction/embeddings/
 *    classification) e `documents.cost_usd_cents` (incrementado). Toda query
 *    filtra por `tenantId`.
 */
export async function suggestDocumentIndexes(
  params: SuggestDocumentIndexesParams,
  deps: SuggestDocumentIndexesDeps
): Promise<SuggestDocumentIndexesResult> {
  const { tenantId, documentId } = params;
  const { sql, llmProvider } = deps;
  const log = deps.logger.child({ tenantId, documentId, step: 'suggest-indexes' });

  // 1. Resolve o tipo do documento -------------------------------------------
  let documentTypeId: string;
  if (params.documentTypeId !== undefined) {
    // Caminho do worker: tipo SUGERIDO explícito. Não lê nem exige o tipo
    // confirmado (`documents.document_type_id`) — CONSULTIVO.
    documentTypeId = params.documentTypeId;
  } else {
    // Caminho on-demand: lê o tipo confirmado. Comportamento HTTP inalterado.
    const docRows = await sql<Array<{ document_type_id: string | null }>>`
      SELECT document_type_id
      FROM documents
      WHERE id = ${documentId}
        AND tenant_id = ${tenantId}
        AND deleted = false
      LIMIT 1
    `;
    const doc = docRows[0];
    if (!doc) {
      throw new NotFoundError('Documento não encontrado');
    }
    if (doc.document_type_id === null) {
      throw new ValidationError(
        'Documento precisa ter um tipo de documento definido antes de sugerir índices'
      );
    }
    documentTypeId = doc.document_type_id;
  }

  // 2. Conteúdo extraído (texto completo, nunca truncado) --------------------
  const contentRows = await sql<
    Array<{ full_text: string; cost_breakdown: CostBreakdown | null }>
  >`
    SELECT full_text, cost_breakdown
    FROM document_content
    WHERE document_id = ${documentId}
      AND tenant_id = ${tenantId}
    LIMIT 1
  `;
  const content = contentRows[0];
  if (!content) {
    throw new NotFoundError('Conteúdo do documento ainda não foi processado');
  }

  // 3. Campos de índice do tipo ----------------------------------------------
  const indexFieldRows = await sql<IndexFieldRow[]>`
    SELECT id, name, field_type, required, ai_extraction_hint, sort_order, show_on_search, deleted
    FROM document_type_index_fields
    WHERE document_type_id = ${documentTypeId}
      AND deleted = false
    ORDER BY sort_order ASC
  `;

  const existingBreakdown: CostBreakdown = content.cost_breakdown ?? {
    extractionUsd: 0,
    embeddingsUsd: 0,
    suggestionUsd: 0,
    classificationUsd: 0,
    totalUsd: 0,
  };

  // 4. Núcleo compartilhado: LLM + normalize + validate (SEM banco) ----------
  const core = await suggestIndexValues(
    llmProvider,
    { fullText: content.full_text, indexFields: indexFieldRows },
    log
  );

  // 5. Persiste indexSuggestion + custo (acumulado, escopado por tenant) -----
  const suggestedAt = new Date();
  const indexSuggestion: IndexSuggestion = {
    values: core.values,
    model: core.model,
    promptVersion: core.promptVersion || SUGGEST_INDEXES_PROMPT.version,
    suggestedAt,
    rawResponse: core.rawResponse,
  };

  const newSuggestionUsd = existingBreakdown.suggestionUsd + core.costUsd;
  const newCostBreakdown: CostBreakdown = {
    extractionUsd: existingBreakdown.extractionUsd,
    embeddingsUsd: existingBreakdown.embeddingsUsd,
    suggestionUsd: newSuggestionUsd,
    classificationUsd: existingBreakdown.classificationUsd,
    totalUsd:
      existingBreakdown.extractionUsd +
      existingBreakdown.embeddingsUsd +
      newSuggestionUsd +
      existingBreakdown.classificationUsd,
  };

  // Payload separado para persistência: `sql.json` exige `JSONValue` (sem
  // `unknown`), diferente do tipo `IndexSuggestion` (rawResponse tipado como
  // `Record<string, unknown>` pelo shared-types) retornado ao chamador.
  await sql`
    UPDATE document_content
    SET index_suggestion = ${sql.json({
      values: core.values,
      model: core.model,
      promptVersion: indexSuggestion.promptVersion,
      suggestedAt: suggestedAt.toISOString(),
      rawResponse: core.rawResponse,
    } as unknown as JSONValue)},
        cost_breakdown = ${sql.json(newCostBreakdown)}
    WHERE document_id = ${documentId}
      AND tenant_id = ${tenantId}
  `;

  // documents.cost_usd_cents é SEMPRE incrementado, nunca sobrescrito — outras
  // etapas (extração, embeddings, classificação) já podem ter contribuído.
  const deltaCents = Math.ceil(core.costUsd * 100);
  if (deltaCents > 0) {
    await sql`
      UPDATE documents
      SET cost_usd_cents = cost_usd_cents + ${deltaCents}
      WHERE id = ${documentId}
        AND tenant_id = ${tenantId}
    `;
  }

  return { indexSuggestion, fields: core.fields, costBreakdown: newCostBreakdown, costUsd: core.costUsd };
}
