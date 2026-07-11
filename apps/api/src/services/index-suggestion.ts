import type { Sql } from '@dmdoc/db-pg';
import type { LLMProvider, ChatResult } from '@dmdoc/llm-provider';
import type { IndexSuggestion, CostBreakdown } from '@dmdoc/shared-types';
import { NotFoundError, ValidationError } from '../errors/index.js';
import type { IndexFieldRow } from '../lib/index-fields.js';
import { validateIndexValues } from '../lib/index-fields.js';
import { normalizeDatePtBr, normalizeNumberPtBr } from '../lib/normalize-index-value.js';
import { SUGGEST_INDEXES_PROMPT, SuggestIndexesResponseSchema } from '../prompts/suggest-indexes.js';
import type { SuggestIndexesResponse } from '../prompts/suggest-indexes.js';

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

/** Número máximo de tentativas de chamada ao LLM até obter um JSON válido. */
const MAX_ATTEMPTS = 2;

export interface SuggestDocumentIndexesParams {
  tenantId: string;
  documentId: string;
}

export interface SuggestDocumentIndexesDeps {
  sql: Sql;
  llmProvider: LLMProvider;
  logger: MinimalLogger;
}

export interface SuggestDocumentIndexesResult {
  /** Sugestão persistida em `document_content.index_suggestion`. */
  indexSuggestion: IndexSuggestion;
  /** `cost_breakdown` completo já atualizado (acumulado) do documento. */
  costBreakdown: CostBreakdown;
  /** Custo em USD APENAS desta chamada (não o acumulado) — para exibição/log do chamador. */
  costUsd: number;
}

/**
 * Extrai o JSON de uma resposta do LLM, tolerando blocos ```json ... ``` que
 * alguns modelos retornam mesmo quando instruídos a responder só o JSON.
 */
function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenced ? (fenced[1] ?? '') : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Normaliza (formatos pt-BR) e valida um valor candidato sugerido pela IA
 * contra o `IndexFieldRow` correspondente, usando exatamente a mesma
 * `validateIndexValues` do PATCH /documents/:id.
 *
 * Retorna o valor pronto para persistir, ou `null` se a IA não encontrou o
 * campo, o valor veio vazio, ou não validou mesmo após a normalização.
 */
function normalizeAndValidateField(field: IndexFieldRow, rawValue: string | null): string | null {
  if (rawValue === null) return null;

  const trimmed = rawValue.trim();
  if (trimmed === '') return null;

  let candidate: string | null = trimmed;
  if (field.field_type === 'DATE') {
    candidate = normalizeDatePtBr(trimmed);
  } else if (field.field_type === 'NUMBER') {
    candidate = normalizeNumberPtBr(trimmed);
  }
  // TEXT: sem normalização de formato — só o trim já aplicado.

  if (candidate === null) return null;

  const errors = validateIndexValues({ [field.name]: candidate }, [field]);
  if (errors.length > 0) return null;

  return candidate;
}

/**
 * Chama o LLM pedindo a sugestão de índices, com retry (até `MAX_ATTEMPTS`)
 * quando a resposta não é um JSON válido no formato esperado.
 *
 * Retorna também o custo ACUMULADO de todas as tentativas — inclusive a(s)
 * tentativa(s) inválida(s), pois o provedor cobra pelos tokens gerados mesmo
 * quando a resposta não pôde ser aproveitada.
 */
async function callLlmWithRetry(
  llmProvider: LLMProvider,
  userMessage: string,
  logger: MinimalLogger
): Promise<{ parsed: SuggestIndexesResponse; lastResult: ChatResult; totalCostUsd: number }> {
  let totalCostUsd = 0;
  let lastResult: ChatResult | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const messages = [
      { role: 'system' as const, content: SUGGEST_INDEXES_PROMPT.systemPrompt },
      { role: 'user' as const, content: userMessage },
      ...(attempt > 1
        ? [
            {
              role: 'user' as const,
              content:
                'Sua resposta anterior não era um JSON válido no formato exigido. Responda ' +
                'APENAS com o JSON: {"fields":[{"name":string,"value":string|null,"confidence":number}]}.',
            },
          ]
        : []),
    ];

    const result = await llmProvider.chat({ messages, temperature: 0.1, maxTokens: 2048 });
    lastResult = result;
    totalCostUsd += result.usage.costUsd;

    const json = tryParseJson(result.content);
    const parsed = SuggestIndexesResponseSchema.safeParse(json);

    if (parsed.success) {
      return { parsed: parsed.data, lastResult: result, totalCostUsd };
    }

    logger.warn(
      { attempt, maxAttempts: MAX_ATTEMPTS, issue: parsed.error.message },
      'resposta do LLM não passou na validação Zod da sugestão de índices — tentando novamente'
    );
  }

  throw new Error(
    `Resposta do LLM inválida para sugestão de índices após ${MAX_ATTEMPTS} tentativas` +
      (lastResult ? ` (último conteúdo: ${lastResult.content.slice(0, 200)})` : '')
  );
}

