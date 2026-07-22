import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { newId } from '@dmdoc/db-pg';
import { TenantDeletionJobDataSchema } from '@dmdoc/shared-types';
import { ConflictError, NotFoundError } from '../../errors/index.js';
import { requireRole } from '../../auth/role-guard.js';
import { AuditLogger } from '../../auth/audit.js';
import { applyTemplateToTenant } from '../../lib/apply-template-to-tenant.js';

const CreateTenantBodySchema = z.object({
  name: z.string().min(1).max(200),
  diskQuotaBytes: z.number().int().nonnegative().default(10 * 1024 ** 3),
  userQuota: z.number().int().nonnegative().default(20),
  /** UUID de um template de departamentos a aplicar ao novo tenant (opcional). */
  templateId: z.string().uuid().optional(),
});

const PatchTenantBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  diskQuotaBytes: z.number().int().nonnegative().optional(),
  userQuota: z.number().int().nonnegative().optional(),
  active: z.boolean().optional(),
  // Toggles por empresa das features de IA de sugestão (Fases 7/8/8.1) — plus
  // comercial gerido exclusivamente pelo SUPER_ADMIN, no mesmo fluxo de
  // edição de empresa usado para cotas. Ver `packages/shared-types/src/tenant.ts`.
  aiClassificationEnabled: z.boolean().optional(),
  aiTitleSuggestionEnabled: z.boolean().optional(),
  aiIndexSuggestionEnabled: z.boolean().optional(),
  aiTagGenerationEnabled: z.boolean().optional(),
});

const ListTenantsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(20),
  cursor: z.string().optional(),
});

/**
 * Rotas de administração de tenants. Apenas SUPER_ADMIN acessa.
 *
 * A tabela `tenants` não usa TenantRepository (não tem tenantId próprio nem
 * soft-delete). Operações via SQL direto.
 */
