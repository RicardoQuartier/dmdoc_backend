import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { newId } from '@dmdoc/db-pg';
import { ConflictError, NotFoundError } from '../../errors/index.js';
import { requireRole } from '../../auth/role-guard.js';
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
});

const ListTenantsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
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

    type TenantRow = { id: string; name: string; disk_quota_bytes: string; user_quota: number; active: boolean; created_at: Date };

    let rows: TenantRow[];
    if (cursor !== undefined) {
      rows = await sql<TenantRow[]>`
        SELECT id, name, disk_quota_bytes, user_quota, active, created_at
        FROM tenants
        WHERE id > ${cursor}
        ORDER BY id ASC
        LIMIT ${limit + 1}
      `;
    } else {
      rows = await sql<TenantRow[]>`
        SELECT id, name, disk_quota_bytes, user_quota, active, created_at
        FROM tenants
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

    if (Object.keys(updates).length === 0) {
      const rows = await sql<Array<{ id: string; name: string; disk_quota_bytes: string; user_quota: number; active: boolean; created_at: Date }>>`
        SELECT id, name, disk_quota_bytes, user_quota, active, created_at
        FROM tenants
        WHERE id = ${id}
        LIMIT 1
      `;
      if (rows.length === 0) throw new NotFoundError();
      const r = rows[0]!;
      return reply.status(200).send({ id: r.id, name: r.name, diskQuotaBytes: Number(r.disk_quota_bytes), userQuota: r.user_quota, active: r.active, createdAt: r.created_at });
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

    const query = `
      UPDATE tenants
      SET ${setParts.join(', ')}
      WHERE id = $1
      RETURNING id, name, disk_quota_bytes, user_quota, active, created_at
    `;

    type TenantRow = { id: string; name: string; disk_quota_bytes: string; user_quota: number; active: boolean; created_at: Date };

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

    request.log.info({ tenantId: id }, 'tenant atualizado');
    return reply.status(200).send({ id: r.id, name: r.name, diskQuotaBytes: Number(r.disk_quota_bytes), userQuota: r.user_quota, active: r.active, createdAt: r.created_at });
  });
};
