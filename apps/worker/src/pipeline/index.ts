import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import type { Logger } from 'pino';
import OpenAI from 'openai';
import type { ExtractorProvider } from '@dmdoc/extractor';
import type { LLMProvider } from '@dmdoc/llm-provider';
import type { DocumentProcessingJobData } from '@dmdoc/shared-types';
import { extractDocument } from './extract.js';
import { chunkText, type ChunkDocumentMeta } from './chunk.js';
import { embedChunks } from './embed.js';
import { classifyDocument } from './classify.js';
import { persistProcessingResult } from './persist.js';
import { suggestIndexesStep } from './suggest-indexes.js';
import { generateTagsStep } from './generate-tags.js';

export interface PipelineDeps {
  s3Bucket: string;
  extractor: ExtractorProvider;
  openai: OpenAI;
  embeddingModel: string;
  /** Provider de LLM de chat — usado na classificação automática (Fase 8). */
  llmProvider: LLMProvider;
  /** Modelo de chat configurado — fallback de auditoria no TypeSuggestion. */
  chatModel: string;
  sql: Sql;
  logger: Logger;
  chunkTargetTokens?: number;
  chunkOverlapTokens?: number;
  /**
   * Confiança MÍNIMA da classificação (Fase 8) para disparar a sugestão
   * automática de índices (Fase 7) sobre o tipo sugerido. Default 0.5.
   */
  indexSuggestionMinConfidence?: number;
}

/** Limiar default de confiança para a sugestão automática de índices. */
const DEFAULT_INDEX_SUGGESTION_MIN_CONFIDENCE = 0.5;

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
    llmProvider,
    chatModel,
    sql,
    logger: baseLogger,
    chunkTargetTokens,
    chunkOverlapTokens,
    indexSuggestionMinConfidence = DEFAULT_INDEX_SUGGESTION_MIN_CONFIDENCE,
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
      sql,
      logger: log,
    });

    // Buscar metadados do documento para montar ChunkDocumentMeta
    const docRows = await sql<Array<{ department_id: string; document_type_id: string | null }>>`
      SELECT department_id, document_type_id
      FROM documents
      WHERE id = ${documentId}
        AND tenant_id = ${tenantId}
        AND deleted = false
    `;

    const docRecord = docRows[0];
    const departmentId = docRecord?.department_id ?? '';
    const documentTypeId = docRecord?.document_type_id ?? null;

    // Buscar nome do tipo de documento (desnormalizado nos chunks para evitar lookup na busca)
    let documentTypeName: string | null = null;
    if (documentTypeId) {
      const typeRows = await sql<Array<{ name: string }>>`
        SELECT name
        FROM document_types
        WHERE id = ${documentTypeId}
      `;
      documentTypeName = typeRows[0]?.name ?? null;
    }

    const chunkMeta: ChunkDocumentMeta = {
      documentId,
      tenantId,
      departmentId,
      documentTypeName,
    };

    // Etapa 2: Classificação automática de tipo (Fase 8) — best-effort.
    // Roda logo após a extração (usa `extractResult.fullText`) e NUNCA derruba
    // o pipeline: erro/skip retornam sugestão null sem interromper as etapas
    // seguintes. NÃO toca em `documents.document_type_id` (escolha manual).
    const { typeSuggestion, suggestedTitle, classificationUsd } =
      await classifyDocument(
        {
          tenantId,
          documentId,
          departmentId,
          fullText: extractResult.fullText,
        },
        { sql, llmProvider, chatModel, logger: log }
      );

    // Etapa 3: Chunking semântico
    log.info({ fullTextLength: extractResult.fullText.length }, 'iniciando chunking');

    const chunks = chunkText(
      extractResult.fullText,
      chunkMeta,
      chunkTargetTokens,
      chunkOverlapTokens
    );

    log.info({ chunkCount: chunks.length }, 'chunking concluído');

    // Etapa 4: Embeddings
    log.info({ chunkCount: chunks.length }, 'iniciando embeddings');

    const { embeddedChunks, totalEmbeddingsUsd } = await embedChunks(chunks, {
      openai,
      embeddingModel,
      logger: log,
    });

    // Etapa 5: Persistência
    await persistProcessingResult(
      {
        job: job.data,
        extractResult,
        embeddedChunks,
        totalEmbeddingsUsd,
        typeSuggestion,
        suggestedTitle,
        classificationUsd,
        pipelineStartedAt,
        typeAutoApplyMinConfidence: indexSuggestionMinConfidence,
      },
      { sql, logger: log }
    );

    // Etapa 6: Sugestão automática de índices (Fase 7) — GATILHO 1 (upload).
    // Best-effort e CONSULTIVA: roda após o persist (document_content já existe)
    // sobre o TIPO SUGERIDO pela classificação quando a confiança atinge o
    // limiar e a feature está ligada. NUNCA derruba o pipeline nem toca o tipo
    // confirmado — o documento já está READY.
    await suggestIndexesStep(
      {
        tenantId,
        documentId,
        typeSuggestion,
        minConfidence: indexSuggestionMinConfidence,
      },
      { sql, llmProvider, logger: log }
    );

    // Etapa 7: Geração automática de tags (Fase 9 / E-3) — best-effort e
    // CONSULTIVA. Roda após o persist (usa `document_content.full_text`),
    // INDEPENDENTE do tipo (as tags são livres — cobrem PDFs com vários
    // documentos concatenados). Gated por `tagGenerationEnabled` (plataforma
    // AND empresa); grava só `document_content.suggested_tags` (nunca
    // `documents.tags`). NUNCA derruba o pipeline — o documento já está READY.
    await generateTagsStep({ tenantId, documentId }, { sql, llmProvider, logger: log });

    log.info({ jobId: job.id }, 'pipeline concluído com sucesso');
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : String(err);
    const failureReason = message.slice(0, 500);

    log.error({ err, jobId: job.id }, 'pipeline falhou — marcando documento como FAILED');

    // Falha permanente: atualizar status mesmo se for o último retry
    await sql`
      UPDATE documents
      SET status = 'FAILED',
          failure_reason = ${failureReason}
      WHERE id = ${documentId}
        AND tenant_id = ${tenantId}
    `.catch((dbErr: unknown) => {
      log.error({ dbErr }, 'falha ao atualizar status FAILED no banco');
    });

    // Re-throw para BullMQ marcar o job como failed e fazer retry
    throw err;
  }
}
