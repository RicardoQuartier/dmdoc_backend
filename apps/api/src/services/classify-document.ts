import type { Sql, JSONValue } from '@dmdoc/db-pg';
import { resolveDepartmentDocumentTypeCatalog } from '@dmdoc/db-pg';
import { classifyDocumentType, type LLMProvider } from '@dmdoc/llm-provider';
import type { TypeSuggestion, CostBreakdown } from '@dmdoc/shared-types';
import { NotFoundError, ValidationError } from '../errors/index.js';

/**
 * Interface mínima de logger — compatível com Pino Logger e FastifyBaseLogger.
 * Mesmo padrão de `index-suggestion.ts`.
 */
interface MinimalLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  child(bindings: Record<string, unknown>): MinimalLogger;
}

/**
 * Flags de IA que controlam a MÁSCARA do resultado (Fase 6.9). A mesma chamada
 * de LLM cobre classificação + título; estas flags decidem quais campos do
 * resultado sobrevivem. O ENDPOINT já garantiu que ao menos uma está ligada
 * (senão devolve 403 antes de chamar este service).
 */
export interface ClassifyDocumentFlags {
  classificationEnabled: boolean;
  titleSuggestionEnabled: boolean;
}

export interface ClassifyDocumentParams {
  tenantId: string;
  documentId: string;
  /** Flags efetivas de IA do tenant (plataforma AND empresa), resolvidas na rota. */
  flags: ClassifyDocumentFlags;
}

export interface ClassifyDocumentDeps {
  sql: Sql;
  llmProvider: LLMProvider;
  /**
   * Identificador do modelo de chat configurado — usado como fallback de
   * auditoria quando a resposta do LLM não reporta um `model` (ex.: catálogo
   * vazio, em que nenhuma chamada é feita), garantindo que o
   * `TypeSuggestion.model` persistido nunca seja vazio (invariante do schema).
   */
  chatModel: string;
  logger: MinimalLogger;
}

export interface ClassifyDocumentResult {
  /** Sugestão persistida em `document_content.type_suggestion` (CONSULTIVA). */
  typeSuggestion: TypeSuggestion;
  /**
   * Título de exibição sugerido (Fase 8.1), já mascarado por
   * `titleSuggestionEnabled`. `null` quando a feature está desligada ou quando
   * o LLM não conseguiu inferir um título. Persistido em
   * `documents.suggested_title` — CONSULTIVO, nunca sobrescreve `title`.
   */
  suggestedTitle: string | null;
  /** Custo em USD APENAS desta chamada (não o acumulado). */
  costUsd: number;
}

/**
 * Serviço de classificação automática de tipo por IA sob demanda (Fase 8,
 * entregável #61 — `POST /documents/:id/classify`).
 *
 * Espelha a etapa `classifyDocument` do pipeline do worker
 * (`apps/worker/src/pipeline/classify.ts`), mas com semântica de endpoint:
 * - Exige que o documento já tenha sido processado (`document_content.full_text`
 *   presente) — diferente do worker, que roda DENTRO do processamento.
 * - Erros de pré-condição LANÇAM (`NotFoundError`/`ValidationError`) em vez de
 *   virarem "sem sugestão" best-effort — o usuário pediu a classificação
 *   explicitamente e merece um retorno claro.
 * - Mescla o custo no `cost_breakdown` já existente (acumula
 *   `classificationUsd`, recomputa `totalUsd`) — nunca sobrescreve as demais
 *   etapas — e incrementa `documents.cost_usd_cents`.
 *
 * INVARIANTE (CONSULTIVO): nunca toca `documents.document_type_id`. Mesmo quando
 * o resultado é "nenhum tipo" (`documentTypeId: null`, confiança 0) a sugestão
 * é PERSISTIDA — é o Cenário 2 da tela de qualificação ("IA não identificou
 * tipo"). Idempotente: rechamar sobrescreve `type_suggestion`.
 */
