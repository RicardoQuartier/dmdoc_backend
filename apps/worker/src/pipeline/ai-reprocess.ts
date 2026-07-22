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
import type { AiReprocessStep, CostBreakdown, TypeSuggestion } from '@dmdoc/shared-types';
import { classifyDocument } from './classify.js';
import { generateTagsStep } from './generate-tags.js';

/**
 * Erro de PRÉ-CONDIÇÃO do reprocessamento de IA — o documento não pôde ser
 * reprocessado (inexistente, soft-deletado, ainda não processado / sem texto).
 * O processor do worker mapeia isto para `failed` no contador do lote. Falhas
 * de LLM POR ETAPA nunca chegam aqui — são best-effort e não abortam o documento.
 */
export class AiReprocessPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiReprocessPreconditionError';
  }
}

export interface RunAiReprocessParams {
  tenantId: string;
  documentId: string;
  /** Etapas de IA pedidas (já filtradas pelas flags do tenant na API). */
  steps: AiReprocessStep[];
}

export interface RunAiReprocessDeps {
  sql: Sql;
  llmProvider: LLMProvider;
  /** Modelo de chat configurado — fallback de auditoria do TypeSuggestion. */
  chatModel: string;
  logger: Logger;
  /**
   * Confiança MÍNIMA da classificação para auto-aplicar `document_type_id`
   * (mesmo valor de `DMDOC_INDEX_SUGGESTION_MIN_CONFIDENCE`, reaproveitado —
   * sem novo env var dedicado).
   */
  typeAutoApplyMinConfidence: number;
}

/** Resultado sumarizado (para log/observabilidade). */
export interface RunAiReprocessOutcome {
  stepsRun: AiReprocessStep[];
  stepsSkipped: AiReprocessStep[];
}

interface DocRow {
  department_id: string;
  document_type_id: string | null;
  status: string;
  title: string | null;
  index_values: Record<string, string | number | null>;
}

/**
 * Reprocessa AS ETAPAS DE IA de UM documento já processado (épico E-4 / T-24).
 *
 * NÃO re-extrai, NÃO re-embedda e NÃO apaga chunks — reaproveita o texto já
 * extraído (`document_content.full_text`) e roda só as features de IA pedidas,
 * reusando os mesmos núcleos compartilhados (`@dmdoc/llm-provider`) e o mesmo
 * padrão de acumulação de custo do pipeline de upload:
 *
 * - `title`   → classificação de tipo + título sugerido (worker `classifyDocument`),
 *               persiste `type_suggestion`/`suggested_title`.
 * - `indexes` → sugestão de valores de índice sobre o TIPO CONFIRMADO do
 *               documento (semântica on-demand: sem tipo confirmado ⇒ pula),
 *               persiste `index_suggestion`.
 * - `tags`    → geração automática de tags (E-3), persiste `suggested_tags`.
 *
 * AUTO-APLICAÇÃO (pedido do Owner, 2026-07-22, revisado em 2026-07-22 para
 * SOBRESCRITA): em QUALQUER gatilho de IA — upload, reprocessamento
 * individual, reprocessamento em lote, endpoints sob demanda — cada sugestão
 * gerada é aplicada automaticamente nos campos do documento, sem exigir
 * confirmação manual, DESDE QUE a flag dedicada esteja ligada (efetivo =
 * plataforma AND empresa, default LIGADA):
 * - `title`   → `document_type_id` (`aiClassificationAutoApplyEnabled`, com
 *               limiar de confiança) e `title` (`aiTitleAutoApplyEnabled`) são
 *               SUBSTITUÍDOS pela sugestão desta rodada, mesmo já havendo um
 *               valor confirmado — só preservam o valor atual quando a
 *               sugestão desta rodada vier vazia/nula (ou, no caso do tipo,
 *               com confiança insuficiente).
 * - `indexes` → cada campo sugerido SUBSTITUI o valor confirmado quando vier
 *               preenchido (`aiIndexAutoApplyEnabled`); um campo sem sugestão
 *               nesta rodada preserva o valor já confirmado.
 * - `tags`    → CONTINUA só somando (nunca sobrescreve/remove) via
 *               `generateTagsStep`, que reaproveita a flag
 *               `aiTagAutoApplyEnabled` em TODOS os gatilhos, inclusive este —
 *               tags têm semântica aditiva, não de substituição.
 *
 * Gating: `resolveAiFeatureFlags` (plataforma AND empresa) — etapa desligada é
 * PULADA (não é erro). BEST-EFFORT por etapa: falha de LLM/validação numa etapa
 * é logada e NÃO derruba as demais nem o documento. Custo SEMPRE ACUMULADO
 * (nunca sobrescreve etapas anteriores), inclusive tentativas de retry inválidas
 * (a acumulação vive dentro dos núcleos/persist, como no upload).
 *
 * IDEMPOTENTE: rerodar sobrescreve as sugestões consultivas e reaplica a
 * auto-aplicação (tipo/título/índices substituem; tags só somam) — nunca
 * duplica dados.
 *
 * @throws {AiReprocessPreconditionError} documento inexistente/sem texto —
 *   o processor conta o documento como `failed`.
 */
