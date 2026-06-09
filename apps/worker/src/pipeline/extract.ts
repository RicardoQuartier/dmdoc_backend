import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { fileTypeFromFile } from 'file-type';
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
  s3: S3Client;
  s3Bucket: string;
  extractor: ExtractorProvider;
  db: Db;
  logger: Logger;
}

/**
 * Etapa 1 do pipeline: faz download do S3, detecta MIME real, extrai texto.
 *
 * Idempotência: se `document_content` já tem `fullText` para este `documentId`,
 * retorna o resultado existente sem re-processar (spec §8, invariante 1).
 *
 * Atualiza `documents.status` para `PROCESSING` antes de iniciar o trabalho.
 *
 * O arquivo temporário é sempre removido no `finally`, mesmo em caso de erro.
 */
export async function extractDocument(
  job: DocumentProcessingJobData,
  deps: ExtractDeps
): Promise<ExtractResult> {
  const { tenantId, documentId, s3Key, mimeType } = job;
  const { s3, s3Bucket, extractor, db, logger: baseLogger } = deps;

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

  log.info({ s3Key, mimeType }, 'iniciando download do S3');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmdoc-'));
  const ext = path.extname(s3Key) || '.bin';
  const tmpFile = path.join(tmpDir, `document${ext}`);

  try {
    // Download do S3
    const command = new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key });
    const response = await s3.send(command);

    if (!response.Body) {
      throw new Error(`S3 retornou body vazio para a chave: ${s3Key}`);
    }

    const writeStream = (await fs.open(tmpFile, 'w')).createWriteStream();
    await pipeline(response.Body as Readable, writeStream);

    log.debug({ tmpFile }, 'arquivo salvo em disco');

    // Detectar MIME real (não confiar no mimeType do upload)
    const detected = await fileTypeFromFile(tmpFile);
    const detectedMime = detected?.mime ?? mimeType;

    if (detected && detected.mime !== mimeType) {
      log.warn(
        { uploadedMime: mimeType, detectedMime: detected.mime },
        'MIME detectado difere do informado no upload'
      );
    }

    // Extração de texto
    log.info({ detectedMime }, 'iniciando extração de texto');
    const result = await extractor.extract(tmpFile, detectedMime);

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
  } finally {
    // Limpeza do arquivo temporário, sempre — mesmo em caso de erro
    await fs.rm(tmpDir, { recursive: true, force: true }).catch((err: unknown) => {
      log.warn({ err, tmpDir }, 'falha ao remover diretório temporário');
    });
  }
}
