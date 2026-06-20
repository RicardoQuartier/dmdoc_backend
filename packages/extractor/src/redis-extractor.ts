import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { type ExtractInput, type ExtractionResult, type ExtractorProvider, ExtractionError } from './types.js';

export interface RedisExtractorConfig {
  /** URL Redis para criar conexões dedicadas de BLPOP. */
  redisUrl: string;
  /**
   * Conexão compartilhada para RPUSH de requests.
   * Injetada externamente para reutilizar a conexão existente do worker.
   */
  pushConnection: Redis;
  /**
   * Timeout do BLPOP em segundos. Cobre o pior caso de OCR em CPU.
   * Default: 7200 (2h). Zero = bloqueia indefinidamente.
   */
  blpopTimeoutSecs?: number;
}

const REQUEST_QUEUE = 'extract:requests';
const RESULT_PREFIX = 'extract:result:';
const DEFAULT_BLPOP_TIMEOUT_SECS = 7200;

export class RedisExtractor implements ExtractorProvider {
  constructor(private readonly cfg: RedisExtractorConfig) {}

  async extract(input: ExtractInput): Promise<ExtractionResult> {
    const { s3Key, s3Bucket, mimeType } = input;
    const requestId = randomUUID();
    const resultKey = `${RESULT_PREFIX}${requestId}`;
    const timeoutSecs = this.cfg.blpopTimeoutSecs ?? DEFAULT_BLPOP_TIMEOUT_SECS;
    const startMs = Date.now();

    await this.cfg.pushConnection.rpush(
      REQUEST_QUEUE,
      JSON.stringify({ requestId, s3Key, s3Bucket, mimeType })
    );

    // Conexão dedicada por chamada: ioredis não permite múltiplos BLPOP concorrentes
    // na mesma conexão (ela fica bloqueada no comando). Com WORKER_CONCURRENCY=5,
    // no máximo 5 conexões extras simultâneas — completamente aceitável.
    const resultConn = new Redis(this.cfg.redisUrl, { maxRetriesPerRequest: null });
    try {
      const raw = await resultConn.blpop(resultKey, timeoutSecs);

      if (!raw) {
        throw new ExtractionError(
          `Timeout de ${timeoutSecs}s aguardando resultado de extração (requestId=${requestId})`,
          mimeType,
          'native'
        );
      }

      const [, value] = raw;
      let parsed: { text?: string; pageCount?: number; ocrPages?: number[]; error?: string };
      try {
        parsed = JSON.parse(value) as typeof parsed;
      } catch (err) {
        throw new ExtractionError(
          'JSON inválido no resultado de extração',
          mimeType,
          'native',
          err
        );
      }

      if (parsed.error) {
        throw new ExtractionError(`Python extractor: ${parsed.error}`, mimeType, 'native');
      }

      return {
        fullText: (parsed.text ?? '').trim(),
        pageCount:
          typeof parsed.pageCount === 'number' && parsed.pageCount > 0 ? parsed.pageCount : 1,
        ocrPages: Array.isArray(parsed.ocrPages) ? parsed.ocrPages : [],
        engine: 'native',
        engineVersion: 'python-extractor-redis',
        durationMs: Date.now() - startMs,
      };
    } finally {
      resultConn.disconnect();
    }
  }
}
