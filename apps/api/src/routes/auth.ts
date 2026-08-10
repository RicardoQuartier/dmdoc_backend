import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  LoginRequestSchema,
  RefreshRequestSchema,
  type LoginResponse,
  type AllowedTenantSummary,
} from '@dmdoc/shared-types';
import { ConflictError, UnauthorizedError, ValidationError } from '../errors/index.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { InvalidTokenError } from '../auth/tokens.js';
import { toAuthUser, type UserDocument } from '../auth/user-store.js';
import type { AccessClaims } from '../auth/tokens.js';

/**
 * `PATCH /auth/me`: nome sempre pode ser trocado sem senha; trocar o e-mail
 * exige confirmar a senha atual (decisão de produto — evita que uma sessão
 * sequestrada troque o e-mail de recuperação sem reconfirmar credencial).
 */
const UpdateMeBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    email: z.string().email().optional(),
    currentPassword: z.string().optional(),
  })
  .strict()
  .refine((b) => b.email === undefined || (b.currentPassword?.length ?? 0) > 0, {
    message: 'Senha atual é obrigatória para trocar o e-mail',
    path: ['currentPassword'],
  });

const ChangeMyPasswordBodySchema = z
  .object({
    currentPassword: z.string(),
    newPassword: z.string().min(8),
  })
  .strict();

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

    // Para MULTI_TENANT_ADMIN: buscar nome dos tenants para evitar roundtrip
    // adicional no frontend (apresentação de seletor de contexto).
    let allowedTenants: AllowedTenantSummary[] | undefined;
    if (user.role === 'MULTI_TENANT_ADMIN' && (user.allowedTenantIds?.length ?? 0) > 0) {
      allowedTenants = await fetchAllowedTenants(app, user.allowedTenantIds ?? []);
    }

    const body: LoginResponse = {
      ...pair,
      user: toAuthUser(user),
      ...(allowedTenants !== undefined ? { allowedTenants } : {}),
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
   *
   * Para MULTI_TENANT_ADMIN inclui `allowedTenants` com id+nome de cada empresa.
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

    let allowedTenants: AllowedTenantSummary[] | undefined;
    if (user.role === 'MULTI_TENANT_ADMIN' && (user.allowedTenantIds?.length ?? 0) > 0) {
      allowedTenants = await fetchAllowedTenants(app, user.allowedTenantIds ?? []);
    }

    const body = {
      ...toAuthUser(user),
      ...(allowedTenants !== undefined ? { allowedTenants } : {}),
    };
    return reply.status(200).send(body);
  });

  /**
   * PATCH /auth/me — self-service: o próprio usuário edita nome e/ou e-mail.
   *
   * Sem `requireRole`: qualquer papel autenticado edita a si mesmo (o alvo é
   * sempre `request.user.sub`, nunca um `:id` de terceiro — isolamento
   * multi-tenant é automático). Trocar e-mail exige `currentPassword`; trocar
   * só o nome não exige (regra de produto confirmada com o Owner).
   */
  app.patch('/auth/me', { preHandler: app.authenticate }, async (request, reply) => {
    const sub = request.user?.sub;
    if (sub === undefined) {
      throw new UnauthorizedError();
    }

    const body = UpdateMeBodySchema.parse(request.body);

    const user = await app.users.findActiveById(sub);
    if (!user) {
      throw new UnauthorizedError();
    }

    if (body.email !== undefined) {
      const ok = await verifyPassword(user.passwordHash, body.currentPassword ?? '');
      if (!ok) {
        throw new ValidationError('Senha atual incorreta');
      }
    }

    const changedFields: string[] = [];
    if (body.name !== undefined && body.name !== user.name) changedFields.push('name');
    if (body.email !== undefined && body.email !== user.email) changedFields.push('email');

    // Nada mudou de fato (ex.: PATCH com o mesmo nome já cadastrado) — não bate
    // no banco, apenas devolve o estado atual no mesmo formato do GET /auth/me.
    if (changedFields.length === 0) {
      return reply.status(200).send(toAuthUser(user));
    }

    let updatedRows: Array<{
      id: string;
      tenant_id: string | null;
      email: string;
      password_hash: string;
      name: string;
      role: string;
      active: boolean;
      created_at: Date;
      allowed_tenant_ids: string[] | null;
    }>;
    try {
      updatedRows = await app.db`
        UPDATE users
        SET name  = ${body.name ?? user.name},
            email = ${body.email ?? user.email}
        WHERE id = ${sub}
          AND deleted = false
        RETURNING id, tenant_id, email, password_hash, name, role, active, created_at, allowed_tenant_ids
      `;
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        throw new ConflictError('E-mail já em uso');
      }
      throw err;
    }

    const row = updatedRows[0];
    if (!row) {
      throw new UnauthorizedError();
    }

    const updatedUser: UserDocument = {
      id: row.id,
      tenantId: row.tenant_id,
      email: row.email,
      passwordHash: row.password_hash,
      name: row.name,
      role: row.role as UserDocument['role'],
      active: row.active,
      createdAt: row.created_at,
      ...(row.allowed_tenant_ids !== null && row.allowed_tenant_ids.length > 0
        ? { allowedTenantIds: row.allowed_tenant_ids }
        : {}),
    };

    await recordProfileUpdate(app, request, updatedUser, changedFields);

    return reply.status(200).send(toAuthUser(updatedUser));
  });

  /**
   * POST /auth/me/password — self-service: o próprio usuário troca a própria
   * senha (diferente de `POST /users/:id/reset-password`, que é ação de
   * administrador sobre terceiro — nome de auditoria distinto).
   */
  app.post('/auth/me/password', { preHandler: app.authenticate }, async (request, reply) => {
    const sub = request.user?.sub;
    if (sub === undefined) {
      throw new UnauthorizedError();
    }

    const { currentPassword, newPassword } = ChangeMyPasswordBodySchema.parse(request.body);

    const user = await app.users.findActiveById(sub);
    if (!user) {
      throw new UnauthorizedError();
    }

    const ok = await verifyPassword(user.passwordHash, currentPassword);
    if (!ok) {
      throw new ValidationError('Senha atual incorreta');
    }

    const passwordHash = await hashPassword(newPassword);
    await app.db`
      UPDATE users
      SET password_hash = ${passwordHash}
      WHERE id = ${sub}
        AND deleted = false
    `;

    await recordPasswordChange(app, request, user);

    return reply.status(204).send();
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
    allowedTenantIds: user.allowedTenantIds ?? [],
  };
}

