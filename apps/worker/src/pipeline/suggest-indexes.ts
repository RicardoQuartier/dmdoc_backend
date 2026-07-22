import type { Sql, JSONValue } from 'postgres';
import type { Logger } from 'pino';
import { resolveAiFeatureFlags } from '@dmdoc/db-pg';
import {
  suggestIndexValues,
  SUGGEST_INDEXES_PROMPT,
  mergeSuggestedIndexValues,
  type LLMProvider,
  type IndexFieldRow,
} from '@dmdoc/llm-provider';
import type { TypeSuggestion, CostBreakdown } from '@dmdoc/shared-types';

/**
 * Parâmetros da etapa de sugestão automática de índices por IA (Fase 7) no
 * pipeline do worker (GATILHO 1 — upload).
 *
 * Roda APÓS o `persist` (o `document_content` já existe) e usa o TIPO SUGERIDO
 * pela classificação (Fase 8), NUNCA o confirmado — não toca
 * `documents.document_type_id`.
 */
export interface SuggestIndexesStepParams {
  tenantId: string;
  documentId: string;
  /** Sugestão de tipo produzida pela classificação; `null` quando pulada/falhou. */
  typeSuggestion: TypeSuggestion | null;
  /**
   * Confiança MÍNIMA da classificação para disparar a sugestão de índices
   * (env `DMDOC_INDEX_SUGGESTION_MIN_CONFIDENCE`, default 0.5).
   */
  minConfidence: number;
}

export interface SuggestIndexesStepDeps {
  sql: Sql;
  llmProvider: LLMProvider;
  logger: Logger;
}

/**
 * Etapa de sugestão automática de valores de índice do pipeline do worker
 * (Fase 7, GATILHO 1). ORQUESTRADOR best-effort — espelha o padrão de
 * `classify.ts`: a lógica de IA vive no núcleo compartilhado
 * (`suggestIndexValues` de `@dmdoc/llm-provider`); aqui ficam só o gating, as
 * leituras/escritas de banco e a acumulação de custo.
 *
 * Dispara SOMENTE quando TODAS as condições valem:
 * - existe `typeSuggestion` com `documentTypeId != null` (a IA sugeriu um tipo);
 * - `typeSuggestion.confidence >= minConfidence` (limiar configurável);
 * - `indexSuggestionEnabled` (plataforma AND empresa) está ligada.
 *
 * Grava `document_content.index_suggestion` (sugestão) — nunca toca
 * `document_type_id`. AUTO-APLICAÇÃO (gate: `aiIndexAutoApplyEnabled`): mescla
 * os valores sugeridos em `documents.index_values`, campo a campo, só quando o
 * tipo CONFIRMADO atual do documento é EXATAMENTE o tipo usado nesta sugestão
 * (o sugerido) — evita aplicar índices de um tipo que não se tornou (ainda) o
 * oficial (ex.: `aiClassificationAutoApplyEnabled` desligada, confiança abaixo
 * do limiar de auto-aplicação de tipo mas acima do limiar de índices, ou o
 * documento já tinha outro tipo confirmado manualmente antes). Nunca
 * sobrescreve um valor já confirmado.
 *
 * BEST-EFFORT: qualquer erro (LLM fora do ar, resposta inválida, banco) é
 * logado como `warn` e NÃO derruba o pipeline — o documento já está READY.
 */
