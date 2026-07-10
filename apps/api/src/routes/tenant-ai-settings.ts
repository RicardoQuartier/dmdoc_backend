import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/role-guard.js';
import { resolveTenantContext } from '../auth/resolve-tenant.js';
import { AuditLogger } from '../auth/audit.js';
import { NotFoundError } from '../errors/index.js';
import { resolveAiFeatureFlags, type Sql } from '@dmdoc/db-pg';

const PatchAiSettingsBodySchema = z.object({
  aiClassificationEnabled: z.boolean().optional(),
  aiTitleSuggestionEnabled: z.boolean().optional(),
  aiIndexSuggestionEnabled: z.boolean().optional(),
});

type TenantAiSettingsRow = {
  ai_classification_enabled: boolean;
  ai_title_suggestion_enabled: boolean;
  ai_index_suggestion_enabled: boolean;
};

/**
 * Monta a resposta incluindo, além das flags próprias do tenant (editáveis
 * via PATCH), o bloco `effective` — o valor combinado
 * `platform_settings.<feature> AND tenants.<feature>` calculado por
 * `resolveAiFeatureFlags` (ver `packages/db-pg/src/ai-feature-flags.ts`).
 * `effective` é somente leitura: nunca é aceito no PATCH desta rota, apenas
 * informa ao TENANT_ADMIN quando seu próprio toggle está ligado mas
 * inefetivo porque o SUPER_ADMIN desligou a feature no nível de plataforma.
 */
async function toResponse(sql: Sql, tenantId: string, r: TenantAiSettingsRow) {
  const effective = await resolveAiFeatureFlags(sql, tenantId);
  return {
    tenantId,
    aiClassificationEnabled: r.ai_classification_enabled,
    aiTitleSuggestionEnabled: r.ai_title_suggestion_enabled,
    aiIndexSuggestionEnabled: r.ai_index_suggestion_enabled,
    effective: {
      classificationEnabled: effective.classificationEnabled,
      titleSuggestionEnabled: effective.titleSuggestionEnabled,
      indexSuggestionEnabled: effective.indexSuggestionEnabled,
    },
  };
}

/**
 * Rotas de configuração de IA por empresa — Fase 6.9, entregável 69.
 *
 * Diferente de `/admin/platform-settings` (SUPER_ADMIN, kill switch global),
 * estas rotas são geridas pelo TENANT_ADMIN e operam sempre sobre o próprio
 * tenant do usuário autenticado — não existe parâmetro de tenantId na rota,
 * o que torna cross-tenant estruturalmente impossível aqui (nunca lemos
 * tenantId de query/body, só do JWT via `resolveTenantContext`).
 *
 * O valor efetivo de cada feature para o tenant é
 * `platform_settings.<feature> AND tenants.<feature>` — ver
 * `PATCH /admin/platform-settings`.
 */
