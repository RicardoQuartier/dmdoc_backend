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
 */
export function requireRole(request: FastifyRequest, ...roles: Role[]): void {
  const role = request.user?.role;
  if (!role) {
    throw new ForbiddenError();
  }
  // SUPER_ADMIN tem acesso irrestrito a todas as rotas que usam requireRole
  if (role === 'SUPER_ADMIN') {
    return;
  }
  if (!roles.includes(role)) {
    throw new ForbiddenError();
  }
}
