import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import type { Config } from '../config.js';

export interface RateLimitPluginOptions {
  config: Config;
}

/**
 * Plugin de rate limiting por tenant — Fase 5, entregável 39.
 *
 * Limita requisições por janela de tempo usando o `tenantId` como chave.
 * Para usuários não autenticados (login, healthz) recai no IP como chave
 * fallback, que é o comportamento padrão do @fastify/rate-limit.
 *
 * Limites configuráveis via env:
 *   RATE_LIMIT_MAX        — máximo de requisições por janela (default 200)
 *   RATE_LIMIT_WINDOW_MS  — tamanho da janela em ms (default 60000 = 1 min)
 *
 * Retorna 429 com header `Retry-After` quando o limite é atingido.
 */
const rateLimitPluginImpl: FastifyPluginAsync<RateLimitPluginOptions> = async (app, options) => {
  const { config } = options;

  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,

    /**
     * Chave de identificação: `tenantId` quando disponível (request já passou
     * pelo `authenticate`), caso contrário IP do cliente.
     *
     * A função é chamada antes de `preHandler`, então `request.tenantId` pode
     * ser `undefined` em rotas públicas (login, healthz).
     */
    keyGenerator: (request) => {
      const tenantId = request.tenantId;
      if (tenantId !== undefined && tenantId !== null) {
        return `tenant:${tenantId}`;
      }
      // Fallback para IP (rotas públicas)
      return request.ip;
    },

    /**
     * Resposta 429 padronizada com o mesmo envelope de erro do projeto.
     */
    errorResponseBuilder: (_request, context) => {
      return {
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Limite de requisições atingido. Tente novamente em ${Math.ceil(context.ttl / 1000)} segundos.`,
          retryAfterMs: context.ttl,
        },
      };
    },
  });
};

export const rateLimitPlugin = fp(rateLimitPluginImpl, { name: 'rate-limit' });