/**
 * Serviço de sugestão de valores de índice por IA (Fase 7).
 *
 * Fluxo completo (spec §7/§11, wiki "Sugestão de valores de índice por IA —
 * alcance no texto e normalização de formato"):
 * 1. Lê `document_content.full_text` (texto completo, nunca truncado) e os
 *    `document_type_index_fields` do tipo do documento.
 * 2. Monta o prompt `suggest-indexes-v1` com todos os campos a extrair.
 * 3. Chama o `llm-provider`, com retry em caso de resposta fora do schema.
 * 4. Normaliza formatos pt-BR (datas, números) e valida cada campo contra
 *    `validateIndexValues` — campo que não validar vira "sem sugestão"
 *    (não aparece em `values`), sem afetar os demais campos da chamada.
 * 5. Persiste `document_content.index_suggestion` e atualiza
 *    `document_content.cost_breakdown.suggestionUsd` (acumulado — nunca
 *    sobrescreve `extractionUsd`/`embeddingsUsd`) e `documents.cost_usd_cents`
 *    (incrementado, nunca sobrescrito). Toda query filtra por `tenantId`.
 *
 * Lança `NotFoundError` se o documento ou seu conteúdo processado não
 * existirem (ou pertencerem a outro tenant), e `ValidationError` se o
 * documento ainda não tiver `documentTypeId` definido.
 */
export async function suggestDocumentIndexes(
  params: SuggestDocumentIndexesParams,
  deps: SuggestDocumentIndexesDeps
): Promise<SuggestDocumentIndexesResult> {
  const { tenantId, documentId } = params;
  const { sql, llmProvider } = deps;
  const log = deps.logger.child({ tenantId, documentId, step: 'suggest-indexes' });

  // 1. Documento + tipo -----------------------------------------------------
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
  const documentTypeId = doc.document_type_id;

  // 2. Conteúdo extraído (texto completo, nunca truncado) -------------------
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

  // Tipo sem campos de índice configurados: nada a sugerir, sem custo.
  if (indexFieldRows.length === 0) {
    log.info({}, 'tipo de documento sem campos de índice configurados — nenhuma sugestão gerada');
    const suggestedAt = new Date();
    const indexSuggestion: IndexSuggestion = {
      values: {},
      model: '',
      promptVersion: SUGGEST_INDEXES_PROMPT.version,
      suggestedAt,
      rawResponse: {},
    };
    // Payload separado para persistência: `sql.json` exige `JSONValue`
    // (sem `unknown`), diferente do tipo `IndexSuggestion` (rawResponse
    // tipado como `Record<string, unknown>` pelo shared-types).
    await sql`
      UPDATE document_content
      SET index_suggestion = ${sql.json({
        values: {} as Record<string, string>,
        model: '',
        promptVersion: SUGGEST_INDEXES_PROMPT.version,
        suggestedAt,
        rawResponse: {},
      })}
      WHERE document_id = ${documentId}
        AND tenant_id = ${tenantId}
    `;
    return { indexSuggestion, costBreakdown: existingBreakdown, costUsd: 0 };
  }

  // 4. Monta prompt e chama o LLM (com retry) --------------------------------
  const userMessage = SUGGEST_INDEXES_PROMPT.buildUserMessage(
    content.full_text,
    indexFieldRows.map((f) => ({
      name: f.name,
      fieldType: f.field_type,
      required: f.required,
      aiExtractionHint: f.ai_extraction_hint,
    }))
  );

  const { parsed, lastResult, totalCostUsd } = await callLlmWithRetry(llmProvider, userMessage, log);

  // 5. Normaliza + valida cada campo -----------------------------------------
  const fieldByName = new Map(indexFieldRows.map((f) => [f.name, f]));
  const values: Record<string, string> = {};

  for (const suggested of parsed.fields) {
    const field = fieldByName.get(suggested.name);
    if (!field) {
      log.warn({ fieldName: suggested.name }, 'IA sugeriu campo que não existe no tipo do documento — ignorado');
      continue;
    }

    const normalized = normalizeAndValidateField(field, suggested.value);
    if (normalized === null) {
      if (suggested.value !== null) {
        log.warn(
          { fieldName: suggested.name, rawValue: suggested.value },
          'sugestão de índice descartada — não validou mesmo após normalização pt-BR'
        );
      }
      continue;
    }

    values[field.name] = normalized;
  }

  log.info(
    {
      fieldsRequested: indexFieldRows.length,
      fieldsSuggested: Object.keys(values).length,
      model: lastResult.model,
      costUsd: totalCostUsd.toFixed(6),
    },
    'sugestão de índices concluída'
  );

  // 6. Persiste indexSuggestion + custo (acumulado, escopado por tenant) ----
  const suggestedAt = new Date();
  const indexSuggestion: IndexSuggestion = {
    values,
    model: lastResult.model,
    promptVersion: SUGGEST_INDEXES_PROMPT.version,
    suggestedAt,
    rawResponse: parsed,
  };

  const newSuggestionUsd = existingBreakdown.suggestionUsd + totalCostUsd;
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
      values,
      model: lastResult.model,
      promptVersion: SUGGEST_INDEXES_PROMPT.version,
      suggestedAt,
      rawResponse: parsed,
    })},
        cost_breakdown = ${sql.json(newCostBreakdown)}
    WHERE document_id = ${documentId}
      AND tenant_id = ${tenantId}
  `;

  // documents.cost_usd_cents é SEMPRE incrementado, nunca sobrescrito — outras
  // etapas (extração, embeddings) podem já ter contribuído para o total.
  const deltaCents = Math.ceil(totalCostUsd * 100);
  if (deltaCents > 0) {
    await sql`
      UPDATE documents
      SET cost_usd_cents = cost_usd_cents + ${deltaCents}
      WHERE id = ${documentId}
        AND tenant_id = ${tenantId}
    `;
  }

  return { indexSuggestion, costBreakdown: newCostBreakdown, costUsd: totalCostUsd };
}
