import type { Sql } from 'postgres';

/**
 * Helper compartilhado (API + worker) para resolver o valor EFETIVO das 3
 * features de IA de sugestão (classificação de tipo, título sugerido,
 * sugestão de índices) para um tenant.
 *
 * Regra de negócio: "Controle de features de IA por plataforma e empresa"
 * (Fases 7/8/8.1) — existem dois níveis de controle, independentes:
 *
 * - `platform_settings` (singleton, SUPER_ADMIN): kill switch global.
 * - `tenants.<feature>` (por empresa, TENANT_ADMIN): toggle local.
 *
 * Valor efetivo = `platform_settings.<feature> AND tenants.<feature>` — se
 * qualquer um dos dois níveis estiver desligado, a feature está desligada
 * para aquele tenant.
 *
 * Ver migration `0004_ai_feature_flags.sql` e `schema.ts` (`platformSettings`,
 * `tenants`).
 */

/**
 * Valor efetivo (já combinado) das 3 features de IA de sugestão para um
 * tenant específico.
 */
export interface AiFeatureFlags {
  classificationEnabled: boolean;
  titleSuggestionEnabled: boolean;
  indexSuggestionEnabled: boolean;
  /** Geração automática de tags por documento (Fase 9 / E-3). */
  tagGenerationEnabled: boolean;
}

/**
 * Erro lançado quando o `tenantId` informado não corresponde a nenhuma
 * empresa ativa (inexistente ou excluída logicamente). Segue o mesmo padrão
 * de erro tipado local usado no pacote (ver `UserScopeInvariantError` em
 * `user-write-validation.ts`) — o pacote `db-pg` não depende dos erros HTTP
 * de `apps/api` (que mapeiam este erro para 404 no error handler central).
 */
export class TenantNotFoundError extends Error {
  constructor(tenantId: string) {
    super(`Tenant não encontrado: ${tenantId}`);
    this.name = 'TenantNotFoundError';
  }
}

/**
 * Linha crua retornada pela query combinada (join de `platform_settings` com
 * `tenants`). Nomes de coluna em snake_case, como devolvidos pelo postgres.js
 * (cliente sem `transform.column`).
 */
interface AiFeatureFlagsRow {
  platform_classification_enabled: boolean;
  platform_title_suggestion_enabled: boolean;
  platform_index_suggestion_enabled: boolean;
  platform_tag_generation_enabled: boolean;
  tenant_classification_enabled: boolean;
  tenant_title_suggestion_enabled: boolean;
  tenant_index_suggestion_enabled: boolean;
  tenant_tag_generation_enabled: boolean;
}

/**
 * Resolve o valor efetivo das 3 features de IA de sugestão para um tenant.
 *
 * Lê a linha singleton de `platform_settings` e a linha de `tenants` do
 * `tenantId` informado numa única query (JOIN), evitando duas viagens ao
 * banco e N+1 caso a função seja chamada em lote no futuro.
 *
 * @param sql       Cliente postgres.js (pool de conexões).
 * @param tenantId  UUID da empresa a resolver.
 * @throws {TenantNotFoundError} se `tenantId` não existir ou estiver excluído
 *   logicamente (`deleted = true`) — nunca assume `false` silenciosamente.
 */
export async function resolveAiFeatureFlags(sql: Sql, tenantId: string): Promise<AiFeatureFlags> {
  const rows = await sql<AiFeatureFlagsRow[]>`
    SELECT
      ps.ai_classification_enabled   AS platform_classification_enabled,
      ps.ai_title_suggestion_enabled AS platform_title_suggestion_enabled,
      ps.ai_index_suggestion_enabled AS platform_index_suggestion_enabled,
      ps.ai_tag_generation_enabled   AS platform_tag_generation_enabled,
      t.ai_classification_enabled    AS tenant_classification_enabled,
      t.ai_title_suggestion_enabled  AS tenant_title_suggestion_enabled,
      t.ai_index_suggestion_enabled  AS tenant_index_suggestion_enabled,
      t.ai_tag_generation_enabled    AS tenant_tag_generation_enabled
    FROM platform_settings ps
    CROSS JOIN tenants t
    WHERE t.id = ${tenantId}
      AND t.deleted = false
    LIMIT 1
  `;

  const row = rows[0];
  if (row === undefined) {
    throw new TenantNotFoundError(tenantId);
  }

  return {
    classificationEnabled: row.platform_classification_enabled && row.tenant_classification_enabled,
    titleSuggestionEnabled: row.platform_title_suggestion_enabled && row.tenant_title_suggestion_enabled,
    indexSuggestionEnabled: row.platform_index_suggestion_enabled && row.tenant_index_suggestion_enabled,
    tagGenerationEnabled: row.platform_tag_generation_enabled && row.tenant_tag_generation_enabled,
  };
}