export const adminTenantsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /admin/tenants — cria nova empresa.
   *
   * `templateId` opcional: quando informado, os nós do template são inseridos
   * como departamentos reais do novo tenant dentro da mesma transação.
   * Se o templateId não existir, a transação inteira é revertida.
   */
  app.post('/admin/tenants', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'SUPER_ADMIN');

    const { name, diskQuotaBytes, userQuota, templateId } = CreateTenantBodySchema.parse(request.body);
    const sql = app.db;

    const tenantId = newId();
    const createdAt = new Date();

    await sql.begin(async (tx) => {
      try {
        await tx`
          INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
          VALUES (${tenantId}, ${name}, ${diskQuotaBytes}, ${userQuota}, true, ${createdAt})
        `;
      } catch (err: unknown) {
        const pgErr = err as { code?: string };
        if (pgErr.code === '23505') {
          throw new ConflictError('Nome de empresa já em uso');
        }
        throw err;
      }

      if (templateId !== undefined) {
        await applyTemplateToTenant(tx as unknown as typeof sql, tenantId, templateId, request.log);
      }
    });

    if (templateId !== undefined) {
      request.log.info({ tenantId, templateId }, 'tenant criado com template');
    } else {
      request.log.info({ tenantId }, 'tenant criado');
    }

    return reply.status(201).send({ id: tenantId, name, diskQuotaBytes, userQuota, active: true, createdAt });
  });

  /**
   * GET /admin/tenants — lista empresas com paginação por cursor.
   */
  app.get('/admin/tenants', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'SUPER_ADMIN');

    const { limit, cursor } = ListTenantsQuerySchema.parse(request.query);
    const sql = app.db;

    type TenantRow = {
      id: string;
      name: string;
      disk_quota_bytes: string;
      user_quota: number;
      active: boolean;
      created_at: Date;
      ai_classification_enabled: boolean;
      ai_title_suggestion_enabled: boolean;
      ai_index_suggestion_enabled: boolean;
      ai_tag_generation_enabled: boolean;
    };

    let rows: TenantRow[];
    if (cursor !== undefined) {
      rows = await sql<TenantRow[]>`
        SELECT id, name, disk_quota_bytes, user_quota, active, created_at,
               ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled, ai_tag_generation_enabled
        FROM tenants
        WHERE deleted = false AND id > ${cursor}
        ORDER BY id ASC
        LIMIT ${limit + 1}
      `;
    } else {
      rows = await sql<TenantRow[]>`
        SELECT id, name, disk_quota_bytes, user_quota, active, created_at,
               ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled, ai_tag_generation_enabled
        FROM tenants
        WHERE deleted = false
        ORDER BY id ASC
        LIMIT ${limit + 1}
      `;
    }

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    const nextCursor = hasMore && last ? last.id : null;

    const items = page.map((r) => ({
      id: r.id,
      name: r.name,
      diskQuotaBytes: Number(r.disk_quota_bytes),
      userQuota: r.user_quota,
      active: r.active,
      createdAt: r.created_at,
      aiClassificationEnabled: r.ai_classification_enabled,
      aiTitleSuggestionEnabled: r.ai_title_suggestion_enabled,
      aiIndexSuggestionEnabled: r.ai_index_suggestion_enabled,
      aiTagGenerationEnabled: r.ai_tag_generation_enabled,
    }));

    return reply.status(200).send({ items, nextCursor });
  });

  /**
   * PATCH /admin/tenants/:id — atualiza campos da empresa.
   */
  app.patch('/admin/tenants/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'SUPER_ADMIN');

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const updates = PatchTenantBodySchema.parse(request.body);
    const sql = app.db;

    type TenantRow = {
      id: string;
      name: string;
      disk_quota_bytes: string;
      user_quota: number;
      active: boolean;
      created_at: Date;
      ai_classification_enabled: boolean;
      ai_title_suggestion_enabled: boolean;
      ai_index_suggestion_enabled: boolean;
      ai_tag_generation_enabled: boolean;
    };

    const toResponse = (r: TenantRow) => ({
      id: r.id,
      name: r.name,
      diskQuotaBytes: Number(r.disk_quota_bytes),
      userQuota: r.user_quota,
      active: r.active,
      createdAt: r.created_at,
      aiClassificationEnabled: r.ai_classification_enabled,
      aiTitleSuggestionEnabled: r.ai_title_suggestion_enabled,
      aiIndexSuggestionEnabled: r.ai_index_suggestion_enabled,
      aiTagGenerationEnabled: r.ai_tag_generation_enabled,
    });

    if (Object.keys(updates).length === 0) {
      const rows = await sql<TenantRow[]>`
        SELECT id, name, disk_quota_bytes, user_quota, active, created_at,
               ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled, ai_tag_generation_enabled
        FROM tenants
        WHERE id = ${id}
        LIMIT 1
      `;
      if (rows.length === 0) throw new NotFoundError();
      return reply.status(200).send(toResponse(rows[0]!));
    }

    // Todos os campos deste endpoint são administrados exclusivamente pelo
    // SUPER_ADMIN e são dados sensíveis da empresa (nome, cotas, ativa/inativa e
    // as 3 flags de IA). Capturamos o estado ANTES da atualização sempre que ao
    // menos um campo auditável é enviado, para registrar o diff antes/depois no
    // AuditLog (mesmo padrão de `PATCH /admin/platform-settings`). Ver spec §10.
    const touchesAiFlags =
      updates.aiClassificationEnabled !== undefined ||
      updates.aiTitleSuggestionEnabled !== undefined ||
      updates.aiIndexSuggestionEnabled !== undefined ||
      updates.aiTagGenerationEnabled !== undefined;
    const touchesSettings =
      updates.name !== undefined ||
      updates.diskQuotaBytes !== undefined ||
      updates.userQuota !== undefined ||
      updates.active !== undefined;

    let before: TenantRow | undefined;
    if (touchesAiFlags || touchesSettings) {
      const beforeRows = await sql<TenantRow[]>`
        SELECT id, name, disk_quota_bytes, user_quota, active, created_at,
               ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled, ai_tag_generation_enabled
        FROM tenants
        WHERE id = ${id}
        LIMIT 1
      `;
      before = beforeRows[0];
      // Se o tenant não existe, não interrompe aqui: o UPDATE abaixo também
      // não afeta nenhuma linha e cai no NotFoundError já existente, mantendo
      // uma única fonte de verdade para o 404.
    }

    // Monta SET dinâmico apenas com os campos fornecidos
    const setParts: string[] = [];
    const values: unknown[] = [id];
    let paramIdx = 2;

    if (updates.name !== undefined) {
      setParts.push(`name = $${paramIdx++}`);
      values.push(updates.name);
    }
    if (updates.diskQuotaBytes !== undefined) {
      setParts.push(`disk_quota_bytes = $${paramIdx++}`);
      values.push(updates.diskQuotaBytes);
    }
    if (updates.userQuota !== undefined) {
      setParts.push(`user_quota = $${paramIdx++}`);
      values.push(updates.userQuota);
    }
    if (updates.active !== undefined) {
      setParts.push(`active = $${paramIdx++}`);
      values.push(updates.active);
    }
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
    if (updates.aiTagGenerationEnabled !== undefined) {
      setParts.push(`ai_tag_generation_enabled = $${paramIdx++}`);
      values.push(updates.aiTagGenerationEnabled);
    }

    const query = `
      UPDATE tenants
      SET ${setParts.join(', ')}
      WHERE id = $1
      RETURNING id, name, disk_quota_bytes, user_quota, active, created_at,
                ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled, ai_tag_generation_enabled
    `;

    let rows: TenantRow[];
    try {
      rows = await sql.unsafe<TenantRow[]>(query, values as Parameters<typeof sql.unsafe>[1]);
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        throw new ConflictError('Nome de empresa já em uso');
      }
      throw err;
    }

    if (rows.length === 0) throw new NotFoundError();
    const r = rows[0]!;

    const auditLogger = new AuditLogger(sql);

    // AuditLog #1 — flags de IA (plus comercial por empresa, ver
    // `packages/shared-types/src/tenant.ts`). Registra o ator (userId + role),
    // o tenant afetado, e o diff antes/depois apenas dos campos de IA
    // efetivamente informados no PATCH. Ver spec §10, invariante 7.
    if (before !== undefined) {
      const changes: Record<string, { before: boolean; after: boolean }> = {};
      if (updates.aiClassificationEnabled !== undefined) {
        changes['aiClassificationEnabled'] = {
          before: before.ai_classification_enabled,
          after: r.ai_classification_enabled,
        };
      }
      if (updates.aiTitleSuggestionEnabled !== undefined) {
        changes['aiTitleSuggestionEnabled'] = {
          before: before.ai_title_suggestion_enabled,
          after: r.ai_title_suggestion_enabled,
        };
      }
      if (updates.aiIndexSuggestionEnabled !== undefined) {
        changes['aiIndexSuggestionEnabled'] = {
          before: before.ai_index_suggestion_enabled,
          after: r.ai_index_suggestion_enabled,
        };
      }
      if (updates.aiTagGenerationEnabled !== undefined) {
        changes['aiTagGenerationEnabled'] = {
          before: before.ai_tag_generation_enabled,
          after: r.ai_tag_generation_enabled,
        };
      }

      if (Object.keys(changes).length > 0) {
        try {
          await auditLogger.record({
            tenantId: id,
            userId: request.user?.sub ?? null,
            action: 'tenant.ai_settings.update',
            resource: `tenants/${id}`,
            metadata: { actorRole: request.user?.role ?? null, changes },
          });
        } catch (auditError) {
          request.log.error(
            { err: auditError, tenantId: id, userId: request.user?.sub ?? null },
            'falha ao registrar audit log de atualização de configuração de IA do tenant',
          );
        }
      }
    }

    // AuditLog #2 — dados administrativos da empresa (nome, cotas, ativa/inativa).
    // São dados sensíveis geridos pelo SUPER_ADMIN e, pela mesma invariante de
    // auditoria de mudanças administrativas (spec §10), passam a ser auditados
    // com o MESMO padrão de diff antes/depois das flags de IA. Ação separada
    // (`tenant.settings.update`) para não misturar o diff comercial de IA com o
    // diff administrativo.
    if (before !== undefined) {
      const changes: Record<string, { before: unknown; after: unknown }> = {};
      if (updates.name !== undefined) {
        changes['name'] = { before: before.name, after: r.name };
      }
      if (updates.diskQuotaBytes !== undefined) {
        changes['diskQuotaBytes'] = {
          before: Number(before.disk_quota_bytes),
          after: Number(r.disk_quota_bytes),
        };
      }
      if (updates.userQuota !== undefined) {
        changes['userQuota'] = { before: before.user_quota, after: r.user_quota };
      }
      if (updates.active !== undefined) {
        changes['active'] = { before: before.active, after: r.active };
      }

      if (Object.keys(changes).length > 0) {
        try {
          await auditLogger.record({
            tenantId: id,
            userId: request.user?.sub ?? null,
            action: 'tenant.settings.update',
            resource: `tenants/${id}`,
            metadata: { actorRole: request.user?.role ?? null, changes },
          });
        } catch (auditError) {
          request.log.error(
            { err: auditError, tenantId: id, userId: request.user?.sub ?? null },
            'falha ao registrar audit log de atualização administrativa do tenant',
          );
        }
      }
    }

    request.log.info({ tenantId: id }, 'tenant atualizado');
    return reply.status(200).send(toResponse(r));
  });

  /**
   * DELETE /admin/tenants/:id — exclui (soft-delete) uma empresa e enfileira a
   * purga definitiva em background.
   *
   * O endpoint apenas marca o tenant e enfileira o job na fila `tenant-deletion`
   * — ele NÃO executa a purga (S3, dados) diretamente; isso é responsabilidade
   * do worker. A empresa é marcada `deleted=true`/`active=false` e o nome é
   * renomeado (libera o índice único de nome imediatamente para reuso).
   *
   * Idempotência: como o UPDATE usa `AND deleted = false`, re-disparar sobre um
   * tenant já excluído cai no 404 (já está deleted).
   */
  app.delete('/admin/tenants/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'SUPER_ADMIN');

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const sql = app.db;

    // Marca + renomeia em transação. O `RETURNING` só traz linha se o tenant
    // existia e ainda não estava deleted — combina existência e idempotência.
    const updated = await sql.begin(async (tx) => {
      return tx<Array<{ id: string }>>`
        UPDATE tenants
        SET active = false,
            deleted = true,
            deleted_at = now(),
            name = '[EXCLUÍDA-' || extract(epoch from now())::bigint || '] ' || name
        WHERE id = ${id} AND deleted = false
        RETURNING id
      `;
    });

    if (updated.length === 0) {
      throw new NotFoundError();
    }

    // Enfileira o job de purga. Em testes a fila é null — apenas loga e segue.
    if (app.tenantDeletionQueue !== null) {
      const jobData = TenantDeletionJobDataSchema.parse({ tenantId: id });
      await app.tenantDeletionQueue.add('purge', jobData, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      });
    } else {
      request.log.warn({ tenantId: id }, 'tenantDeletionQueue não configurada — purga não enfileirada');
    }

    // AuditLog da solicitação de exclusão.
    const auditLogger = new AuditLogger(sql);
    try {
      await auditLogger.record({
        tenantId: id,
        userId: request.user?.sub ?? null,
        action: 'tenant.delete.requested',
        resource: `tenants/${id}`,
        metadata: {},
      });
    } catch (auditError) {
      request.log.error(
        { err: auditError, tenantId: id, userId: request.user?.sub ?? null },
        'falha ao registrar audit log de exclusão de tenant',
      );
    }

    request.log.info({ tenantId: id }, 'tenant marcado para exclusão e purga enfileirada');
    return reply.status(202).send({ id, status: 'deleting' });
  });
};
