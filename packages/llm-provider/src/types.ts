import { z } from 'zod';

/**
 * Mensagem de conversa passada para o LLM.
 *
 * Segue o contrato de mensagens da API OpenAI: `role` define quem fala
 * (`system` para instruções do sistema, `user` para input do usuário,
 * `assistant` para respostas anteriores do modelo) e `content` é o texto.
 */
export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/**
 * Parâmetros de uma chamada de chat ao LLM.
 *
 * `messages` é a conversa completa (system + user + histórico opcional).
 * `maxTokens` limita o tamanho da resposta gerada; se ausente, o modelo
 * usa seu padrão. `temperature` controla aleatoriedade (0 = determinístico).
 */
export const ChatParamsSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
});

export type ChatParams = z.infer<typeof ChatParamsSchema>;

/**
 * Informação de uso de tokens e custo de uma chamada.
 *
 * `promptTokens` + `completionTokens` = `totalTokens`.
 * `costUsd` é o custo estimado em dólares, calculado com base nos preços
 * do modelo no momento da chamada. Logado em toda call (spec §14).
 */
export const TokenUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});

export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/**
 * Resultado de uma chamada de chat (não-streaming).
 *
 * `content` é o texto completo gerado pelo modelo.
 * `usage` contém tokens + custo para logging obrigatório (spec §14).
 * `model` é o identificador do modelo usado (pode diferir do solicitado
 * quando o provedor redireciona para uma versão mais nova).
 */
export const ChatResultSchema = z.object({
  content: z.string(),
  usage: TokenUsageSchema,
  model: z.string(),
});

export type ChatResult = z.infer<typeof ChatResultSchema>;

/**
 * Contrato do adaptador de LLM.
 *
 * Interface única para OpenAI e qualquer provedor compatível (OpenRouter,
 * Azure OpenAI, etc.). As implementações NÃO lêem variáveis de ambiente
 * diretamente — recebem configuração pelo construtor.
 *
 * `chat` → resposta completa (bloqueia até o modelo terminar).
 * `chatStream` → AsyncIterable de fragmentos de texto (streaming incremental).
 *
 * Spec §6.1.
 */
export interface LLMProvider {
  chat(params: ChatParams): Promise<ChatResult>;
  chatStream(params: ChatParams): AsyncIterable<string>;
}

/**
 * Erro tipado para falhas de chamadas ao LLM.
 * Carrega o provider e, quando disponível, o HTTP status retornado.
 */
export class LLMError extends Error {
  public readonly provider: string;
  public readonly status: number | undefined;

  constructor(message: string, provider: string, status?: number, cause?: unknown) {
    super(message, { cause });
    this.name = 'LLMError';
    this.provider = provider;
    this.status = status !== undefined ? status : undefined;
  }
}
