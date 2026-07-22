import type { Sql, JSONValue } from 'postgres';
import type { Logger } from 'pino';
import type { DocumentProcessingJobData, TypeSuggestion } from '@dmdoc/shared-types';
import { DocumentEventsRepository } from '@dmdoc/db-pg';
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
   * INVARIANTE: o worker grava APENAS `suggested_title` — NUNCA toca a coluna
   * `title` (o título confirmado pelo usuário). Reprocessar sobrescreve a
   * sugestão (inclusive para `null`), mas jamais altera o título confirmado.
   */
  suggestedTitle: string | null;
  /** Custo em USD da(s) chamada(s) de LLM da classificação (0 se não houve). */
  classificationUsd: number;
  pipelineStartedAt: Date;
}

export interface PersistDeps {
  sql: Sql;
  logger: Logger;
}

/**
 * Etapa final do pipeline: persiste os resultados no PostgreSQL.
 *
 * Sequência (idempotente — tolera reexecução):
 * 1. Deletar chunks existentes do documentId (idempotência).
 * 2. Bulk insert dos chunks com embeddings via ON CONFLICT (document_id, chunk_index) DO NOTHING.
 * 3. Upsert do `document_content` com fullText, extraction e costBreakdown via ON CONFLICT DO UPDATE.
 * 4. Atualizar `documents.status = READY`, `processed_at`, `cost_usd_cents`.
 * 5. Backfill de `page_count` nos `document_events` via `DocumentEventsRepository`
 *    (única mutação permitida na tabela append-only, escopada por tenantId).
 *
 * Nota: se esta função falhar após DELETE mas antes de INSERT, o
 * status volta para `FAILED` no handler do worker (o erro é re-thrown aqui,
 * e o pipeline/index.ts captura e atualiza o status).
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
  } = params;
  const { tenantId, documentId } = job;
  const { sql, logger: baseLogger } = deps;

  const log = baseLogger.child({ tenantId, documentId, step: 'persist' });

  const totalTokens = embeddedChunks.reduce((sum, c) => sum + c.tokenCount, 0);
  // Custo total do documento = embeddings + classificação (Fase 8), em centavos.
  const costUsdCents = Math.ceil((totalEmbeddingsUsd + classificationUsd) * 100);

  // 1. Idempotência: remover chunks anteriores do mesmo documento
  const deleteResult = await sql`
    DELETE FROM chunks
    WHERE document_id = ${documentId}
      AND tenant_id = ${tenantId}
  `;

  log.debug(
    { deletedChunks: deleteResult.count },
    'chunks anteriores removidos'
  );

  // 2. Bulk insert dos chunks via ON CONFLICT (document_id, chunk_index) DO NOTHING
  if (embeddedChunks.length > 0) {
    const now = new Date();
    const chunkRows = embeddedChunks.map((c) => ({
      id: newId(),
      document_id: c.documentId,
      tenant_id: c.tenantId,
      department_id: c.departmentId,
      document_type_name: c.documentTypeName,
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
    await sql`
      INSERT INTO chunks ${sql(chunkRows)}
      ON CONFLICT (document_id, chunk_index) DO NOTHING
    `;

    log.debug({ chunkCount: chunkRows.length }, 'chunks inseridos');
  }

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
  // — mas `documents.document_type_id` (escolha manual) NUNCA é tocado aqui.
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
  //    INVARIANTE (wiki "Título de exibição sugerido por IA"): o worker grava
  //    APENAS `suggested_title` — a coluna `title` (título confirmado pelo
  //    usuário) NUNCA é tocada aqui. `suggested_title` é text simples (não
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
