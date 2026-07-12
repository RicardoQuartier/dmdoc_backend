import { AppError } from './AppError.js';

/**
 * Lançado quando uma empresa (ou um IP, em rotas públicas) excede o limite de
 * requisições por janela de tempo (regra "Limites operacionais por empresa:
 * rate limiting e cotas de uso").
 *
 * HTTP 429 Too Many Requests. Carrega `retryAfterMs` — quanto tempo (em ms) o
 * cliente deve esperar antes de tentar de novo — para que o error handler
 * central o exponha no corpo, além dos headers `x-ratelimit-*`/`retry-after`
 * já emitidos pelo @fastify/rate-limit.
 *
 * É construído dentro do `errorResponseBuilder` do plugin de rate limit e
 * lançado pelo próprio plugin; por ser um `AppError`, o error handler central
 * o mapeia para 429 (antes deste erro tipado, o objeto simples devolvido pelo
 * builder caía no branch genérico e vazava como 500).
 */
export class RateLimitError extends AppError {
  public readonly statusCode = 429;
  public readonly code = 'RATE_LIMIT_EXCEEDED';
  public readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}
