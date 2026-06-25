import type { FastifyRequest } from 'fastify';
import { ForbiddenError } from '../errors/index.js';
import { canManageRole, type Role } from '@dmdoc/shared-types';

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

/**
 * Guard de HIERARQUIA: garante que o solicitante (role do JWT) tenha nível
 * suficiente para gerir um usuário do papel `targetRole`, segundo a regra
 * "inferior ou igual" (`canManageRole`): só pode gerir quem está no mesmo nível
 * ou abaixo. NUNCA acima.
 *
 * É uma checagem ADICIONAL em cima do gate base de `requireRole(...ADMIN_ROLES)`:
 * primeiro garante-se que o solicitante é admin; depois, que o nível dele cobre
 * o papel-alvo. Falha de hierarquia é 403 (ForbiddenError) — não é cross-tenant.
 *
 * Deve rodar APÓS `authenticate` (request.user populado).
 */
export function requireCanManageRole(request: FastifyRequest, targetRole: Role): void {
  const role = request.user?.role;
  if (!role) {
    throw new ForbiddenError();
  }
  if (!canManageRole(role, targetRole)) {
    throw new ForbiddenError(
      `Permissão insuficiente: ${role} não pode gerir usuários de papel ${targetRole}`,
    );
  }
}
