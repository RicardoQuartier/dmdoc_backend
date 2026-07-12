import type { Sql } from 'postgres';
import type { Logger } from 'pino';
import { classifyDocumentType, type LLMProvider } from '@dmdoc/llm-provider';
import {
  resolveAiFeatureFlags,
  resolveDepartmentDocumentTypeCatalog,
} from '@dmdoc/db-pg';
import type { TypeSuggestion } from '@dmdoc/shared-types';

/**
 * Parâmetros da etapa de classificação automática de tipo (Fase 8).
 *
 * Roda logo após a extração de texto, quando `fullText` já está disponível e
 * os metadados do documento (`departmentId`) já foram lidos no orquestrador.
 */
export interface ClassifyDocumentParams {
  tenantId: string;
  documentId: string;
  /** Departamento do documento — escopo do catálogo de tipos oferecido à IA. */
  departmentId: string;
  /** Texto completo extraído; o service fatia aos primeiros ~3k tokens. */
  fullText: string;
}

/**
 * Dependências da etapa de classificação.
 *
 * `chatModel` é o identificador do modelo de chat configurado — usado apenas
 * como fallback de auditoria quando a resposta do LLM não reporta um `model`
 * (ex.: catálogo vazio, em que nenhuma chamada é feita), garantindo que o
 * `TypeSuggestion.model` persistido nunca seja vazio (invariante do schema).
 */
export interface ClassifyDocumentDeps {
  sql: Sql;
  llmProvider: LLMProvider;
  chatModel: string;
  logger: Logger;
}

/**
 * Resultado da etapa: a sugestão a persistir (ou `null` quando a etapa é
 * pulada/falha) e o custo em USD da(s) chamada(s) de LLM (0 quando não houve
 * chamada). O orquestrador propaga esse custo ao `cost_breakdown`.
 */
export interface ClassifyDocumentOutcome {
  typeSuggestion: TypeSuggestion | null;
  /**
   * Título de exibição sugerido pela IA (Fase 8.1), já mascarado por
   * `titleSuggestionEnabled` dentro do service. `null` quando a etapa foi
   * pulada/falhou, quando a feature de título está desligada ou quando o LLM
   * não conseguiu inferir um título. Persistido em `documents.suggested_title`
   * — CONSULTIVO: exige confirmação do usuário e nunca sobrescreve o `title`.
   */
  suggestedTitle: string | null;
  classificationUsd: number;
}

const NO_SUGGESTION: ClassifyDocumentOutcome = {
  typeSuggestion: null,
  suggestedTitle: null,
  classificationUsd: 0,
};

/**
 * Etapa de classificação automática de tipo do pipeline do worker (Fase 8).
 *
 * Best-effort e CONSULTIVA: nunca sobrescreve a escolha manual do usuário
 * (`documents.document_type_id`) — apenas produz um `TypeSuggestion` para o
 * campo `document_content.type_suggestion`. NUNCA derruba o pipeline: qualquer
 * erro aqui é logado como `warn` e a função retorna "sem sugestão", deixando
 * a extração/embeddings seguirem e o documento virar READY.
 *
 * Fluxo:
 * 1. Resolve as feature flags EFETIVAS de IA do tenant (plataforma AND empresa).
 *    Se `classificationEnabled` e `titleSuggestionEnabled` estiverem AMBAS
 *    desligadas ⇒ PULA a etapa inteira: não chama LLM, não persiste, não loga
 *    custo. Retorna `null` (sem sugestão).
 * 2. Resolve o catálogo de tipos escopado ao departamento do documento
 *    (mesma visibilidade de `GET /document-types`).
 * 3. Chama o service de classificação (`classify-document-type-v1`), que já
 *    aplica a máscara de flags, resolve nome→id por match exato e nunca lança.
 * 4. Monta o `TypeSuggestion` a persistir. Mesmo quando o resultado é "nenhum
 *    tipo" (`documentTypeId: null`, confiança baixa) a sugestão é persistida —
 *    é o Cenário 2 da tela de qualificação ("IA não identificou tipo"). Só
 *    retorna `null` quando a etapa foi PULADA (passo 1) ou deu erro.
 *
 * Idempotência: reprocessar um documento re-roda esta etapa e sobrescreve o
 * `type_suggestion` no persist — o `document_type_id` manual nunca é tocado.
 */
export async function classifyDocument(
  params: ClassifyDocumentParams,
  deps: ClassifyDocumentDeps
): Promise<ClassifyDocumentOutcome> {
  const { tenantId, documentId, departmentId, fullText } = params;
  const { sql, llmProvider, chatModel, logger: baseLogger } = deps;

  const log = baseLogger.child({ tenantId, documentId, step: 'classify' });

  try {
    // 1. Feature flags efetivas (plataforma AND empresa).
    const flags = await resolveAiFeatureFlags(sql, tenantId);

    if (!flags.classificationEnabled && !flags.titleSuggestionEnabled) {
      log.info(
        { classificationEnabled: false, titleSuggestionEnabled: false },
        'classificação pulada: features de IA desabilitadas para o tenant'
      );
      return NO_SUGGESTION;
    }

    // 2. Catálogo escopado ao departamento do documento.
    const catalog = await resolveDepartmentDocumentTypeCatalog(
      sql,
      tenantId,
      departmentId
    );

    // 3. Service de classificação (nunca lança; aplica máscara de flags).
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

    // 4. Monta a sugestão a persistir. `model` recebe o modelo configurado
    //    como fallback quando o service não reportou nenhum (catálogo vazio /
    //    nenhuma chamada bem-sucedida) — o schema exige `model` não vazio.
    const typeSuggestion: TypeSuggestion = {
      documentTypeId: result.documentTypeId,
      documentTypeName: result.documentTypeName,
      confidence: result.confidence,
      model: result.model !== '' ? result.model : chatModel,
      promptVersion: result.promptVersion,
      suggestedAt: new Date(),
      rawResponse: result.rawResponse,
    };

    log.info(
      {
        documentTypeId: result.documentTypeId,
        confidence: result.confidence,
        catalogSize: catalog.length,
        promptVersion: result.promptVersion,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        classificationUsd: result.usage.costUsd.toFixed(6),
        hasSuggestedTitle: result.suggestedTitle !== null,
      },
      'classificação concluída'
    );

    return {
      typeSuggestion,
      suggestedTitle: result.suggestedTitle,
      classificationUsd: result.usage.costUsd,
    };
  } catch (err: unknown) {
    // Best-effort: classificação NUNCA derruba o pipeline. Loga e segue sem
    // sugestão — o documento ainda vira READY com extração e embeddings.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'classificação falhou — seguindo sem sugestão de tipo (best-effort)'
    );
    return NO_SUGGESTION;
  }
}
