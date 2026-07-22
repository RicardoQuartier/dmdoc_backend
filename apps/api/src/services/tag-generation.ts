import type { Sql, JSONValue } from '@dmdoc/db-pg';
import { generateTags, type LLMProvider } from '@dmdoc/llm-provider';
import type { CostBreakdown } from '@dmdoc/shared-types';
import { NotFoundError } from '../errors/index.js';

/**
 * Interface mínima de logger — compatível com Pino Logger e FastifyBaseLogger.
 * Mesmo padrão de `index-suggestion.ts`/`classify-document.ts`.
 */
interface MinimalLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  child(bindings: Record<string, unknown>): MinimalLogger;
}

export interface GenerateDocumentTagsParams {
  tenantId: string;
  documentId: string;
}

export interface GenerateDocumentTagsDeps {
  sql: Sql;
  llmProvider: LLMProvider;
  logger: MinimalLogger;
}

export interface GenerateDocumentTagsResult {
  /** Tags sugeridas (normalizadas/validadas), prontas para a resposta HTTP. */
  tags: string[];
  /** Instante da geração — parte do subconjunto público exposto ao usuário. */
  generatedAt: Date;
  /** Modelo que respondeu (auditoria). */
  model: string;
  /** Versão do prompt (rastreabilidade — spec §11). */
  promptVersion: string;
  /** `cost_breakdown` completo já atualizado (acumulado) do documento. */
  costBreakdown: CostBreakdown;
  /** Custo em USD APENAS desta chamada (não o acumulado) — para exibição/log. */
  costUsd: number;
}

/**
 * Serviço de geração de tags por IA (Fase 9 / E-3) — ORQUESTRADOR on-demand
 * (com banco). A lógica de IA (LLM + normalize + prompt) vive no núcleo
 * compartilhado `generateTags` (`@dmdoc/llm-provider`); aqui ficam apenas as
 * leituras/escritas de banco e a acumulação de custo — mesmo padrão de
 * `index-suggestion.ts`.
 *
 * Fluxo:
 * 1. Lê `document_content.full_text` (texto completo) e o `cost_breakdown`
 *    acumulado — `NotFoundError` se o documento ainda não foi processado.
 * 2. Chama o núcleo (`generateTags`) — investiga o texto e normaliza as tags.
 * 3. Persiste `document_content.suggested_tags` e acumula
 *    `cost_breakdown.tagGenerationUsd` (nunca sobrescreve extraction/embeddings/
 *    classification/suggestion) e `documents.cost_usd_cents` (incrementado).
 *    Toda query filtra por `tenantId`.
 *
 * CONSULTIVO: nunca escreve em `documents.tags` (tags confirmadas pelo usuário).
 * O gate da feature (`tagGenerationEnabled`) e o mapeamento de erros HTTP ficam
 * no handler da rota (`POST /documents/:id/generate-tags`), como em
 * `suggest-indexes`/`classify`.
 */
export async function generateDocumentTags(
  params: GenerateDocumentTagsParams,
  deps: GenerateDocumentTagsDeps
): Promise<GenerateDocumentTagsResult> {
  const { tenantId, documentId } = params;
  const { sql, llmProvider } = deps;
  const log = deps.logger.child({ tenantId, documentId, step: 'generate-tags' });

  // 1. Conteúdo extraído (texto completo, nunca truncado) --------------------
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

  const existingBreakdown: CostBreakdown = content.cost_breakdown ?? {
    extractionUsd: 0,
    embeddingsUsd: 0,
    suggestionUsd: 0,
    classificationUsd: 0,
    tagGenerationUsd: 0,
    totalUsd: 0,
  };

  // 2. Núcleo compartilhado: LLM + normalize + validate (SEM banco) ----------
  const core = await generateTags(llmProvider, { fullText: content.full_text }, log);

  // 3. Persiste suggested_tags + custo (acumulado, escopado por tenant) ------
  const generatedAt = new Date();
  const newTagGenerationUsd = (existingBreakdown.tagGenerationUsd ?? 0) + core.costUsd;
  const newCostBreakdown: CostBreakdown = {
    extractionUsd: existingBreakdown.extractionUsd,
    embeddingsUsd: existingBreakdown.embeddingsUsd,
    suggestionUsd: existingBreakdown.suggestionUsd,
    classificationUsd: existingBreakdown.classificationUsd,
    tagGenerationUsd: newTagGenerationUsd,
    totalUsd:
      existingBreakdown.extractionUsd +
      existingBreakdown.embeddingsUsd +
      existingBreakdown.suggestionUsd +
      existingBreakdown.classificationUsd +
      newTagGenerationUsd,
  };

  // jsonb sempre via `sql.json(...)` — NUNCA `JSON.stringify` (double-encoding).
  await sql`
    UPDATE document_content
    SET suggested_tags = ${sql.json({
      tags: core.tags,
      model: core.model,
      promptVersion: core.promptVersion,
      generatedAt: generatedAt.toISOString(),
      rawResponse: core.rawResponse,
    } as unknown as JSONValue)},
        cost_breakdown = ${sql.json(newCostBreakdown)}
    WHERE document_id = ${documentId}
      AND tenant_id = ${tenantId}
  `;

  // documents.cost_usd_cents é SEMPRE incrementado, nunca sobrescrito — outras
  // etapas (extração, embeddings, classificação, sugestão) já podem ter contribuído.
  const deltaCents = Math.ceil(core.costUsd * 100);
  if (deltaCents > 0) {
    await sql`
      UPDATE documents
      SET cost_usd_cents = cost_usd_cents + ${deltaCents}
      WHERE id = ${documentId}
        AND tenant_id = ${tenantId}
    `;
  }

  log.info(
    { tagsGenerated: core.tags.length, model: core.model, costUsd: core.costUsd },
    'geração de tags sob demanda concluída'
  );

  return {
    tags: core.tags,
    generatedAt,
    model: core.model,
    promptVersion: core.promptVersion,
    costBreakdown: newCostBreakdown,
    costUsd: core.costUsd,
  };
}
