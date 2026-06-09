import OpenAI from 'openai';
import { z } from 'zod';
import type { ChatParams, ChatResult, LLMProvider } from './types.js';
import { LLMError } from './types.js';

/**
 * Interface mínima de logger — compatível com Pino Logger e FastifyBaseLogger.
 * Evitar dependência direta de `pino` no pacote permite uso em contextos
 * onde apenas o Logger do Fastify está disponível.
 */
interface MinimalLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  child(bindings: Record<string, unknown>): MinimalLogger;
}

/**
 * Tabela de preços por modelo (USD por token).
 *
 * Usada para calcular `costUsd` e logar nas chamadas (spec §14).
 * Valores aproximados — atualizar conforme pricing dos provedores.
 * Modelos não listados aqui assumem custo zero (não-fatal: só o log fica errado).
 */
const MODEL_PRICING: Record<string, { promptPerToken: number; completionPerToken: number }> = {
  // OpenAI
  'gpt-4o': { promptPerToken: 5 / 1_000_000, completionPerToken: 15 / 1_000_000 },
  'gpt-4o-mini': { promptPerToken: 0.15 / 1_000_000, completionPerToken: 0.6 / 1_000_000 },
  'gpt-4-turbo': { promptPerToken: 10 / 1_000_000, completionPerToken: 30 / 1_000_000 },
  'gpt-3.5-turbo': { promptPerToken: 0.5 / 1_000_000, completionPerToken: 1.5 / 1_000_000 },
  // OpenRouter — modelos gratuitos têm custo zero
  'google/gemma-3-27b-it:free': { promptPerToken: 0, completionPerToken: 0 },
  'meta-llama/llama-3.3-70b-instruct:free': { promptPerToken: 0, completionPerToken: 0 },
  'deepseek/deepseek-chat:free': { promptPerToken: 0, completionPerToken: 0 },
};

/**
 * Estima o custo de uma chamada com base nos tokens usados e no modelo.
 * Retorna 0 para modelos desconhecidos (seguro — só afeta logging).
 */
function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return pricing.promptPerToken * promptTokens + pricing.completionPerToken * completionTokens;
}

/**
 * Schema de validação da resposta não-streaming da API OpenAI.
 * Valida apenas os campos que o provider usa — campos extras são ignorados.
 */
const ChatCompletionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable(),
        }),
        finish_reason: z.string().nullable().optional(),
      })
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
      total_tokens: z.number().int().nonnegative(),
    })
    .optional(),
  model: z.string(),
});

/**
 * Implementação de `LLMProvider` usando o SDK oficial da OpenAI.
 *
 * Compatível com qualquer provedor que implemente a API REST OpenAI:
 * basta trocar `baseURL` e `apiKey`. OpenRouter e Azure OpenAI funcionam
 * sem alteração no código — apenas configuração muda (spec §6.1).
 *
 * Responsabilidades:
 * - Traduzir `ChatParams` para o formato OpenAI.
 * - Validar resposta com Zod (falha rápida se a API mudar).
 * - Calcular e logar tokens + custo em toda chamada (spec §14).
 * - Expor `chatStream` como AsyncIterable de fragmentos de texto.
 *
 * NÃO lê `process.env` — recebe config pelo construtor.
 */
export class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly logger: MinimalLogger;
  private readonly providerName: string;

  constructor(options: {
    baseURL: string;
    apiKey: string;
    model: string;
    logger: MinimalLogger;
    /** Nome do provedor para logs e erros (ex.: "openai", "openrouter"). */
    providerName?: string;
  }) {
    this.client = new OpenAI({
      baseURL: options.baseURL,
      apiKey: options.apiKey,
    });
    this.model = options.model;
    this.logger = options.logger.child({ llmProvider: options.providerName ?? 'openai', model: options.model });
    this.providerName = options.providerName ?? 'openai';
  }

  /**
   * Chamada síncrona (aguarda resposta completa do modelo).
   *
   * Valida a resposta com Zod antes de retornar. Loga tokens + custo.
   * Lança `LLMError` em caso de falha de API ou resposta malformada.
   */
  async chat(params: ChatParams): Promise<ChatResult> {
    const startMs = Date.now();

    try {
      const raw = await this.client.chat.completions.create({
        model: this.model,
        messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
        ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        stream: false,
      });

      const parsed = ChatCompletionResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new LLMError(
          `Resposta do LLM inválida: ${parsed.error.message}`,
          this.providerName
        );
      }

      const data = parsed.data;
      const content = data.choices[0]?.message.content ?? '';
      const promptTokens = data.usage?.prompt_tokens ?? 0;
      const completionTokens = data.usage?.completion_tokens ?? 0;
      const totalTokens = data.usage?.total_tokens ?? 0;
      const costUsd = estimateCost(this.model, promptTokens, completionTokens);
      const durationMs = Date.now() - startMs;

      this.logger.info(
        {
          durationMs,
          promptTokens,
          completionTokens,
          totalTokens,
          costUsd: costUsd.toFixed(6),
          finishReason: data.choices[0]?.finish_reason,
        },
        'chat LLM concluído'
      );

      return {
        content,
        usage: { promptTokens, completionTokens, totalTokens, costUsd },
        model: data.model,
      };
    } catch (err: unknown) {
      if (err instanceof LLMError) throw err;

      const status = err instanceof OpenAI.APIError ? err.status : undefined;
      const message =
        err instanceof Error
          ? `Chamada ao LLM falhou: ${err.message}`
          : 'Chamada ao LLM falhou com erro desconhecido';

      this.logger.error({ err, durationMs: Date.now() - startMs }, message);
      throw new LLMError(message, this.providerName, status, err);
    }
  }

  /**
   * Chamada streaming: retorna um AsyncIterable de fragmentos de texto.
   *
   * Cada fragmento é um pedaço do conteúdo gerado pelo modelo (delta).
   * O iterável termina quando o modelo sinaliza `finish_reason`.
   *
   * Nota de uso: o chamador é responsável por acumular os fragmentos
   * se precisar do texto completo. O custo da chamada streaming é
   * estimado ao final com base nos tokens reportados pelo provedor
   * (nem todos os provedores reportam — neste caso costUsd fica zero
   * nos logs, mas a operação continua normalmente).
   */
  async *chatStream(params: ChatParams): AsyncIterable<string> {
    const startMs = Date.now();
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
        ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        stream: true,
        stream_options: { include_usage: true },
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          yield delta;
        }

        // O último chunk de alguns provedores inclui usage
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens ?? 0;
          completionTokens = chunk.usage.completion_tokens ?? 0;
        }
      }

      const totalTokens = promptTokens + completionTokens;
      const costUsd = estimateCost(this.model, promptTokens, completionTokens);
      const durationMs = Date.now() - startMs;

      this.logger.info(
        {
          durationMs,
          promptTokens,
          completionTokens,
          totalTokens,
          costUsd: costUsd.toFixed(6),
        },
        'chatStream LLM concluído'
      );
    } catch (err: unknown) {
      const status = err instanceof OpenAI.APIError ? err.status : undefined;
      const message =
        err instanceof Error
          ? `Stream LLM falhou: ${err.message}`
          : 'Stream LLM falhou com erro desconhecido';

      this.logger.error({ err, durationMs: Date.now() - startMs }, message);
      throw new LLMError(message, this.providerName, status, err);
    }
  }
}
