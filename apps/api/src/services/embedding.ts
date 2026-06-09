import OpenAI from 'openai';
import { z } from 'zod';

/**
 * Interface mínima de logger usada pelo serviço de embedding.
 * Compatível com Pino Logger e FastifyBaseLogger.
 */
interface MinimalLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Custo por token do `text-embedding-3-small` (USD).
 * Fonte: https://openai.com/pricing (US$0.02 / 1M tokens)
 */
const COST_USD_PER_TOKEN = 0.02 / 1_000_000;

/**
 * Dimensões esperadas do text-embedding-3-small.
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

export interface EmbedQueryResult {
  embedding: number[];
  promptTokens: number;
  costUsd: number;
}

/**
 * Gera o embedding de uma query de busca usando text-embedding-3-small.
 *
 * Valida a dimensão retornada com Zod. Loga tokens + custo (spec §14).
 *
 * @param text   Texto da query.
 * @param openai Cliente OpenAI (nunca OpenRouter — embeddings são sempre OpenAI).
 * @param model  Modelo de embedding (default: text-embedding-3-small).
 * @param logger Logger compatível com Pino/Fastify.
 */
export async function embedQuery(
  text: string,
  openai: OpenAI,
  model: string,
  logger: MinimalLogger
): Promise<EmbedQueryResult> {
  const startMs = Date.now();

  const raw = await openai.embeddings.create({ model, input: text });

  const parsed = EmbeddingResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Resposta de embedding da query inválida: ${parsed.error.message}`);
  }

  const embedding = parsed.data.data[0]?.embedding;
  if (!embedding) {
    throw new Error('Embedding da query não retornado pela API');
  }

  const promptTokens = parsed.data.usage.prompt_tokens;
  const costUsd = promptTokens * COST_USD_PER_TOKEN;

  logger.info(
    {
      durationMs: Date.now() - startMs,
      promptTokens,
      costUsd: costUsd.toFixed(8),
      model,
    },
    'embedding de query gerado'
  );

  return { embedding, promptTokens, costUsd };
}