/**
 * Busca nome + id dos tenants da lista do MULTI_TENANT_ADMIN para compor o
 * `allowedTenants` da resposta de login/me. Tenants inexistentes ou inativos
 * são simplesmente omitidos — não é erro (o admin pode ter desativado um tenant
 * sem atualizar a lista do MTA).
 */
async function fetchAllowedTenants(
  app: FastifyInstance,
  tenantIds: string[],
): Promise<AllowedTenantSummary[]> {
  const docs = await app.db<Array<{ id: string; name: string }>>`
    SELECT id, name
    FROM tenants
    WHERE id = ANY(${tenantIds}::uuid[])
      AND active = true
  `;
  return docs.map((d) => ({ id: d.id, name: d.name }));
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

/**
 * Registra o AuditLog de edição de perfil self-service (nome/e-mail). Falha de
 * auditoria não derruba a operação — é apenas logada. Nunca inclui valores de
 * senha no metadata, só os NOMES dos campos alterados.
 */
async function recordProfileUpdate(
  app: FastifyInstance,
  request: FastifyRequest,
  user: UserDocument,
  changedFields: string[],
): Promise<void> {
  try {
    await app.audit.record({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'user.update_profile',
      resource: `users/${user.id}`,
      metadata: { fields: changedFields },
    });
  } catch (error) {
    request.log.error(
      { err: error, tenantId: user.tenantId, userId: user.id },
      'falha ao registrar audit log de atualização de perfil',
    );
  }
}

/**
 * Registra o AuditLog de troca da PRÓPRIA senha (`user.change_password`) —
 * ação distinta de `user.reset_password` (admin sobre terceiro). Nunca inclui
 * senha em texto puro no metadata.
 */
async function recordPasswordChange(
  app: FastifyInstance,
  request: FastifyRequest,
  user: UserDocument,
): Promise<void> {
  try {
    await app.audit.record({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'user.change_password',
      resource: `users/${user.id}`,
      metadata: {},
    });
  } catch (error) {
    request.log.error(
      { err: error, tenantId: user.tenantId, userId: user.id },
      'falha ao registrar audit log de troca de senha',
    );
  }
}
