import type { FastifyRequest } from 'fastify';
import { ForbiddenError } from '../errors/index.js';
import type { Role } from '@dmdoc/shared-types';

/**
 * Guard de role inline para rotas protegidas.
 *
 * Lança `ForbiddenError` (403) se o usuário autenticado não tiver uma das
 * roles exigidas. Deve ser chamado APÓS o preHandler `authenticate` (que
 * popula `request.user`).
 *
 * SUPER_ADMIN é sempre permitido — ele pode operar em qualquer tenant via
 * `tenantId` explícito (query param ou body). Cross-tenant é 404
 * (TenantRepository garante), role inadequada é 403.
 *
 * MULTI_TENANT_ADMIN (MTA) NÃO recebe passe-livre automático: ele passa
 * apenas quando listado explicitamente em `roles`. Isso garante que rotas
 * que não foram adaptadas para MTA (ex.: rotas de escrita que ainda usam
 * `resolveTenantId` legado) não sejam acessadas inadvertidamente pelo MTA
 * antes da migração completa para `resolveTenantContext`.
 */
export function requireRole(request: FastifyRequest, ...roles: Role[]): void {
  const role = request.user?.role;
  if (!role) {
    throw new ForbiddenError();
  }
  // SUPER_ADMIN tem acesso irrestrito a todas as rotas que usam requireRole.
  // MULTI_TENANT_ADMIN precisa ser listado explicitamente.
  if (role === 'SUPER_ADMIN') {
    return;
  }
  if (!roles.includes(role)) {
    throw new ForbiddenError();
  }
}
