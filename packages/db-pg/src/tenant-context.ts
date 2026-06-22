/**
 * Contexto de tenant de uma operação de banco — PostgreSQL.
 *
 * Espelha exatamente packages/db-mongo/src/tenant-context.ts: mesma semântica,
 * sem dependência cruzada entre os dois pacotes.
 *
 * - `{ tenantId }`: operação normal, escopada a uma empresa. Todo recurso
 *   lido ou escrito recebe esse `tenantId` automaticamente (ver TenantRepository).
 * - `null`: modo SUPER_ADMIN, sem empresa fixa. Nesse modo o TenantRepository
 *   recusa-se a operar sem um `tenantId` EXPLÍCITO — o SUPER_ADMIN precisa
 *   selecionar a empresa-alvo via `forTenant(tenantId)` (spec §10, invariante 3).
 *   Garante que acesso cross-empresa seja sempre intencional, nunca implícito.
 */
export interface TenantContext {
  tenantId: string;
}

/**
 * Contexto efetivo aceito pelo TenantRepository: empresa fixa ou `null`
 * (SUPER_ADMIN sem empresa, que deve escopar explicitamente por chamada).
 */
export type RepositoryContext = TenantContext | null;

/**
 * Type guard: distingue um contexto escopado a empresa de SUPER_ADMIN.
 */
export function hasTenant(context: RepositoryContext): context is TenantContext {
  return context !== null;
}

/**
 * Invariante de escopo de usuário — re-exportado para consumidores que precisam
 * verificar o contexto antes de construir um repositório.
 */
export type UserScopeInvariant = TenantContext;
