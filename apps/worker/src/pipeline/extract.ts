import type { Sql } from 'postgres';
import type { Logger } from 'pino';
import type { ExtractorProvider } from '@dmdoc/extractor';
import type { DocumentProcessingJobData } from '@dmdoc/shared-types';

export interface ExtractResult {
  fullText: string;
  pageCount: number;
  ocrPages: number[];
  engine: 'unstructured' | 'native';
  engineVersion: string;
  durationMs: number;
  /** true quando o resultado veio do cache (idempotência) */
  fromCache: boolean;
}

export interface ExtractDeps {
  s3Bucket: string;
  extractor: ExtractorProvider;
  sql: Sql;
  logger: Logger;
}

/**
 * Etapa 1 do pipeline: publica o pedido de extração na fila Redis e aguarda
 * o resultado via BLPOP. O extractor Python baixa o arquivo do S3 diretamente.
 *
 * Idempotência: se `document_content` já tem `full_text` para este `documentId`,
 * retorna o resultado existente sem re-processar (spec §8, invariante 1).
 *
 * Atualiza `documents.status` para `PROCESSING` antes de iniciar o trabalho.
 */
export async function extractDocument(
  job: DocumentProcessingJobData,
  deps: ExtractDeps
): Promise<ExtractResult> {
  const { tenantId, documentId, s3Key, mimeType } = job;
  const { s3Bucket, extractor, sql, logger: baseLogger } = deps;

  const log = baseLogger.child({ tenantId, documentId, step: 'extract' });

  // Idempotência: verificar se já existe document_content com full_text
  const existingRows = await sql<
    Array<{ full_text: string; extraction: Record<string, unknown> | null }>
  >`
    SELECT full_text, extraction
    FROM document_content
    WHERE document_id = ${documentId}
      AND tenant_id = ${tenantId}
  `;

  const existing = existingRows[0];

  if (existing?.full_text) {
    log.info({ fromCache: true }, 'fullText já existe — pulando extração');
    const ext = existing.extraction ?? {};
    return {
      fullText: existing.full_text,
      pageCount: typeof ext['pageCount'] === 'number' ? ext['pageCount'] : 0,
      ocrPages: Array.isArray(ext['ocrPages']) ? (ext['ocrPages'] as number[]) : [],
      engine: (ext['engine'] as 'unstructured' | 'native') ?? 'native',
      engineVersion: typeof ext['engineVersion'] === 'string' ? ext['engineVersion'] : '0.0.0',
      durationMs: typeof ext['durationMs'] === 'number' ? ext['durationMs'] : 0,
      fromCache: true,
    };
  }

  // Atualizar status para PROCESSING e limpar failure_reason de tentativas anteriores
  await sql`
    UPDATE documents
    SET status = 'PROCESSING',
        failure_reason = null
    WHERE id = ${documentId}
      AND tenant_id = ${tenantId}
  `;

  log.info({ s3Key, mimeType }, 'enviando para fila de extração');

  // Enfileira no Redis e aguarda resultado via BLPOP (sem timeout HTTP)
  const result = await extractor.extract({ s3Key, s3Bucket, mimeType });

  log.info(
    {
      engine: result.engine,
      engineVersion: result.engineVersion,
      pageCount: result.pageCount,
      ocrPages: result.ocrPages,
      durationMs: result.durationMs,
      fullTextLength: result.fullText.length,
    },
    'extração concluída'
  );

  return {
    fullText: result.fullText,
    pageCount: result.pageCount,
    ocrPages: result.ocrPages,
    engine: result.engine,
    engineVersion: result.engineVersion,
    durationMs: result.durationMs,
    fromCache: false,
  };
}
