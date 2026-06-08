import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ConflictError } from '../errors/index.js';

/**
 * Resolve o tenantId efetivo da operação.
 *
 * - Roles normais: sempre o próprio tenant do token (explicitTenantId ignorado).
 * - SUPER_ADMIN em mutação (requireForSuperAdmin: true): explicitTenantId obrigatório.
 *   Sem ele → 409 CONFLICT com mensagem clara.
 * - SUPER_ADMIN em leitura (requireForSuperAdmin: false): explicitTenantId opcional,
 *   retorna null quando ausente (sem filtro de tenant).
 *
 * Invariante: roles não-SA ignoram completamente o explicitTenantId passado —
 * o tenantId do token é sempre usado. Isso impede escalada de privilégio via
 * injeção de tenantId no body/query.
 */
export function resolveTenantId(
  request: FastifyRequest,
  explicitTenantId: string | undefined,
  requireForSuperAdmin: boolean,
): string | null {
  if (request.user?.role !== 'SUPER_ADMIN') {
    return request.tenantId!;
  }

  if (explicitTenantId !== undefined) {
    z.string().uuid('tenantId deve ser um UUID válido').parse(explicitTenantId);
    return explicitTenantId;
  }

  if (requireForSuperAdmin) {
    throw new ConflictError('SUPER_ADMIN deve informar tenantId para esta operação');
  }

  // SUPER_ADMIN sem filtro — retorna null (sem filtro de tenant)
  return null;
}
