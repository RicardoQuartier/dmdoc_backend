import type { Db } from 'mongodb';
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
  db: Db;
  logger: Logger;
}

/**
 * Etapa 1 do pipeline: publica o pedido de extração na fila Redis e aguarda
 * o resultado via BLPOP. O extractor Python baixa o arquivo do S3 diretamente.
 *
 * Idempotência: se `document_content` já tem `fullText` para este `documentId`,
 * retorna o resultado existente sem re-processar (spec §8, invariante 1).
 *
 * Atualiza `documents.status` para `PROCESSING` antes de iniciar o trabalho.
 */
export async function extractDocument(
  job: DocumentProcessingJobData,
  deps: ExtractDeps
): Promise<ExtractResult> {
  const { tenantId, documentId, s3Key, mimeType } = job;
  const { s3Bucket, extractor, db, logger: baseLogger } = deps;

  const log = baseLogger.child({ tenantId, documentId, step: 'extract' });

  // Idempotência: verificar se já existe document_content com fullText
  const existing = await db
    .collection('document_content')
    .findOne({ documentId, tenantId }, { projection: { fullText: 1, extraction: 1 } });

  if (existing?.fullText) {
    log.info({ fromCache: true }, 'fullText já existe — pulando extração');
    const ext = existing['extraction'] as Record<string, unknown> | undefined;
    return {
      fullText: existing['fullText'] as string,
      pageCount: typeof ext?.['pageCount'] === 'number' ? ext['pageCount'] : 0,
      ocrPages: Array.isArray(ext?.['ocrPages']) ? (ext['ocrPages'] as number[]) : [],
      engine: (ext?.['engine'] as 'unstructured' | 'native') ?? 'native',
      engineVersion: typeof ext?.['engineVersion'] === 'string' ? ext['engineVersion'] : '0.0.0',
      durationMs: typeof ext?.['durationMs'] === 'number' ? ext['durationMs'] : 0,
      fromCache: true,
    };
  }

  // Atualizar status para PROCESSING e limpar failureReason de tentativas anteriores
  await db.collection('documents').updateOne(
    { id: documentId, tenantId },
    { $set: { status: 'PROCESSING', failureReason: null, updatedAt: new Date() } }
  );

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
