import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Sql } from '@dmdoc/db-pg';
import type { Config } from '../config.js';
import { UnauthorizedError } from '../errors/index.js';
import { AuditLogger } from '../auth/audit.js';
import { InvalidTokenError, TokenService, type AccessClaims } from '../auth/tokens.js';
import { UserStore } from '../auth/user-store.js';

/**
 * Contexto de autenticação injetado na request por `authenticate`.
 *
 * `tenantId` é `null` para SUPER_ADMIN e MULTI_TENANT_ADMIN — ambos não operam
 * implicitamente sobre nenhuma empresa. SUPER_ADMIN seleciona a empresa-alvo
 * por parâmetro EXPLÍCITO de rota (spec §10, invariante 3). MULTI_TENANT_ADMIN
 * opera sobre `allowedTenantIds` — leituras buscam em todos os tenants da lista,
 * escritas exigem `tenantId` explícito validado contra a lista.
 *
 * Para os demais papéis, `tenantId` é a empresa dona do contexto, e é com ele
 * que o `TenantRepository` garante o 404 cross-tenant (recurso de outra empresa
 * é inalcançável, nunca 403).
 *
 * `allowedTenantIds` é significativo apenas para MULTI_TENANT_ADMIN; para os
 * demais papéis é sempre um array vazio.
 */
export interface RequestUser {
  sub: string;
  role: AccessClaims['role'];
  tenantId: string | null;
  allowedTenantIds: string[];
}

declare module 'fastify' {
  interface FastifyInstance {
    tokens: TokenService;
    users: UserStore;
    audit: AuditLogger;
    /**
     * preHandler que exige um access token válido. Popula `request.user` e
     * `request.tenantId`, ou responde 401 genérico.
     */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    /** Identidade autenticada. Indefinida em rotas públicas / antes do preHandler. */
    user?: RequestUser;
    /**
     * Empresa do contexto da request. `null` para SUPER_ADMIN (acessa empresa
     * via parâmetro de rota). Indefinida antes do `authenticate`.
     */
    tenantId?: string | null;
  }
}

export interface AuthPluginOptions {
  config: Config;
  sql: Sql;
}

/**
 * Plugin de autenticação. Decora a app com os serviços de token, store de
 * usuários e auditoria, e com o preHandler `authenticate`.
 *
 * Registrado via `fastify-plugin` (fp) para que os decorators fiquem visíveis
 * em TODA a árvore de rotas, não apenas no encapsulamento local.
 */
const authPluginImpl: FastifyPluginAsync<AuthPluginOptions> = async (app, options) => {
  const { config, sql } = options;

  app.decorate('tokens', new TokenService(config));
  app.decorate('users', new UserStore(sql));
  app.decorate('audit', new AuditLogger(sql));

  app.decorate(
    'authenticate',
    async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
      const token = extractBearerToken(request.headers.authorization);
      if (token === null) {
        throw new UnauthorizedError('Token de acesso ausente');
      }

      let claims: AccessClaims;
      try {
        claims = app.tokens.verifyAccessToken(token);
      } catch (error) {
        if (error instanceof InvalidTokenError) {
          throw new UnauthorizedError('Token de acesso inválido');
        }
        throw error;
      }

      request.user = {
        sub: claims.sub,
        role: claims.role,
        tenantId: claims.tenantId,
        allowedTenantIds: claims.allowedTenantIds,
      };
      // SUPER_ADMIN e MULTI_TENANT_ADMIN não têm empresa fixa — tenantId null.
      // Para MTA o contexto de tenant é resolvido dinamicamente por
      // resolveTenantContext() em cada rota que precisar.
      request.tenantId = claims.tenantId;
    }
  );
};

/**
 * Extrai o token do header `Authorization: Bearer <token>`. Retorna `null` se
 * ausente ou malformado.
 */
function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) {
    return null;
  }
  const [scheme, token] = authorization.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return null;
  }
  return token;
}

export const authPlugin = fp(authPluginImpl, { name: 'auth' });
