import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  LoginRequestSchema,
  RefreshRequestSchema,
  type LoginResponse,
  type AuthUser,
} from '@dmdoc/shared-types';
import { UnauthorizedError } from '../errors/index.js';
import { verifyPassword } from '../auth/password.js';
import { InvalidTokenError } from '../auth/tokens.js';
import { toAuthUser, type UserDocument } from '../auth/user-store.js';
import type { AccessClaims } from '../auth/tokens.js';

/**
 * Rotas de autenticação (spec §7 — Auth).
 *
 * Stateless: access (15m) + refresh (7d), ambos JWT, retornados no corpo.
 * Logout não invalida nada no servidor (cliente descarta os tokens); denylist
 * de refresh fica para a Fase 5.
 */
export const authRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /auth/login — email + senha → par de tokens + dados do usuário.
   *
   * Login é PRÉ-contexto de tenant: lookup GLOBAL por email (não via
   * TenantRepository). Qualquer falha (email inexistente, senha errada, conta
   * inativa, email ambíguo entre empresas) resulta no MESMO 401 genérico — não
   * revelamos qual campo falhou (evita enumeração de emails).
   */
  app.post('/auth/login', async (request, reply) => {
    const { email, password } = LoginRequestSchema.parse(request.body);

    const candidates = await app.users.findByEmail(email);

    // Edge case: índice único é (tenantId, email), então o mesmo email PODE
    // existir em empresas diferentes. No MVP o login não recebe a empresa, logo
    // não há como desambiguar com segurança → tratamos colisão como 401
    // genérico (mesma resposta de "não existe"), e logamos como risco conhecido.
    if (candidates.length > 1) {
      request.log.warn(
        { email, matches: candidates.length },
        'login: email ambíguo entre empresas — rejeitado (ver risco documentado)'
      );
      throw new UnauthorizedError();
    }

    const user = candidates[0];
    if (!user || !user.active) {
      // Mesmo 401 para email inexistente e conta inativa. Ainda assim gastamos
      // o tempo de uma verificação de hash para reduzir o sinal de timing entre
      // "email não existe" e "senha errada".
      await verifyPassword(DUMMY_HASH, password);
      throw new UnauthorizedError();
    }

    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) {
      throw new UnauthorizedError();
    }

    const claims = toAccessClaims(user);
    const pair = app.tokens.issuePair(claims);

    await recordLogin(app, request, user);

    const body: LoginResponse = {
      ...pair,
      user: toAuthUser(user),
    };
    return reply.status(200).send(body);
  });

  /**
   * POST /auth/refresh — refresh token válido → novo par.
   *
   * Re-busca o usuário no banco para refletir role/tenant/active ATUAIS: quem
   * foi desativado após receber o refresh não consegue renovar.
   */
  app.post('/auth/refresh', async (request, reply) => {
    const { refreshToken } = RefreshRequestSchema.parse(request.body);

    let sub: string;
    try {
      sub = app.tokens.verifyRefreshToken(refreshToken).sub;
    } catch (error) {
      if (error instanceof InvalidTokenError) {
        throw new UnauthorizedError('Refresh token inválido');
      }
      throw error;
    }

    const user = await app.users.findActiveById(sub);
    if (!user) {
      throw new UnauthorizedError('Refresh token inválido');
    }

    const pair = app.tokens.issuePair(toAccessClaims(user));
    return reply.status(200).send(pair);
  });

  /**
   * POST /auth/logout — stateless. Sempre 200; o cliente descarta os tokens.
   */
  app.post('/auth/logout', async (_request, reply) => {
    return reply.status(200).send({ ok: true });
  });

  /**
   * GET /auth/me — exige access token válido. Retorna o usuário ATUAL (re-lido
   * do banco), sem passwordHash.
   */
  app.get('/auth/me', { preHandler: app.authenticate }, async (request, reply) => {
    // `authenticate` garante `request.user`.
    const sub = request.user?.sub;
    if (sub === undefined) {
      throw new UnauthorizedError();
    }

    const user = await app.users.findActiveById(sub);
    if (!user) {
      // Token válido mas usuário sumiu/foi desativado.
      throw new UnauthorizedError();
    }

    const body: AuthUser = toAuthUser(user);
    return reply.status(200).send(body);
  });
};

/**
 * Hash argon2 fixo de uma senha arbitrária, usado só para equalizar o tempo de
 * resposta quando o email não existe (defesa contra timing/enumeração).
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHR2YWx1ZXg$3hHbY0m0gj0H8oQ3xq0sN3w2k5y6Qp9Lq1Z8t7vWxYk';

function toAccessClaims(user: UserDocument): AccessClaims {
  return {
    sub: user.id,
    tenantId: user.tenantId,
    role: user.role,
  };
}

/**
 * Registra o AuditLog de login (spec §10, invariante 7). Falha de auditoria não
 * derruba o login — é apenas logada.
 */
async function recordLogin(
  app: FastifyInstance,
  request: FastifyRequest,
  user: UserDocument
): Promise<void> {
  try {
    await app.audit.record({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'auth.login',
      resource: `users/${user.id}`,
      metadata: {},
    });
  } catch (error) {
    request.log.warn({ err: error, userId: user.id }, 'falha ao registrar audit log de login');
  }
}
