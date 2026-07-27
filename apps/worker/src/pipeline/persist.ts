import type { Sql, JSONValue } from 'postgres';
import type { Logger } from 'pino';
import type { DocumentProcessingJobData, TypeSuggestion } from '@dmdoc/shared-types';
import { DocumentEventsRepository, resolveAiFeatureFlags } from '@dmdoc/db-pg';
import { newId } from '@dmdoc/db-pg';
import type { ExtractResult } from './extract.js';
import type { EmbeddedChunkDraft } from './embed.js';

export interface PersistParams {
  job: DocumentProcessingJobData;
  extractResult: ExtractResult;
  embeddedChunks: EmbeddedChunkDraft[];
  totalEmbeddingsUsd: number;
  /**
   * Sugestão de tipo (Fase 8) a gravar em `document_content.type_suggestion`.
   * `null` quando a etapa de classificação foi pulada (features off) ou falhou.
   */
  typeSuggestion: TypeSuggestion | null;
  /**
   * Título de exibição sugerido pela IA (Fase 8.1) a gravar em
   * `documents.suggested_title`. `null` quando a classificação foi pulada/falhou,
   * quando a feature de título está desligada ou quando o LLM não inferiu título.
   *
   * O passo 4 abaixo grava SEMPRE `suggested_title` (reprocessar sobrescreve a
   * sugestão, inclusive para `null`). O passo 4.1 abaixo, com
   * `aiTitleAutoApplyEnabled` ligada, SUBSTITUI também a coluna `title`
   * (confirmada) por este valor quando não-nulo — não é mais uma invariante de
   * "nunca toca `title`" (decisão do Owner, 2026-07-22): auto-aplicação agora
   * sobrescreve.
   */
  suggestedTitle: string | null;
  /** Custo em USD da(s) chamada(s) de LLM da classificação (0 se não houve). */
  classificationUsd: number;
  pipelineStartedAt: Date;
  /**
   * Confiança MÍNIMA da classificação para auto-aplicar `document_type_id`
   * (reaproveita `DMDOC_INDEX_SUGGESTION_MIN_CONFIDENCE` — sem novo env var).
   */
  typeAutoApplyMinConfidence: number;
}

export interface PersistDeps {
  sql: Sql;
  logger: Logger;
}

/**
 * Etapa final do pipeline: persiste os resultados no PostgreSQL.
 *
 * Sequência (idempotente — tolera reexecução):
 * 1+2. Numa única transação: deletar os chunks existentes do documentId e fazer
 *      o bulk insert dos novos, com `department_id` RELIDO de `documents` sob
 *      `FOR SHARE` (ver comentário no corpo — é o que impede vazamento de ACL
 *      quando o documento é movido de departamento durante o processamento).
 * 3. Upsert do `document_content` com fullText, extraction e costBreakdown via ON CONFLICT DO UPDATE.
 * 4. Atualizar `documents.status = READY`, `processed_at`, `cost_usd_cents`.
 * 5. Backfill de `page_count` nos `document_events` via `DocumentEventsRepository`
 *    (única mutação permitida na tabela append-only, escopada por tenantId).
 *
 * Nota: o DELETE e o INSERT dos chunks são atômicos entre si; uma falha ali
 * desfaz os dois. Se qualquer etapa falhar, o status volta para `FAILED` no
 * handler do worker (o erro é re-thrown aqui, e o pipeline/index.ts captura e
 * atualiza o status).
 */
