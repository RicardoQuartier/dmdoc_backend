import OpenAI from 'openai';
import { z } from 'zod';
import type { Logger } from 'pino';
import type { ChunkDraft } from './chunk.js';

export interface EmbeddedChunkDraft extends ChunkDraft {
  embedding: number[];
}

export interface EmbedDeps {
  openai: OpenAI;
  embeddingModel: string;
  logger: Logger;
}

const BATCH_SIZE = 100;

/**
 * Dimensões do modelo text-embedding-3-small.
 * Validadas via Zod na resposta da API para detectar mudanças de modelo.
 */
const EMBEDDING_DIMENSIONS = 1536;

const EmbeddingResponseSchema = z.object({
  data: z.array(
    z.object({
      embedding: z.array(z.number()).length(EMBEDDING_DIMENSIONS),
      index: z.number().int().nonnegative(),
    })
  ),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  }),
});

/**
 * Custo por token do `text-embedding-3-small` (USD).
 * Fonte: https://openai.com/pricing (US$0.02 / 1M tokens = $0.00002 / 1k tokens)
 */
const COST_USD_PER_TOKEN = 0.00002 / 1000;

/**
 * Aguarda `ms` milissegundos.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Chama a API de embeddings com retry exponencial em caso de rate limit (429).
 *
 * Tentativas: 3, delays: 2s / 4s / 8s.
 */
async function embedBatchWithRetry(
  openai: OpenAI,
  model: string,
  texts: string[],
  log: Logger
): Promise<z.infer<typeof EmbeddingResponseSchema>> {
  const delays = [2000, 4000, 8000];
  let lastError: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const raw = await openai.embeddings.create({ model, input: texts });

      // Validar resposta com Zod
      const parsed = EmbeddingResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `Resposta de embedding inválida: ${parsed.error.message}`
        );
      }
      return parsed.data;
    } catch (err: unknown) {
      lastError = err;
      const isRateLimit =
        err instanceof OpenAI.APIError && err.status === 429;

      if (isRateLimit && attempt < delays.length) {
        const delay = delays[attempt] ?? 8000;
        log.warn(
          { attempt: attempt + 1, delayMs: delay },
          'rate limit na API de embeddings — aguardando antes de retry'
        );
        await sleep(delay);
        continue;
      }

      throw err;
    }
  }

  throw lastError;
}

/**
 * Gera embeddings para um array de ChunkDrafts.
 *
 * Regras:
 * - Nunca chama a API individualmente por chunk — sempre em batches de 100.
 * - Valida a dimensão do embedding (1536) via Zod.
 * - Loga custo por batch e acumula total.
 * - Retry com backoff exponencial em caso de rate limit.
 *
 * @returns Array de ChunkDrafts enriquecidos com `embedding`.
 *          A ordem é preservada em relação ao array de entrada.
 */
export async function embedChunks(
  chunks: ChunkDraft[],
  deps: EmbedDeps
): Promise<{ embeddedChunks: EmbeddedChunkDraft[]; totalEmbeddingsUsd: number }> {
  const { openai, embeddingModel, logger: baseLogger } = deps;
  const log = baseLogger.child({ step: 'embed', model: embeddingModel });

  if (chunks.length === 0) {
    return { embeddedChunks: [], totalEmbeddingsUsd: 0 };
  }

  const result: EmbeddedChunkDraft[] = new Array(chunks.length) as EmbeddedChunkDraft[];
  let totalEmbeddingsUsd = 0;

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const batchIndex = Math.floor(i / BATCH_SIZE);

    log.debug(
      { batchIndex, batchSize: batch.length, offset: i },
      'enviando batch de embeddings'
    );

    const response = await embedBatchWithRetry(
      openai,
      embeddingModel,
      batch.map((c) => c.text),
      log
    );

    // Calcular custo do batch
    const batchCostUsd = response.usage.prompt_tokens * COST_USD_PER_TOKEN;
    const batchCostUsdCents = Math.ceil(batchCostUsd * 100);
    totalEmbeddingsUsd += batchCostUsd;

    log.info(
      {
        batchIndex,
        batchSize: batch.length,
        promptTokens: response.usage.prompt_tokens,
        costUsd: batchCostUsd.toFixed(6),
        costUsdCents: batchCostUsdCents,
      },
      'batch de embeddings concluído'
    );

    // Mapear embeddings de volta para os chunks (pela ordem do índice na resposta)
    for (const item of response.data) {
      const chunk = batch[item.index];
      if (!chunk) {
        throw new Error(
          `Embedding retornou índice ${item.index} fora do range do batch`
        );
      }
      result[i + item.index] = {
        ...chunk,
        embedding: item.embedding,
      };
    }
  }

  log.info(
    {
      totalChunks: chunks.length,
      totalEmbeddingsUsd: totalEmbeddingsUsd.toFixed(6),
      totalCostUsdCents: Math.ceil(totalEmbeddingsUsd * 100),
    },
    'todos os embeddings gerados'
  );

  return { embeddedChunks: result, totalEmbeddingsUsd };
}
