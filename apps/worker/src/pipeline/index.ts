import type { Job } from 'bullmq';
import type { Db } from 'mongodb';
import type { Logger } from 'pino';
import OpenAI from 'openai';
import type { ExtractorProvider } from '@dmdoc/extractor';
import type { DocumentProcessingJobData } from '@dmdoc/shared-types';
import { extractDocument } from './extract.js';
import { chunkText, type ChunkDocumentMeta } from './chunk.js';
import { embedChunks } from './embed.js';
import { persistProcessingResult } from './persist.js';

export interface PipelineDeps {
  s3Bucket: string;
  extractor: ExtractorProvider;
  openai: OpenAI;
  embeddingModel: string;
  db: Db;
  logger: Logger;
  chunkTargetTokens?: number;
  chunkOverlapTokens?: number;
}

/**
 * Orquestra o pipeline completo de processamento de um documento:
 *
 *   extract → chunk → embed → persist
 *
 * Cada etapa é idempotente — pode ser reexecutada sem corromper dados.
 *
 * Em caso de erro em qualquer etapa:
 * - Atualiza `documents.status = FAILED` com `failureReason` (truncado a 500 chars).
 * - Re-throws para o BullMQ marcar o job como `failed` e fazer retry.
 *
 * Invariantes:
 * - Nunca derruba o processo por erro de job individual (spec §8).
 * - Todo custo de embedding é logado (spec invariante 2).
 * - Sem `console.log` — apenas Pino com campos obrigatórios.
 */
export async function runPipeline(
  job: Job<DocumentProcessingJobData>,
  deps: PipelineDeps
): Promise<void> {
  const { tenantId, documentId } = job.data;
  const {
    s3Bucket,
    extractor,
    openai,
    embeddingModel,
    db,
    logger: baseLogger,
    chunkTargetTokens,
    chunkOverlapTokens,
  } = deps;

  const traceId = job.id ?? `job-${Date.now()}`;
  const log = baseLogger.child({ tenantId, documentId, traceId });
  const pipelineStartedAt = new Date();

  log.info({ jobId: job.id }, 'iniciando pipeline de processamento');

  try {
    // Etapa 1: Extração de texto
    const extractResult = await extractDocument(job.data, {
      s3Bucket,
      extractor,
      db,
      logger: log,
    });

    // Buscar metadados do documento para montar ChunkDocumentMeta
    const docRecord = await db
      .collection('documents')
      .findOne(
        { id: documentId, tenantId },
        { projection: { departmentId: 1, documentTypeId: 1 } }
      );

    const departmentId = (docRecord?.['departmentId'] as string | undefined) ?? '';
    const documentTypeId = docRecord?.['documentTypeId'] as string | null | undefined;

    // Buscar nome do tipo de documento (desnormalizado nos chunks para evitar lookup na busca)
    let documentTypeName: string | null = null;
    if (documentTypeId) {
      const docType = await db
        .collection('document_types')
        .findOne({ id: documentTypeId }, { projection: { name: 1 } });
      documentTypeName = (docType?.['name'] as string | undefined) ?? null;
    }

    const chunkMeta: ChunkDocumentMeta = {
      documentId,
      tenantId,
      departmentId,
      documentTypeName,
    };

    // Etapa 2: Chunking semântico
    log.info({ fullTextLength: extractResult.fullText.length }, 'iniciando chunking');

    const chunks = chunkText(
      extractResult.fullText,
      chunkMeta,
      chunkTargetTokens,
      chunkOverlapTokens
    );

    log.info({ chunkCount: chunks.length }, 'chunking concluído');

    // Etapa 3: Embeddings
    log.info({ chunkCount: chunks.length }, 'iniciando embeddings');

    const { embeddedChunks, totalEmbeddingsUsd } = await embedChunks(chunks, {
      openai,
      embeddingModel,
      logger: log,
    });

    // Etapa 4: Persistência
    await persistProcessingResult(
      {
        job: job.data,
        extractResult,
        embeddedChunks,
        totalEmbeddingsUsd,
        pipelineStartedAt,
      },
      { db, logger: log }
    );

    log.info({ jobId: job.id }, 'pipeline concluído com sucesso');
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : String(err);
    const failureReason = message.slice(0, 500);

    log.error({ err, jobId: job.id }, 'pipeline falhou — marcando documento como FAILED');

    // Falha permanente: atualizar status mesmo se for o último retry
    await db.collection('documents').updateOne(
      { id: documentId, tenantId },
      {
        $set: {
          status: 'FAILED',
          failureReason,
          updatedAt: new Date(),
        },
      }
    ).catch((dbErr: unknown) => {
      log.error({ dbErr }, 'falha ao atualizar status FAILED no banco');
    });

    // Re-throw para BullMQ marcar o job como failed e fazer retry
    throw err;
  }
}