export async function persistProcessingResult(
  params: PersistParams,
  deps: PersistDeps
): Promise<void> {
  const {
    job,
    extractResult,
    embeddedChunks,
    totalEmbeddingsUsd,
    typeSuggestion,
    suggestedTitle,
    classificationUsd,
    pipelineStartedAt,
    typeAutoApplyMinConfidence,
  } = params;
  const { tenantId, documentId } = job;
  const { sql, logger: baseLogger } = deps;

  const log = baseLogger.child({ tenantId, documentId, step: 'persist' });

  const totalTokens = embeddedChunks.reduce((sum, c) => sum + c.tokenCount, 0);
  // Custo total do documento = embeddings + classificação (Fase 8), em centavos.
  const costUsdCents = Math.ceil((totalEmbeddingsUsd + classificationUsd) * 100);

  // 1 + 2. Chunks: DELETE (idempotência) + bulk INSERT numa ÚNICA transação,
  //        com o departamento RELIDO de `documents` sob row lock.
  //
  //        Por que reler em vez de usar `c.departmentId`: aquele valor foi lido
  //        no INÍCIO do pipeline (pipeline/index.ts), antes da extração e dos
  //        embeddings — minutos atrás. Se o documento tiver sido movido de
  //        departamento nesse intervalo (PATCH /documents/:id/move), gravar o
  //        valor antigo criaria chunks com `department_id` obsoleto — e a busca
  //        filtra ACL POR ESSA COLUNA, não por `documents.department_id` (ver
  //        packages/db-pg/src/search.ts). O resultado seria vazamento
  //        permanente do conteúdo para quem já não deveria mais vê-lo, sem nada
  //        que o reconciliasse depois.
  //
  //        O `FOR SHARE` fecha a janela nos dois sentidos:
  //        - o move commitou antes → lemos já o valor novo;
  //        - o persist pegou o lock primeiro → o `UPDATE documents` do move
  //          espera este commit e, ao destravar, o `UPDATE chunks` do próprio
  //          move corrige as linhas recém-inseridas.
  const { deletedChunks, insertedChunks } = await sql.begin(async (tx) => {
    const freshRows = await tx<
      Array<{ department_id: string; document_type_id: string | null }>
    >`
      SELECT department_id, document_type_id
      FROM documents
      WHERE id = ${documentId}
        AND tenant_id = ${tenantId}
      FOR SHARE
    `;
    const fresh = freshRows[0];

    // Fallback para o valor do início do pipeline quando o documento sumiu
    // (excluído durante o processamento): não é papel desta etapa mudar esse
    // comportamento — o INSERT falha ou fica órfão como já acontecia.
    const effectiveDepartmentId =
      fresh?.department_id ?? embeddedChunks[0]?.departmentId ?? '';

    // `document_type_name` é denormalizado no chunk pelo mesmo motivo (evitar
    // lookup na busca) e sofre da mesma defasagem — relemos junto, de graça.
    // Nota: a auto-aplicação de tipo por IA roda só na seção 4.1, DEPOIS deste
    // insert; nesse caminho o nome continua refletindo o tipo confirmado antes
    // da rodada, como já era o comportamento.
    let effectiveDocumentTypeName: string | null = null;
    if (fresh?.document_type_id) {
      const typeRows = await tx<Array<{ name: string }>>`
        SELECT name FROM document_types WHERE id = ${fresh.document_type_id}
      `;
      effectiveDocumentTypeName = typeRows[0]?.name ?? null;
    }

    const deleteResult = await tx`
      DELETE FROM chunks
      WHERE document_id = ${documentId}
        AND tenant_id = ${tenantId}
    `;

    if (embeddedChunks.length === 0) {
      return { deletedChunks: deleteResult.count, insertedChunks: 0 };
    }

    const now = new Date();
    const chunkRows = embeddedChunks.map((c) => ({
      id: newId(),
      document_id: c.documentId,
      tenant_id: c.tenantId,
      department_id: effectiveDepartmentId,
      document_type_name: effectiveDocumentTypeName,
      page_number: c.pageNumber,
      chunk_index: c.chunkIndex,
      text: c.text,
      // postgres.js serializa arrays de números como literais vector-compatíveis
      // quando a coluna é vector(1536). Passamos como string no formato pgvector.
      embedding: `[${c.embedding.join(',')}]`,
      token_count: c.tokenCount,
      created_at: now,
    }));

    // postgres.js sql(rows) faz bulk insert nativo
    await tx`
      INSERT INTO chunks ${tx(chunkRows)}
      ON CONFLICT (document_id, chunk_index) DO NOTHING
    `;

    return { deletedChunks: deleteResult.count, insertedChunks: chunkRows.length };
  });

  log.debug({ deletedChunks, insertedChunks }, 'chunks regravados');

  // 3. Upsert do document_content
  const extraction = {
    engine: extractResult.engine,
    engineVersion: extractResult.engineVersion,
    durationMs: extractResult.durationMs,
    ocrPages: extractResult.ocrPages,
    pageCount: extractResult.pageCount,
    extractedAt: new Date().toISOString(),
  };

  const costBreakdown = {
    extractionUsd: 0,
    embeddingsUsd: totalEmbeddingsUsd,
    suggestionUsd: 0,
    classificationUsd,
    tagGenerationUsd: 0,
    totalUsd: totalEmbeddingsUsd + classificationUsd,
  };

  // jsonb: sempre via `sql.json(...)` — NUNCA `JSON.stringify` (evita
  // double-encoding no postgres.js). `type_suggestion` é `null` quando a
  // classificação foi pulada/falhou; caso contrário grava o objeto (a `Date`
  // `suggestedAt` é serializada como ISO string pelo JSON, como a API espera).
  // Idempotência: no reprocessamento o ON CONFLICT sobrescreve `type_suggestion`
  // — `documents.document_type_id` não é tocado NESTA statement (a
  // auto-aplicação, se ligada, roda depois, na seção 4.1 abaixo).
  const typeSuggestionJson =
    typeSuggestion === null
      ? null
      : sql.json(
          {
            ...typeSuggestion,
            suggestedAt: typeSuggestion.suggestedAt.toISOString(),
          } as unknown as JSONValue
        );

  await sql`
    INSERT INTO document_content (document_id, tenant_id, full_text, extraction, index_suggestion, type_suggestion, cost_breakdown)
    VALUES (
      ${documentId},
      ${tenantId},
      ${extractResult.fullText},
      ${sql.json(extraction)},
      ${null},
      ${typeSuggestionJson},
      ${sql.json(costBreakdown)}
    )
    ON CONFLICT (document_id) DO UPDATE
      SET full_text        = EXCLUDED.full_text,
          extraction       = EXCLUDED.extraction,
          index_suggestion = EXCLUDED.index_suggestion,
          type_suggestion  = EXCLUDED.type_suggestion,
          cost_breakdown   = EXCLUDED.cost_breakdown
  `;

  log.debug('document_content atualizado');

  // 4. Atualizar documento para READY.
  //    Esta statement grava APENAS `suggested_title` — a coluna `title` não é
  //    tocada AQUI (a auto-aplicação, quando ligada, roda na seção 4.1 logo
  //    abaixo, numa statement separada). `suggested_title` é text simples (não
  //    jsonb): interpolado direto, sem `sql.json`/`JSON.stringify`. `null`
  //    sobrescreve qualquer sugestão anterior no reprocessamento (idempotência
  //    coerente com `type_suggestion`).
  await sql`
    UPDATE documents
    SET status          = 'READY',
        processed_at    = now(),
        cost_usd_cents  = ${costUsdCents},
        suggested_title = ${suggestedTitle}
    WHERE id        = ${documentId}
      AND tenant_id = ${tenantId}
  `;

  // 4.1 Auto-aplicação de TIPO e TÍTULO (pedido do Owner, 2026-07-22) — mesmo
  //     princípio da auto-aplicação de tags (`aiTagAutoApplyEnabled`), mas com
  //     SOBRESCRITA (decisão do Owner, 2026-07-22): quando as flags dedicadas
  //     estão ligadas (efetivo = plataforma AND empresa), `document_type_id`/
  //     `title` são SUBSTITUÍDOS pela sugestão mais recente, mesmo já havendo
  //     um valor confirmado — cobre tanto o upload (documento sempre novo)
  //     quanto o reprocessamento individual via `POST /documents/:id/reprocess`
  //     (reusa este MESMO pipeline sobre um documento já existente). Só NÃO
  //     sobrescreve quando a sugestão desta rodada vier vazia/nula/abaixo do
  //     limiar de confiança — nesse caso o valor já confirmado é preservado
  //     (o gate abaixo garante isso: sem sugestão válida, o UPDATE nem roda).
  const aiFlags = await resolveAiFeatureFlags(sql, tenantId);

  if (
    aiFlags.classificationAutoApplyEnabled &&
    typeSuggestion !== null &&
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

  if (aiFlags.titleAutoApplyEnabled && suggestedTitle !== null) {
    await sql`
      UPDATE documents
      SET title = ${suggestedTitle}
      WHERE id = ${documentId}
        AND tenant_id = ${tenantId}
    `;
  }

  // 5. Backfill de pageCount nos eventos de upload (document_events).
  //    `document_events` é append-only; o backfill é a ÚNICA mutação permitida
  //    e só ocorre no caminho de sucesso (READY). Centralizamos essa mutação no
  //    `DocumentEventsRepository` (db-pg) — o método escopa por tenantId +
  //    documentId, usa UPDATE internamente (pode haver mais de um evento
  //    para o mesmo documentId, ex.: reenvio deduplicado que aponta para o doc
  //    existente) e é idempotente (SET com o mesmo pageCount repete o
  //    resultado). Retorna boolean: true se algum evento foi modificado.
  const eventsRepo = new DocumentEventsRepository(sql, { tenantId });
  const backfilledEvents = await eventsRepo.backfillPageCount(
    documentId,
    extractResult.pageCount
  );

  log.info(
    {
      backfilledEvents,
      pageCount: extractResult.pageCount,
    },
    'backfill de pageCount em document_events concluído'
  );

  const durationMs = Date.now() - pipelineStartedAt.getTime();

  log.info(
    {
      chunkCount: embeddedChunks.length,
      totalTokens,
      costUsdCents,
      totalEmbeddingsUsd: totalEmbeddingsUsd.toFixed(6),
      classificationUsd: classificationUsd.toFixed(6),
      typeSuggestionPersisted: typeSuggestion !== null,
      suggestedTitlePersisted: suggestedTitle !== null,
      durationMs,
    },
    'pipeline concluído — documento READY'
  );
}