export async function runAiReprocessDocument(
  params: RunAiReprocessParams,
  deps: RunAiReprocessDeps,
): Promise<RunAiReprocessOutcome> {
  const { tenantId, documentId, steps } = params;
  const { sql, llmProvider, chatModel, logger: baseLogger, typeAutoApplyMinConfidence } = deps;
  const log = baseLogger.child({ tenantId, documentId, step: 'ai-reprocess' });

  // 1. Pré-condições: documento vivo + texto extraído disponível.
  const docRows = await sql<DocRow[]>`
    SELECT department_id, document_type_id, status, title, index_values
    FROM documents
    WHERE id = ${documentId}
      AND tenant_id = ${tenantId}
      AND deleted = false
    LIMIT 1
  `;
  const doc = docRows[0];
  if (!doc) {
    throw new AiReprocessPreconditionError('Documento não encontrado');
  }

  const contentRows = await sql<Array<{ full_text: string | null }>>`
    SELECT full_text
    FROM document_content
    WHERE document_id = ${documentId}
      AND tenant_id = ${tenantId}
    LIMIT 1
  `;
  const fullText = contentRows[0]?.full_text ?? null;
  if (fullText === null || fullText.trim() === '') {
    throw new AiReprocessPreconditionError('Documento ainda não foi processado (sem texto extraído)');
  }

  // 2. Flags efetivas (plataforma AND empresa) — resolvidas UMA vez.
  const flags = await resolveAiFeatureFlags(sql, tenantId);

  const stepsRun: AiReprocessStep[] = [];
  const stepsSkipped: AiReprocessStep[] = [];

  // 3. title/tipo -----------------------------------------------------------
  if (steps.includes('title')) {
    if (!flags.classificationEnabled && !flags.titleSuggestionEnabled) {
      stepsSkipped.push('title');
      log.info({ reason: 'feature-desligada' }, 'etapa title pulada: classificação e título desligados');
    } else {
      await reprocessTitleStep(
        {
          tenantId,
          documentId,
          departmentId: doc.department_id,
          fullText,
          titleSuggestionEnabled: flags.titleSuggestionEnabled,
          classificationAutoApplyEnabled: flags.classificationAutoApplyEnabled,
          titleAutoApplyEnabled: flags.titleAutoApplyEnabled,
          typeAutoApplyMinConfidence,
        },
        { sql, llmProvider, chatModel, logger: log },
      );
      stepsRun.push('title');
    }
  }

  // 4. indexes (TIPO CONFIRMADO) -------------------------------------------
  if (steps.includes('indexes')) {
    // Reconsulta document_type_id/index_values FRESCOS (não o `doc` lido no
    // topo desta função): quando `steps` inclui `title` E `indexes` juntos
    // (caso comum do lote), a etapa `title` pode ter acabado de auto-aplicar
    // um tipo no documento que antes não tinha nenhum — usar o `doc` original
    // (stale) faria esta etapa pular por engano, achando que ainda não há
    // tipo confirmado.
    const freshDocRows = await sql<Array<{ document_type_id: string | null; index_values: Record<string, string | number | null> }>>`
      SELECT document_type_id, index_values
      FROM documents
      WHERE id = ${documentId}
        AND tenant_id = ${tenantId}
      LIMIT 1
    `;
    const freshDoc = freshDocRows[0];
    const currentDocumentTypeId = freshDoc?.document_type_id ?? null;

    if (!flags.indexSuggestionEnabled) {
      stepsSkipped.push('indexes');
      log.info({ reason: 'feature-desligada' }, 'etapa indexes pulada: sugestão de índices desligada');
    } else if (currentDocumentTypeId === null) {
      stepsSkipped.push('indexes');
      log.info(
        { reason: 'sem-tipo-confirmado' },
        'etapa indexes pulada: documento sem tipo confirmado (sugestão de índices exige tipo)',
      );
    } else {
      await reprocessIndexesStep(
        {
          tenantId,
          documentId,
          documentTypeId: currentDocumentTypeId,
          fullText,
          currentIndexValues: freshDoc?.index_values ?? {},
          indexAutoApplyEnabled: flags.indexAutoApplyEnabled,
        },
        { sql, llmProvider, logger: log },
      );
      stepsRun.push('indexes');
    }
  }

  // 5. tags (independente do tipo; generateTagsStep já auto-gate na flag) ----
  if (steps.includes('tags')) {
    if (!flags.tagGenerationEnabled) {
      stepsSkipped.push('tags');
      log.info({ reason: 'feature-desligada' }, 'etapa tags pulada: geração de tags desligada');
    } else {
      await generateTagsStep({ tenantId, documentId }, { sql, llmProvider, logger: log });
      stepsRun.push('tags');
    }
  }

  log.info({ stepsRun, stepsSkipped }, 'reprocessamento de IA do documento concluído');
  return { stepsRun, stepsSkipped };
}

