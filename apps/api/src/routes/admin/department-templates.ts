import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { newId } from '@dmdoc/db-pg';
import {
  CreateDepartmentTemplateBodySchema,
  UpdateDepartmentTemplateBodySchema,
  ListDepartmentTemplatesQuerySchema,
} from '@dmdoc/shared-types';
import { ConflictError, NotFoundError } from '../../errors/index.js';
import { requireRole } from '../../auth/role-guard.js';

const IdParamsSchema = z.object({ id: z.string().uuid() });

/**
 * Rotas CRUD de templates de departamentos. Acesso exclusivo: SUPER_ADMIN.
 *
 * A tabela `department_templates` é global — sem `tenantId`, sem soft-delete.
 * Templates são configuração de plataforma gerenciada pelo SUPER_ADMIN e usados
 * na criação de novos tenants para pré-popular a árvore de departamentos.
 *
 * Spec §5.3 (extensão — tabela `department_templates`).
 */
export const adminDepartmentTemplatesRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /admin/department-templates — cria template.
   */
  app.post(
    '/admin/department-templates',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, 'SUPER_ADMIN');

      const body = CreateDepartmentTemplateBodySchema.parse(request.body);
      const sql = app.db;
      const userId = request.user?.sub;

      const id = newId();
      const now = new Date();
      const description = body.description ?? null;

      try {
        await sql`
          INSERT INTO department_templates (id, name, description, nodes, created_at, updated_at)
          VALUES (${id}, ${body.name}, ${description}, ${sql.json(body.nodes)}, ${now}, ${now})
        `;
      } catch (err: unknown) {
        const pgErr = err as { code?: string };
        if (pgErr.code === '23505') {
          throw new ConflictError('Nome de template já em uso');
        }
        throw err;
      }

      request.log.info({ templateId: id, userId }, 'template de departamentos criado');
      return reply.status(201).send({ id, name: body.name, description, nodes: body.nodes, createdAt: now, updatedAt: now });
    },
  );

  /**
   * GET /admin/department-templates — lista todos os templates.
   */
  app.get(
    '/admin/department-templates',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, 'SUPER_ADMIN');

      const { limit, cursor } = ListDepartmentTemplatesQuerySchema.parse(request.query);
      const sql = app.db;

      type TemplateRow = { id: string; name: string; description: string | null; nodes: unknown; created_at: Date; updated_at: Date };

      let rows: TemplateRow[];
      if (cursor !== undefined) {
        rows = await sql<TemplateRow[]>`
          SELECT id, name, description, nodes, created_at, updated_at
          FROM department_templates
          WHERE id > ${cursor}
          ORDER BY id ASC
          LIMIT ${limit + 1}
        `;
      } else {
        rows = await sql<TemplateRow[]>`
          SELECT id, name, description, nodes, created_at, updated_at
          FROM department_templates
          ORDER BY id ASC
          LIMIT ${limit + 1}
        `;
      }

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      const nextCursor = hasMore && last ? last.id : null;

      const items = page.map((r) => ({ id: r.id, name: r.name, description: r.description, nodes: r.nodes, createdAt: r.created_at, updatedAt: r.updated_at }));

      return reply.status(200).send({ items, nextCursor });
    },
  );

  /**
   * GET /admin/department-templates/:id — detalhe de um template.
   */
  app.get(
    '/admin/department-templates/:id',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, 'SUPER_ADMIN');

      const { id } = IdParamsSchema.parse(request.params);
      const sql = app.db;

      type TemplateRow = { id: string; name: string; description: string | null; nodes: unknown; created_at: Date; updated_at: Date };
      const rows = await sql<TemplateRow[]>`
        SELECT id, name, description, nodes, created_at, updated_at
        FROM department_templates
        WHERE id = ${id}
        LIMIT 1
      `;
      if (rows.length === 0) throw new NotFoundError();
      const r = rows[0]!;

      return reply.status(200).send({ id: r.id, name: r.name, description: r.description, nodes: r.nodes, createdAt: r.created_at, updatedAt: r.updated_at });
    },
  );

  /**
   * PATCH /admin/department-templates/:id — atualiza campos do template.
   */
  app.patch(
    '/admin/department-templates/:id',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, 'SUPER_ADMIN');

      const { id } = IdParamsSchema.parse(request.params);
      const updates = UpdateDepartmentTemplateBodySchema.parse(request.body);
      const sql = app.db;
      const userId = request.user?.sub;

      const setParts: string[] = [];
      const values: unknown[] = [id, new Date()];
      let paramIdx = 3;

      if (updates.name !== undefined) {
        setParts.push(`name = $${paramIdx++}`);
        values.push(updates.name);
      }
      if ('description' in updates && updates.description !== undefined) {
        setParts.push(`description = $${paramIdx++}`);
        values.push(updates.description);
      }
      if (updates.nodes !== undefined) {
        setParts.push(`nodes = $${paramIdx++}`);
        values.push(sql.json(updates.nodes));
      }

      if (setParts.length === 0) {
        // Nada para atualizar — retorna o registro atual
        type TemplateRow = { id: string; name: string; description: string | null; nodes: unknown; created_at: Date; updated_at: Date };
        const rows = await sql<TemplateRow[]>`
          SELECT id, name, description, nodes, created_at, updated_at
          FROM department_templates
          WHERE id = ${id}
          LIMIT 1
        `;
        if (rows.length === 0) throw new NotFoundError();
        const r = rows[0]!;
        return reply.status(200).send({ id: r.id, name: r.name, description: r.description, nodes: r.nodes, createdAt: r.created_at, updatedAt: r.updated_at });
      }

      const query = `
        UPDATE department_templates
        SET ${setParts.join(', ')}, updated_at = $2
        WHERE id = $1
        RETURNING id, name, description, nodes, created_at, updated_at
      `;

      type TemplateRow = { id: string; name: string; description: string | null; nodes: unknown; created_at: Date; updated_at: Date };

      let rows: TemplateRow[];
      try {
        rows = await sql.unsafe<TemplateRow[]>(query, values as Parameters<typeof sql.unsafe>[1]);
      } catch (err: unknown) {
        const pgErr = err as { code?: string };
        if (pgErr.code === '23505') {
          throw new ConflictError('Nome de template já em uso');
        }
        throw err;
      }

      if (rows.length === 0) throw new NotFoundError();
      const r = rows[0]!;

      request.log.info({ templateId: id, userId }, 'template de departamentos atualizado');
      return reply.status(200).send({ id: r.id, name: r.name, description: r.description, nodes: r.nodes, createdAt: r.created_at, updatedAt: r.updated_at });
    },
  );

  /**
   * DELETE /admin/department-templates/:id — exclui template (hard delete).
   */
  app.delete(
    '/admin/department-templates/:id',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, 'SUPER_ADMIN');

      const { id } = IdParamsSchema.parse(request.params);
      const sql = app.db;
      const userId = request.user?.sub;

      const result = await sql`
        DELETE FROM department_templates
        WHERE id = ${id}
      `;

      if (result.count === 0) throw new NotFoundError();

      request.log.info({ templateId: id, userId }, 'template de departamentos excluído');
      return reply.status(204).send();
    },
  );
};