export const tenantAiSettingsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /tenant/ai-settings — retorna as 3 flags do tenant autenticado.
   */
  app.get('/tenant/ai-settings', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN');

    const ctx = resolveTenantContext(request);
    if (ctx.mode !== 'single') {
      throw new NotFoundError('tenantId é obrigatório para esta operação');
    }
    const tenantId = ctx.tenantId;
    const sql = app.db;

    const rows = await sql<TenantAiSettingsRow[]>`
      SELECT ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled
      FROM tenants
      WHERE id = ${tenantId} AND deleted = false
      LIMIT 1
    `;

    const row = rows[0];
    if (!row) {
      throw new NotFoundError('Tenant não encontrado');
    }

    return reply.status(200).send(await toResponse(sql, tenantId, row));
  });

  /**
   * PATCH /tenant/ai-settings — atualiza subconjunto das 3 flags do próprio
   * tenant do usuário autenticado.
   */
  app.patch('/tenant/ai-settings', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN');

    const updates = PatchAiSettingsBodySchema.parse(request.body);

    const ctx = resolveTenantContext(request, { write: true });
    if (ctx.mode !== 'single') {
      throw new NotFoundError('tenantId é obrigatório para esta operação');
    }
    const tenantId = ctx.tenantId;
    const sql = app.db;

    if (Object.keys(updates).length === 0) {
      const rows = await sql<TenantAiSettingsRow[]>`
        SELECT ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled
        FROM tenants
        WHERE id = ${tenantId} AND deleted = false
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) {
        throw new NotFoundError('Tenant não encontrado');
      }
      return reply.status(200).send(await toResponse(sql, tenantId, row));
    }

    // Captura o estado ANTES da atualização — necessário para o AuditLog
    // (registra valores antes/depois de cada flag alterada).
    const beforeRows = await sql<TenantAiSettingsRow[]>`
      SELECT ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled
      FROM tenants
      WHERE id = ${tenantId} AND deleted = false
      LIMIT 1
    `;
    const before = beforeRows[0];
    if (!before) {
      throw new NotFoundError('Tenant não encontrado');
    }

    // Monta SET dinâmico apenas com os campos fornecidos (mesmo padrão de
    // PATCH /admin/tenants/:id), sempre escopado por WHERE id = tenantId do JWT.
    const setParts: string[] = [];
    const values: unknown[] = [tenantId];
    let paramIdx = 2;

    if (updates.aiClassificationEnabled !== undefined) {
      setParts.push(`ai_classification_enabled = $${paramIdx++}`);
      values.push(updates.aiClassificationEnabled);
    }
    if (updates.aiTitleSuggestionEnabled !== undefined) {
      setParts.push(`ai_title_suggestion_enabled = $${paramIdx++}`);
      values.push(updates.aiTitleSuggestionEnabled);
    }
    if (updates.aiIndexSuggestionEnabled !== undefined) {
      setParts.push(`ai_index_suggestion_enabled = $${paramIdx++}`);
      values.push(updates.aiIndexSuggestionEnabled);
    }

    const query = `
      UPDATE tenants
      SET ${setParts.join(', ')}
      WHERE id = $1 AND deleted = false
      RETURNING ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled
    `;

    const rows = await sql.unsafe<TenantAiSettingsRow[]>(query, values as Parameters<typeof sql.unsafe>[1]);
    const row = rows[0];
    if (!row) {
      throw new NotFoundError('Tenant não encontrado');
    }

    // AuditLog — mudança de configuração de IA da própria empresa. Registra o
    // ator (userId + role), o tenant afetado, e o diff antes/depois apenas dos
    // campos efetivamente informados no PATCH. Ver spec §10, invariante 7
    // (Fase 6.9).
    const changes: Record<string, { before: boolean; after: boolean }> = {};
    if (updates.aiClassificationEnabled !== undefined) {
      changes['aiClassificationEnabled'] = {
        before: before.ai_classification_enabled,
        after: row.ai_classification_enabled,
      };
    }
    if (updates.aiTitleSuggestionEnabled !== undefined) {
      changes['aiTitleSuggestionEnabled'] = {
        before: before.ai_title_suggestion_enabled,
        after: row.ai_title_suggestion_enabled,
      };
    }
    if (updates.aiIndexSuggestionEnabled !== undefined) {
      changes['aiIndexSuggestionEnabled'] = {
        before: before.ai_index_suggestion_enabled,
        after: row.ai_index_suggestion_enabled,
      };
    }

    const auditLogger = new AuditLogger(sql);
    try {
      await auditLogger.record({
        tenantId,
        userId: request.user?.sub ?? null,
        action: 'tenant.ai_settings.update',
        resource: `tenants/${tenantId}`,
        metadata: { actorRole: request.user?.role ?? null, changes },
      });
    } catch (auditError) {
      request.log.error(
        { err: auditError, tenantId, userId: request.user?.sub ?? null },
        'falha ao registrar audit log de atualização de configuração de IA do tenant',
      );
    }

    request.log.info({ tenantId, updates }, 'configuração de IA do tenant atualizada');
    return reply.status(200).send(await toResponse(sql, tenantId, row));
  });
};