// ---------------------------------------------------------------------------
// Etapa: title/tipo
// ---------------------------------------------------------------------------

interface ReprocessTitleParams {
  tenantId: string;
  documentId: string;
  departmentId: string;
  fullText: string;
  titleSuggestionEnabled: boolean;
  /** Auto-aplica `document_type_id` quando vazio e a confiança é suficiente. */
  classificationAutoApplyEnabled: boolean;
  /** Auto-aplica `title` quando vazio. */
  titleAutoApplyEnabled: boolean;
  /** Confiança mínima da classificação para auto-aplicar o tipo. */
  typeAutoApplyMinConfidence: number;
}

/**
 * Roda a classificação (reusa o worker `classifyDocument` — mesma chamada de
 * LLM `classify-document-type-v3`) e PERSISTE `type_suggestion`/`suggested_title`
 * + custo acumulado. Espelha o service on-demand `apps/api/.../classify-document.ts`
 * (o worker não importa de `apps/api`; a lógica de IA é compartilhada via
 * `@dmdoc/llm-provider`, só o persist é replicado).
 *
 * AUTO-APLICAÇÃO: além de gravar a sugestão, preenche `document_type_id`/
 * `title` CONFIRMADOS quando ainda estiverem vazios (gate: as flags dedicadas
 * `aiClassificationAutoApplyEnabled`/`aiTitleAutoApplyEnabled`). Cada UPDATE
 * decide isso via `WHERE ... IS NULL`/`COALESCE(coluna, ...)` contra o estado
 * ATUAL da linha — nunca contra um valor lido antecipadamente — então é
 * race-safe mesmo com uma confirmação manual concorrente, e não precisa
 * receber o valor "atual" como parâmetro.
 *
 * BEST-EFFORT: `classifyDocument` nunca lança (self-catch); se retornar
 * `typeSuggestion === null` (features off / erro) não há nada a persistir.
 */
