import { OpenAIProvider } from './openai-provider.js';
import type { LLMProvider } from './types.js';

/**
 * Interface mínima de logger — compatível com Pino e FastifyBaseLogger.
 */
interface MinimalLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  child(bindings: Record<string, unknown>): MinimalLogger;
}

/**
 * Configuração para criação de um LLMProvider.
 *
 * Espelha as variáveis de ambiente da spec §12 sem acoplar a `process.env`.
 * O chamador (config.ts de cada app) é quem lê o ambiente e passa aqui.
 */
export interface LLMProviderConfig {
  /** "openai" | "openrouter" — determina o nome nos logs e erros. */
  provider: 'openai' | 'openrouter';
  /** URL base da API. Para OpenAI: https://api.openai.com/v1 */
  baseURL: string;
  /** API key do provedor. */
  apiKey: string;
  /** Identificador do modelo (ex.: "gpt-4o", "google/gemma-3-27b-it:free"). */
  model: string;
}

/**
 * Fábrica de LLMProvider.
 *
 * Único ponto de criação de providers — isola o resto do código da
 * escolha de implementação. Hoje só existe `OpenAIProvider` (funciona
 * com OpenAI e OpenRouter via baseURL). Novos provedores entram aqui.
 *
 * Spec §6.1.
 */
export function createLLMProvider(config: LLMProviderConfig, logger: MinimalLogger): LLMProvider {
  // OpenRouter usa a mesma interface REST do OpenAI — basta trocar baseURL/apiKey.
  // Por isso não há um OpenRouterProvider separado: a fábrica instancia
  // OpenAIProvider com os parâmetros certos e sinaliza o nome via `providerName`.
  return new OpenAIProvider({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    model: config.model,
    logger,
    providerName: config.provider,
  });
}
