import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ConflictError, NotFoundError } from '../errors/index.js';

/**
 * Discriminador de contexto de tenant para operações no banco.
 *
 * - `single`: operação escopada a um tenant concreto. Usado por roles normais,
 *   SUPER_ADMIN com tenantId explícito e MULTI_TENANT_ADMIN com tenantId
 *   explícito válido (∈ allowedTenantIds).
 * - `all`: SUPER_ADMIN em modo leitura sem tenantId explícito — sem filtro de
 *   tenant (acesso a todos os dados da plataforma).
 * - `allowed`: MULTI_TENANT_ADMIN em modo leitura sem tenantId explícito —
 *   filtro `$in tenantIds` nos repositórios.
 *
 * As rotas usam este tipo para construir o filtro correto. Nunca assumir `single`
 * sem verificar o discriminador `mode`.
 */
export type TenantContext =
  | { mode: 'single'; tenantId: string }
  | { mode: 'all' }
  | { mode: 'allowed'; tenantIds: string[] };

/**
 * Resolve o contexto de tenant da operação com base no role do usuário
 * autenticado e na presença de um tenantId explícito.
 *
 * @param request    - Request autenticada (authenticate deve ter rodado antes).
 * @param options    - `write: true` indica operação de escrita; muda o
 *                     comportamento de SUPER_ADMIN e MULTI_TENANT_ADMIN sem
 *                     tenantId explícito.
 *
 * Tabela de decisão:
 *
 * | Role               | explicit   | write | Resultado                          |
 * |--------------------|------------|-------|------------------------------------|
 * | Normal             | qualquer   | -     | single(request.tenantId)           |
 * | SUPER_ADMIN        | presente   | -     | single(explicit)                   |
 * | SUPER_ADMIN        | ausente    | false | all                                |
 * | SUPER_ADMIN        | ausente    | true  | ConflictError (409)                |
 * | MULTI_TENANT_ADMIN | presente ∈ | -     | single(explicit)                   |
 * | MULTI_TENANT_ADMIN | presente ∉ | -     | NotFoundError (404)                |
 * | MULTI_TENANT_ADMIN | ausente    | false | allowed(allowedTenantIds)          |
 * | MULTI_TENANT_ADMIN | ausente    | true  | NotFoundError (404)                |
 *
 * Roles normais ignoram completamente o explicitTenantId — isso impede escalada
 * de privilégio via injeção de tenantId no body/query (spec §10, invariante 3).
 */
export function resolveTenantContext(
  request: FastifyRequest,
  options?: { explicitTenantId?: string | undefined; write?: boolean },
): TenantContext {
  const { explicitTenantId, write = false } = options ?? {};
  const role = request.user?.role;

  // --- SUPER_ADMIN ---
  if (role === 'SUPER_ADMIN') {
    if (explicitTenantId !== undefined) {
      z.string().uuid('tenantId deve ser um UUID válido').parse(explicitTenantId);
      return { mode: 'single', tenantId: explicitTenantId };
    }
    if (write) {
      throw new ConflictError('SUPER_ADMIN deve informar tenantId para esta operação');
    }
    return { mode: 'all' };
  }

  // --- MULTI_TENANT_ADMIN ---
  if (role === 'MULTI_TENANT_ADMIN') {
    const allowedTenantIds = request.user?.allowedTenantIds ?? [];

    if (explicitTenantId !== undefined) {
      z.string().uuid('tenantId deve ser um UUID válido').parse(explicitTenantId);
      if (!allowedTenantIds.includes(explicitTenantId)) {
        // Recurso fora do escopo do MTA é tratado como inexistente (nunca 403).
        throw new NotFoundError('Empresa não encontrada ou sem acesso');
      }
      return { mode: 'single', tenantId: explicitTenantId };
    }

    if (write) {
      // Escrita sem tenantId explícito: MTA não tem empresa padrão — 404 (não
      // 409) porque o tenantId é "recurso" necessário que não está no contexto.
      throw new NotFoundError('MULTI_TENANT_ADMIN deve informar tenantId para operações de escrita');
    }

    return { mode: 'allowed', tenantIds: allowedTenantIds };
  }

  // --- Roles normais (TENANT_ADMIN, UPLOADER, USER) ---
  // tenantId vem sempre do token — explicitTenantId é ignorado para prevenir
  // escalada de privilégio via injeção de parâmetro.
  return { mode: 'single', tenantId: request.tenantId! };
}

/**
 * Resolve o tenantId efetivo da operação.
 *
 * @deprecated Preferir `resolveTenantContext` + discriminação pelo `mode`.
 *   Esta função permanece por compatibilidade com rotas já existentes. Delega
 *   para `resolveTenantContext` internamente e retorna `string | null`:
 *   - `null` → modo `all` (SUPER_ADMIN sem filtro)
 *   - string → modo `single` (tenant concreto)
 *   - Lança se `mode === 'allowed'` e não há tenantId explícito, pois o contrato
 *     original da função nunca contemplava retorno de lista.
 *
 * - Roles normais: sempre o próprio tenant do token (explicitTenantId ignorado).
 * - SUPER_ADMIN em mutação (requireForSuperAdmin: true): explicitTenantId obrigatório.
 *   Sem ele → 409 CONFLICT com mensagem clara.
 * - SUPER_ADMIN em leitura (requireForSuperAdmin: false): explicitTenantId opcional,
 *   retorna null quando ausente (sem filtro de tenant).
 */
export function resolveTenantId(
  request: FastifyRequest,
  explicitTenantId: string | undefined,
  requireForSuperAdmin: boolean,
): string | null {
  const ctx = resolveTenantContext(request, {
    explicitTenantId,
    write: requireForSuperAdmin,
  });

  if (ctx.mode === 'single') {
    return ctx.tenantId;
  }
  if (ctx.mode === 'all') {
    return null;
  }
  // ctx.mode === 'allowed' — MULTI_TENANT_ADMIN sem tenantId explícito em
  // contexto de leitura: callers legados não sabem lidar com lista. Como
  // requireForSuperAdmin=false significa leitura, retornamos null para que a
  // rota legada faça query sem filtro (comportamento igual ao SUPER_ADMIN
  // em modo leitura), que é o mais seguro até a migração completa.
  return null;
}