export async function suggestIndexesStep(
  params: SuggestIndexesStepParams,
  deps: SuggestIndexesStepDeps
): Promise<void> {
  const { tenantId, documentId, typeSuggestion, minConfidence } = params;
  const { sql, llmProvider, logger: baseLogger } = deps;

  const log = baseLogger.child({ tenantId, documentId, step: 'suggest-indexes' });

  try {
    // 1. Gating barato (sem banco): precisa de um tipo SUGERIDO com confiança
    //    suficiente. Sem tipo ou abaixo do limiar ⇒ pula sem custo.
    if (typeSuggestion === null || typeSuggestion.documentTypeId === null) {
      log.info(
        { reason: 'sem-tipo-sugerido' },
        'sugestão automática de índices pulada: classificação não sugeriu tipo'
      );
      return;
    }
    if (typeSuggestion.confidence < minConfidence) {
      log.info(
        { confidence: typeSuggestion.confidence, minConfidence, reason: 'confianca-baixa' },
        'sugestão automática de índices pulada: confiança da classificação abaixo do limiar'
      );
      return;
    }

    const documentTypeId = typeSuggestion.documentTypeId;

    // 2. Feature flag efetiva (plataforma AND empresa).
    const flags = await resolveAiFeatureFlags(sql, tenantId);
    if (!flags.indexSuggestionEnabled) {
      log.info(
        { indexSuggestionEnabled: false, reason: 'feature-desligada' },
        'sugestão automática de índices pulada: feature desabilitada para a empresa'
      );
      return;
    }

    // 3. Conteúdo extraído (texto completo) + custo já acumulado.
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
      log.warn({}, 'sugestão automática de índices pulada: document_content ausente');
      return;
    }

    // 4. Campos de índice do TIPO SUGERIDO.
    const indexFieldRows = await sql<IndexFieldRow[]>`
      SELECT id, name, field_type, required, ai_extraction_hint, sort_order, show_on_search, deleted
      FROM document_type_index_fields
      WHERE document_type_id = ${documentTypeId}
        AND deleted = false
      ORDER BY sort_order ASC
    `;

    // 5. Núcleo compartilhado: LLM + normalize + validate (SEM banco).
    const core = await suggestIndexValues(
      llmProvider,
      { fullText: content.full_text, indexFields: indexFieldRows },
      log
    );

    // 6. Persiste index_suggestion + custo acumulado (nunca sobrescreve
    //    extraction/embeddings/classification). Escopado por tenant.
    const existingBreakdown: CostBreakdown = content.cost_breakdown ?? {
      extractionUsd: 0,
      embeddingsUsd: 0,
      suggestionUsd: 0,
      classificationUsd: 0,
      tagGenerationUsd: 0,
      totalUsd: 0,
    };
    const newSuggestionUsd = existingBreakdown.suggestionUsd + core.costUsd;
    const existingTagGenerationUsd = existingBreakdown.tagGenerationUsd ?? 0;
    const newCostBreakdown: CostBreakdown = {
      extractionUsd: existingBreakdown.extractionUsd,
      embeddingsUsd: existingBreakdown.embeddingsUsd,
      suggestionUsd: newSuggestionUsd,
      classificationUsd: existingBreakdown.classificationUsd,
      tagGenerationUsd: existingTagGenerationUsd,
      totalUsd:
        existingBreakdown.extractionUsd +
        existingBreakdown.embeddingsUsd +
        newSuggestionUsd +
        existingBreakdown.classificationUsd +
        existingTagGenerationUsd,
    };

    const suggestedAt = new Date();
    // jsonb sempre via `sql.json(...)` — NUNCA `JSON.stringify` (double-encoding).
    await sql`
      UPDATE document_content
      SET index_suggestion = ${sql.json({
        values: core.values,
        model: core.model,
        promptVersion: core.promptVersion || SUGGEST_INDEXES_PROMPT.version,
        suggestedAt: suggestedAt.toISOString(),
        rawResponse: core.rawResponse,
      } as unknown as JSONValue)},
          cost_breakdown = ${sql.json(newCostBreakdown)}
      WHERE document_id = ${documentId}
        AND tenant_id = ${tenantId}
    `;

    // documents.cost_usd_cents SEMPRE incrementado, nunca sobrescrito.
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
      {
        documentTypeId,
        confidence: typeSuggestion.confidence,
        fieldsRequested: indexFieldRows.length,
        fieldsSuggested: Object.keys(core.values).length,
        model: core.model,
        suggestionUsd: core.costUsd.toFixed(6),
      },
      'sugestão automática de índices concluída'
    );

    // 7. Auto-aplicação (gate: aiIndexAutoApplyEnabled) — só quando o tipo
    //    CONFIRMADO atual do documento é exatamente o tipo usado nesta
    //    sugestão (auto-aplicado pela etapa de persist, ou já confirmado
    //    manualmente antes — ex.: reprocessamento individual de um documento
    //    já qualificado). Índices de um tipo que não é (ainda) o oficial do
    //    documento nunca são aplicados.
    if (flags.indexAutoApplyEnabled) {
      const docRows = await sql<
        Array<{ document_type_id: string | null; index_values: Record<string, string | number | null> }>
      >`
        SELECT document_type_id, index_values
        FROM documents
        WHERE id = ${documentId}
          AND tenant_id = ${tenantId}
        LIMIT 1
      `;
      const doc = docRows[0];
      if (doc && doc.document_type_id === documentTypeId) {
        const { merged, appliedCount } = mergeSuggestedIndexValues(doc.index_values, core.values, indexFieldRows);
        if (appliedCount > 0) {
          await sql`
            UPDATE documents
            SET index_values = ${sql.json(merged as unknown as JSONValue)}
            WHERE id = ${documentId}
              AND tenant_id = ${tenantId}
          `;
          log.info(
            { fieldsAutoApplied: appliedCount },
            'valores de índice aplicados automaticamente (aiIndexAutoApplyEnabled)'
          );
        }
      }
    }
  } catch (err: unknown) {
    // Best-effort: NUNCA derruba o pipeline. O documento já está READY.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'sugestão automática de índices falhou — seguindo sem sugestão (best-effort)'
    );
  }
}