async function reprocessTitleStep(
  params: ReprocessTitleParams,
  deps: { sql: Sql; llmProvider: LLMProvider; chatModel: string; logger: Logger },
): Promise<void> {
  const {
    tenantId,
    documentId,
    departmentId,
    fullText,
    titleSuggestionEnabled,
    classificationAutoApplyEnabled,
    titleAutoApplyEnabled,
    typeAutoApplyMinConfidence,
  } = params;
  const { sql, llmProvider, chatModel, logger } = deps;

  const outcome = await classifyDocument(
    { tenantId, documentId, departmentId, fullText },
    { sql, llmProvider, chatModel, logger },
  );

  if (outcome.typeSuggestion === null) {
    // Etapa pulada/falhou dentro do service (features off ou erro best-effort).
    return;
  }

  const typeSuggestion: TypeSuggestion = outcome.typeSuggestion;
  const classificationUsd = outcome.classificationUsd;

  // Custo acumulado (lê o breakdown fresco — outras etapas podem já ter somado).
  const contentRows = await sql<Array<{ cost_breakdown: CostBreakdown | null }>>`
    SELECT cost_breakdown
    FROM document_content
    WHERE document_id = ${documentId}
      AND tenant_id = ${tenantId}
    LIMIT 1
  `;
  const existingBreakdown: CostBreakdown = contentRows[0]?.cost_breakdown ?? {
    extractionUsd: 0,
    embeddingsUsd: 0,
    suggestionUsd: 0,
    classificationUsd: 0,
    tagGenerationUsd: 0,
    totalUsd: 0,
  };
  const newClassificationUsd = existingBreakdown.classificationUsd + classificationUsd;
  const existingTagGenerationUsd = existingBreakdown.tagGenerationUsd ?? 0;
  const newCostBreakdown: CostBreakdown = {
    extractionUsd: existingBreakdown.extractionUsd,
    embeddingsUsd: existingBreakdown.embeddingsUsd,
    suggestionUsd: existingBreakdown.suggestionUsd,
    classificationUsd: newClassificationUsd,
    tagGenerationUsd: existingTagGenerationUsd,
    totalUsd:
      existingBreakdown.extractionUsd +
      existingBreakdown.embeddingsUsd +
      existingBreakdown.suggestionUsd +
      newClassificationUsd +
      existingTagGenerationUsd,
  };

  await sql`
    UPDATE document_content
    SET type_suggestion = ${sql.json({
      documentTypeId: typeSuggestion.documentTypeId,
      documentTypeName: typeSuggestion.documentTypeName,
      confidence: typeSuggestion.confidence,
      model: typeSuggestion.model,
      promptVersion: typeSuggestion.promptVersion,
      suggestedAt: typeSuggestion.suggestedAt.toISOString(),
      rawResponse: typeSuggestion.rawResponse,
    } as unknown as JSONValue)},
        cost_breakdown = ${sql.json(newCostBreakdown)}
    WHERE document_id = ${documentId}
      AND tenant_id = ${tenantId}
  `;

  // Auto-aplicação do TIPO (gate: aiClassificationAutoApplyEnabled + limiar de
  // confiança), COM SOBRESCRITA (decisão do Owner, 2026-07-22): substitui
  // `document_type_id` mesmo já havendo um tipo confirmado, desde que a IA
  // identifique um tipo compatível com confiança suficiente nesta rodada — uma
  // reclassificação sem match (documentTypeId null ou confiança baixa) não
  // entra aqui, preservando o tipo já confirmado.
  if (
    classificationAutoApplyEnabled &&
    typeSuggestion.documentTypeId !== null &&
    typeSuggestion.confidence >= typeAutoApplyMinConfidence
  ) {
    await sql`
      UPDATE documents
      SET document_type_id = ${typeSuggestion.documentTypeId}
      WHERE id = ${documentId}
        AND tenant_id = ${tenantId}
    `;
  }

  // suggested_title só é gravado quando a feature de título está ligada — para
  // NÃO apagar (null) uma sugestão anterior quando só a classificação roda.
  // cost_usd_cents SEMPRE incrementado, nunca sobrescrito. Auto-aplicação do
  // TÍTULO (gate: aiTitleAutoApplyEnabled), COM SOBRESCRITA: substitui `title`
  // pela sugestão desta rodada mesmo já havendo um título confirmado — só
  // preserva o valor atual quando a sugestão desta rodada vier vazia/nula.
  const deltaCents = Math.ceil(classificationUsd * 100);
  if (titleSuggestionEnabled) {
    await sql`
      UPDATE documents
      SET suggested_title = ${outcome.suggestedTitle},
          cost_usd_cents = cost_usd_cents + ${deltaCents}
      WHERE id = ${documentId}
        AND tenant_id = ${tenantId}
    `;
    if (titleAutoApplyEnabled && outcome.suggestedTitle !== null) {
      await sql`
        UPDATE documents
        SET title = ${outcome.suggestedTitle}
        WHERE id = ${documentId}
          AND tenant_id = ${tenantId}
      `;
    }
  } else if (deltaCents > 0) {
    await sql`
      UPDATE documents
      SET cost_usd_cents = cost_usd_cents + ${deltaCents}
      WHERE id = ${documentId}
        AND tenant_id = ${tenantId}
    `;
  }
}

// ---------------------------------------------------------------------------
// Etapa: indexes (tipo CONFIRMADO)
// ---------------------------------------------------------------------------