export async function classifyDocument(
  params: ClassifyDocumentParams,
  deps: ClassifyDocumentDeps
): Promise<ClassifyDocumentResult> {
  const { tenantId, documentId, flags } = params;
  const { sql, llmProvider, chatModel } = deps;
  const log = deps.logger.child({ tenantId, documentId, step: 'classify' });

  // 1. Documento (departamento = escopo do catálogo; status = pré-condição) ----
  const docRows = await sql<Array<{ department_id: string; status: string }>>`
    SELECT department_id, status
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

  // 2. Conteúdo extraído — pré-condição: o documento precisa estar processado.
  const contentRows = await sql<
    Array<{ full_text: string | null; cost_breakdown: CostBreakdown | null }>
  >`
    SELECT full_text, cost_breakdown
    FROM document_content
    WHERE document_id = ${documentId}
      AND tenant_id = ${tenantId}
    LIMIT 1
  `;
  const content = contentRows[0];
  if (doc.status !== 'READY' || !content || !content.full_text || content.full_text.trim() === '') {
    throw new ValidationError('Documento ainda não foi processado');
  }
  const fullText = content.full_text;

  // 3. Catálogo escopado ao departamento do documento (mesma visibilidade de
  //    GET /document-types?departmentId=<dept>).
  const catalog = await resolveDepartmentDocumentTypeCatalog(sql, tenantId, doc.department_id);

  // 4. Classificação (reusa o service compartilhado; nunca lança e já aplica a
  //    máscara de flags). Catálogo vazio ⇒ "nenhum tipo" sem chamar o LLM.
  const result = await classifyDocumentType(
    llmProvider,
    {
      text: fullText,
      catalog,
      flags: {
        classificationEnabled: flags.classificationEnabled,
        titleSuggestionEnabled: flags.titleSuggestionEnabled,
      },
    },
    log
  );

  // 5. Monta a sugestão a persistir. `model` recebe o modelo configurado como
  //    fallback quando o service não reportou nenhum (catálogo vazio / nenhuma
  //    chamada) — o schema exige `model` não vazio.
  const suggestedAt = new Date();
  const typeSuggestion: TypeSuggestion = {
    documentTypeId: result.documentTypeId,
    documentTypeName: result.documentTypeName,
    confidence: result.confidence,
    model: result.model !== '' ? result.model : chatModel,
    promptVersion: result.promptVersion,
    suggestedAt,
    rawResponse: result.rawResponse,
  };

  // 6. Persiste type_suggestion + custo mesclado (acumulado, escopado por tenant).
  const existingBreakdown: CostBreakdown = content.cost_breakdown ?? {
    extractionUsd: 0,
    embeddingsUsd: 0,
    suggestionUsd: 0,
    classificationUsd: 0,
    totalUsd: 0,
  };
  const costUsd = result.usage.costUsd;
  const newClassificationUsd = existingBreakdown.classificationUsd + costUsd;
  const newCostBreakdown: CostBreakdown = {
    extractionUsd: existingBreakdown.extractionUsd,
    embeddingsUsd: existingBreakdown.embeddingsUsd,
    suggestionUsd: existingBreakdown.suggestionUsd,
    classificationUsd: newClassificationUsd,
    totalUsd:
      existingBreakdown.extractionUsd +
      existingBreakdown.embeddingsUsd +
      existingBreakdown.suggestionUsd +
      newClassificationUsd,
  };

  // jsonb sempre via `sql.json(...)` — NUNCA `JSON.stringify` (evita
  // double-encoding no postgres.js). `suggestedAt` (Date) é serializado como
  // ISO string pelo JSON, como a API espera ao reler.
  await sql`
    UPDATE document_content
    SET type_suggestion = ${sql.json({
      documentTypeId: typeSuggestion.documentTypeId,
      documentTypeName: typeSuggestion.documentTypeName,
      confidence: typeSuggestion.confidence,
      model: typeSuggestion.model,
      promptVersion: typeSuggestion.promptVersion,
      suggestedAt: suggestedAt.toISOString(),
      rawResponse: result.rawResponse,
    } as unknown as JSONValue)},
        cost_breakdown = ${sql.json(newCostBreakdown)}
    WHERE document_id = ${documentId}
      AND tenant_id = ${tenantId}
  `;

  // 7. Atualiza documents: suggested_title (mascarado por titleSuggestionEnabled)
  //    e incrementa cost_usd_cents. NUNCA toca document_type_id (CONSULTIVO).
  //    `result.suggestedTitle` já vem null quando titleSuggestionEnabled=false;
  //    nesse caso NÃO mexemos na coluna para não apagar uma sugestão anterior.
  const deltaCents = Math.ceil(costUsd * 100);
  if (flags.titleSuggestionEnabled) {
    await sql`
      UPDATE documents
      SET suggested_title = ${result.suggestedTitle},
          cost_usd_cents  = cost_usd_cents + ${deltaCents}
      WHERE id = ${documentId}
        AND tenant_id = ${tenantId}
    `;
  } else if (deltaCents > 0) {
    await sql`
      UPDATE documents
      SET cost_usd_cents = cost_usd_cents + ${deltaCents}
      WHERE id = ${documentId}
        AND tenant_id = ${tenantId}
    `;
  }

  log.info(
    {
      documentTypeId: result.documentTypeId,
      confidence: result.confidence,
      catalogSize: catalog.length,
      promptVersion: result.promptVersion,
      hasSuggestedTitle: result.suggestedTitle !== null,
      classificationUsd: costUsd.toFixed(6),
    },
    'classificação sob demanda concluída'
  );

  return {
    typeSuggestion,
    suggestedTitle: result.suggestedTitle,
    costUsd,
  };
}
