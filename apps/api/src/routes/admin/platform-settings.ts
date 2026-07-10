import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../../auth/role-guard.js';
import { AuditLogger } from '../../auth/audit.js';

const PatchPlatformSettingsBodySchema = z.object({
  aiClassificationEnabled: z.boolean().optional(),
  aiTitleSuggestionEnabled: z.boolean().optional(),
  aiIndexSuggestionEnabled: z.boolean().optional(),
});

type PlatformSettingsRow = {
  id: string;
  ai_classification_enabled: boolean;
  ai_title_suggestion_enabled: boolean;
  ai_index_suggestion_enabled: boolean;
  updated_at: Date;
};

function toResponse(r: PlatformSettingsRow) {
  return {
    id: r.id,
    aiClassificationEnabled: r.ai_classification_enabled,
    aiTitleSuggestionEnabled: r.ai_title_suggestion_enabled,
    aiIndexSuggestionEnabled: r.ai_index_suggestion_enabled,
    updatedAt: r.updated_at,
  };
}

/**
 * Rotas de configuração global de plataforma. Apenas SUPER_ADMIN acessa.
 *
 * `platform_settings` é um registro SINGLETON (linha única garantida por
 * índice único parcial no banco — ver migration 0004_ai_feature_flags.sql).
 * A linha é semeada pela própria migration; estas rotas nunca fazem INSERT.
 *
 * Funciona como um kill switch global das 3 features de IA de sugestão
 * (classificação de tipo, título sugerido, sugestão de índices — Fases
 * 7/8/8.1): o valor efetivo de cada feature para um tenant é
 * `platform_settings.<feature> AND tenants.<feature>` (ver
 * `PATCH /tenant/ai-settings`, controlado pelo TENANT_ADMIN de cada empresa).
 */
export const adminPlatformSettingsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /admin/platform-settings — retorna o singleton de configuração global.
   */
  app.get('/admin/platform-settings', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'SUPER_ADMIN');

    const sql = app.db;
    const rows = await sql<PlatformSettingsRow[]>`
      SELECT id, ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled, updated_at
      FROM platform_settings
      LIMIT 1
    `;

    // A linha singleton é semeada pela migration — nunca deveria faltar, mas
    // não escondemos o problema silenciosamente caso o seed não tenha rodado.
    const row = rows[0];
    if (!row) {
      throw new Error('platform_settings singleton ausente — migration 0004 não aplicada?');
    }

    return reply.status(200).send(toResponse(row));
  });

  /**
   * PATCH /admin/platform-settings — atualiza subconjunto das 3 flags do
   * singleton. Sem `:id` na rota — sempre opera sobre a única linha existente.
   */
  app.patch('/admin/platform-settings', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'SUPER_ADMIN');

    const updates = PatchPlatformSettingsBodySchema.parse(request.body);
    const sql = app.db;

    if (Object.keys(updates).length === 0) {
      const rows = await sql<PlatformSettingsRow[]>`
        SELECT id, ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled, updated_at
        FROM platform_settings
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) {
        throw new Error('platform_settings singleton ausente — migration 0004 não aplicada?');
      }
      return reply.status(200).send(toResponse(row));
    }

    // Captura o estado ANTES da atualização — necessário para o AuditLog
    // (registra valores antes/depois de cada flag alterada).
    const beforeRows = await sql<PlatformSettingsRow[]>`
      SELECT id, ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled, updated_at
      FROM platform_settings
      LIMIT 1
    `;
    const before = beforeRows[0];
    if (!before) {
      throw new Error('platform_settings singleton ausente — migration 0004 não aplicada?');
    }

    // Monta SET dinâmico apenas com os campos fornecidos (mesmo padrão de
    // PATCH /admin/tenants/:id).
    const setParts: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

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
    setParts.push('updated_at = now()');

    // Sem WHERE por id — a tabela tem uma única linha (invariante garantido
    // pelo índice único parcial da migration).
    const query = `
      UPDATE platform_settings
      SET ${setParts.join(', ')}
      RETURNING id, ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled, updated_at
    `;

    const rows = await sql.unsafe<PlatformSettingsRow[]>(query, values as Parameters<typeof sql.unsafe>[1]);
    const row = rows[0];
    if (!row) {
      throw new Error('platform_settings singleton ausente — migration 0004 não aplicada?');
    }

    // AuditLog — kill switch global de plataforma. Registra o ator (userId +
    // role), a linha continua sem tenantId (configuração global), e o diff
    // antes/depois apenas dos campos efetivamente informados no PATCH.
    // Ver spec §10, invariante 7 (Fase 6.9).
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
        tenantId: null,
        userId: request.user?.sub ?? null,
        action: 'platform_settings.update',
        resource: 'platform_settings',
        metadata: { actorRole: request.user?.role ?? null, changes },
      });
    } catch (auditError) {
      request.log.error(
        { err: auditError, userId: request.user?.sub ?? null },
        'falha ao registrar audit log de atualização de platform_settings',
      );
    }

    request.log.info({ updates }, 'platform settings atualizadas');
    return reply.status(200).send(toResponse(row));
  });
};