interface ReprocessIndexesParams {
  tenantId: string;
  documentId: string;
  /** Tipo CONFIRMADO do documento (nunca o sugerido — semântica on-demand). */
  documentTypeId: string;
  fullText: string;
  /** Valores de índice já CONFIRMADOS — auto-aplicação com sobrescrita, campo a campo. */
  currentIndexValues: Record<string, string | number | null>;
  /** Auto-aplica os valores sugeridos em `index_values` (campo a campo). */
  indexAutoApplyEnabled: boolean;
}

/**
 * Sugere valores de índice sobre o TIPO CONFIRMADO do documento e persiste
 * `index_suggestion` + custo acumulado. Espelha o caminho on-demand de
 * `apps/api/.../index-suggestion.ts` (núcleo `suggestIndexValues` compartilhado).
 *
 * AUTO-APLICAÇÃO (gate: aiIndexAutoApplyEnabled), COM SOBRESCRITA: mescla os
 * valores sugeridos em `documents.index_values` via `mergeSuggestedIndexValues`
 * (núcleo compartilhado de `@dmdoc/llm-provider`) — cada campo sugerido
 * SUBSTITUI o valor já confirmado; só preserva o valor atual de um campo
 * quando a sugestão desta rodada vier vazia para aquele campo especificamente.
 *
 * BEST-EFFORT: qualquer erro (LLM/validação/banco) é logado como `warn` e NÃO
 * derruba o documento nem as outras etapas.
 */
async function reprocessIndexesStep(
  params: ReprocessIndexesParams,
  deps: { sql: Sql; llmProvider: LLMProvider; logger: Logger },
): Promise<void> {
  const { tenantId, documentId, documentTypeId, fullText, currentIndexValues, indexAutoApplyEnabled } = params;
  const { sql, llmProvider, logger } = deps;

  try {
    const contentRows = await sql<Array<{ cost_breakdown: CostBreakdown | null }>>`
      SELECT cost_breakdown
      FROM document_content
      WHERE document_id = ${documentId}
        AND tenant_id = ${tenantId}
      LIMIT 1
    `;
    const existingBreakdown: CostBreakdown = contentRows[0]?.cost_breakdown ?? {
      extractionUsd: 0,
      embeddingsUsd: 0,
      suggestionUsd: 0,
      classificationUsd: 0,
      tagGenerationUsd: 0,
      totalUsd: 0,
    };

    const indexFieldRows = await sql<IndexFieldRow[]>`
      SELECT id, name, field_type, required, ai_extraction_hint, sort_order, show_on_search, deleted
      FROM document_type_index_fields
      WHERE document_type_id = ${documentTypeId}
        AND deleted = false
      ORDER BY sort_order ASC
    `;

    const core = await suggestIndexValues(
      llmProvider,
      { fullText, indexFields: indexFieldRows },
      logger,
    );

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

    const deltaCents = Math.ceil(core.costUsd * 100);
    if (deltaCents > 0) {
      await sql`
        UPDATE documents
        SET cost_usd_cents = cost_usd_cents + ${deltaCents}
        WHERE id = ${documentId}
          AND tenant_id = ${tenantId}
      `;
    }

    // Auto-aplicação (gate: aiIndexAutoApplyEnabled): mescla campo a campo em
    // `index_values`, preenchendo só o que ainda está vazio (nunca sobrescreve
    // um valor já confirmado manualmente).
    let appliedCount = 0;
    if (indexAutoApplyEnabled) {
      const merged = mergeSuggestedIndexValues(currentIndexValues, core.values, indexFieldRows);
      appliedCount = merged.appliedCount;
      if (appliedCount > 0) {
        await sql`
          UPDATE documents
          SET index_values = ${sql.json(merged.merged as unknown as JSONValue)}
          WHERE id = ${documentId}
            AND tenant_id = ${tenantId}
        `;
      }
    }

    logger.info(
      {
        documentTypeId,
        fieldsRequested: indexFieldRows.length,
        fieldsSuggested: Object.keys(core.values).length,
        fieldsAutoApplied: appliedCount,
        suggestionUsd: core.costUsd.toFixed(6),
      },
      'reprocessamento de índices concluído',
    );
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'reprocessamento de índices falhou — seguindo sem sugestão (best-effort)',
    );
  }
}
