import type { Db } from 'mongodb';
import type { Logger } from 'pino';
import type { DocumentEvent, DocumentProcessingJobData } from '@dmdoc/shared-types';
import {
  DocumentEventsRepository,
  DOCUMENT_EVENTS_COLLECTION,
} from '@dmdoc/db-mongo';
import type { ExtractResult } from './extract.js';
import type { EmbeddedChunkDraft } from './embed.js';

export interface PersistParams {
  job: DocumentProcessingJobData;
  extractResult: ExtractResult;
  embeddedChunks: EmbeddedChunkDraft[];
  totalEmbeddingsUsd: number;
  pipelineStartedAt: Date;
}

export interface PersistDeps {
  db: Db;
  logger: Logger;
}

/**
 * Etapa final do pipeline: persiste os resultados no MongoDB.
 *
 * Sequência (idempotente — tolera reexecução):
 * 1. Deletar chunks existentes do documentId (idempotência).
 * 2. Bulk insert dos chunks com embeddings (`ordered: false` para tolerar retry parcial).
 * 3. Upsert do `document_content` com fullText, extraction e costBreakdown.
 * 4. Buscar o `documentTypeName` para desnormalizar nos chunks (já feito no embed step).
 * 5. Atualizar `documents.status = READY`, `processedAt`, `costUsdCents`.
 * 6. Backfill de `pageCount` nos `document_events` via `DocumentEventsRepository`
 *    (única mutação permitida na coleção append-only, escopada por tenantId).
 *
 * Nota: se esta função falhar após `deleteMany` mas antes de `insertMany`, o
 * status volta para `FAILED` no handler do worker (o erro é re-thrown aqui,
 * e o worker.ts captura e atualiza o status).
 */
export async function persistProcessingResult(
  params: PersistParams,
  deps: PersistDeps
): Promise<void> {
  const { job, extractResult, embeddedChunks, totalEmbeddingsUsd, pipelineStartedAt } =
    params;
  const { tenantId, documentId } = job;
  const { db, logger: baseLogger } = deps;

  const log = baseLogger.child({ tenantId, documentId, step: 'persist' });

  const totalTokens = embeddedChunks.reduce((sum, c) => sum + c.tokenCount, 0);
  const costUsdCents = Math.ceil(totalEmbeddingsUsd * 100);

  // 1. Idempotência: remover chunks anteriores do mesmo documento
  const deleteResult = await db
    .collection('chunks')
    .deleteMany({ documentId, tenantId });

  log.debug(
    { deletedChunks: deleteResult.deletedCount },
    'chunks anteriores removidos'
  );

  // 2. Bulk insert dos chunks (ordered: false → não para em erro parcial)
  if (embeddedChunks.length > 0) {
    const now = new Date();
    const chunkDocs = embeddedChunks.map((c) => ({
      documentId: c.documentId,
      tenantId: c.tenantId,
      departmentId: c.departmentId,
      documentTypeName: c.documentTypeName,
      pageNumber: c.pageNumber,
      chunkIndex: c.chunkIndex,
      text: c.text,
      embedding: c.embedding,
      tokenCount: c.tokenCount,
      createdAt: now,
    }));

    await db.collection('chunks').insertMany(chunkDocs, { ordered: false });

    log.debug({ chunkCount: chunkDocs.length }, 'chunks inseridos');
  }

  // 3. Upsert do document_content
  await db.collection('document_content').updateOne(
    { documentId, tenantId },
    {
      $set: {
        documentId,
        tenantId,
        fullText: extractResult.fullText,
        extraction: {
          engine: extractResult.engine,
          engineVersion: extractResult.engineVersion,
          durationMs: extractResult.durationMs,
          ocrPages: extractResult.ocrPages,
          pageCount: extractResult.pageCount,
          extractedAt: new Date(),
        },
        costBreakdown: {
          extractionUsd: 0,
          embeddingsUsd: totalEmbeddingsUsd,
          suggestionUsd: 0,
          totalUsd: totalEmbeddingsUsd,
        },
        indexSuggestion: null,
      },
    },
    { upsert: true }
  );

  log.debug('document_content atualizado');

  // 4. Atualizar documento para READY
  await db.collection('documents').updateOne(
    { id: documentId, tenantId },
    {
      $set: {
        status: 'READY',
        processedAt: new Date(),
        costUsdCents,
        updatedAt: new Date(),
      },
    }
  );

  // 5. Backfill de pageCount nos eventos de upload (document_events).
  //    `document_events` é append-only; o backfill é a ÚNICA mutação permitida
  //    e só ocorre no caminho de sucesso (READY). Centralizamos essa mutação no
  //    `DocumentEventsRepository` (db-mongo) — o método escopa por tenantId +
  //    documentId, usa updateMany internamente (pode haver mais de um evento
  //    para o mesmo documentId, ex.: reenvio deduplicado que aponta para o doc
  //    existente) e é idempotente (`$set` com o mesmo pageCount repete o
  //    resultado). Retorna boolean: true se algum evento foi modificado.
  const eventsRepo = new DocumentEventsRepository(
    db.collection<DocumentEvent>(DOCUMENT_EVENTS_COLLECTION),
    { tenantId }
  );
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
      durationMs,
    },
    'pipeline concluído — documento READY'
  );
}
