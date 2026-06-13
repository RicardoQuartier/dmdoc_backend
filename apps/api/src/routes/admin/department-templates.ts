import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { MongoServerError } from 'mongodb';
import { newId } from '@dmdoc/db-mongo';
import {
  CreateDepartmentTemplateBodySchema,
  UpdateDepartmentTemplateBodySchema,
  ListDepartmentTemplatesQuerySchema,
} from '@dmdoc/shared-types';
import { ConflictError, NotFoundError } from '../../errors/index.js';
import { requireRole } from '../../auth/role-guard.js';

const IdParamsSchema = z.object({ id: z.string().uuid() });

/**
 * Remove `_id` interno do Mongo antes de enviar ao cliente.
 */
function stripMongoId(doc: unknown): Record<string, unknown> {
  const record = doc as Record<string, unknown>;
  const { _id: _ignored, ...rest } = record;
  return rest;
}

/**
 * Rotas CRUD de templates de departamentos. Acesso exclusivo: SUPER_ADMIN.
 *
 * A coleção `department_templates` é global — sem `tenantId`, sem soft-delete.
 * Templates são configuração de plataforma gerenciada pelo SUPER_ADMIN e usados
 * na criação de novos tenants para pré-popular a árvore de departamentos.
 *
 * Spec §5.3 (extensão — coleção `department_templates`).
 */
export const adminDepartmentTemplatesRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /admin/department-templates — cria template.
   *
   * Body: { name, description?, nodes[] }
   * Nodes: array plano de até 200 nós com refId/parentRefId para montar a árvore.
   * Validação de parentRefs feita pelo schema Zod (refine).
   */
  app.post(
    '/admin/department-templates',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, 'SUPER_ADMIN');

      const body = CreateDepartmentTemplateBodySchema.parse(request.body);
      const db = app.db;
      // requireRole garante que request.user está presente antes deste ponto.
      const userId = request.user?.sub;

      const doc = {
        id: newId(),
        name: body.name,
        ...(body.description !== undefined ? { description: body.description } : {}),
        nodes: body.nodes,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      try {
        await db.collection('department_templates').insertOne(doc);
      } catch (err) {
        if (err instanceof MongoServerError && err.code === 11000) {
          throw new ConflictError('Nome de template já em uso');
        }
        throw err;
      }

      request.log.info({ templateId: doc.id, userId }, 'template de departamentos criado');
      return reply.status(201).send(doc);
    },
  );

  /**
   * GET /admin/department-templates — lista todos os templates.
   *
   * Paginação por cursor estável (`id` uuid ordenado lexicograficamente).
   * Query: { limit?, cursor? }
   * Response: { items: DepartmentTemplate[], nextCursor: string | null }
   */
  app.get(
    '/admin/department-templates',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, 'SUPER_ADMIN');

      const { limit, cursor } = ListDepartmentTemplatesQuerySchema.parse(request.query);
      const db = app.db;

      const filter = cursor !== undefined ? { id: { $gt: cursor } } : {};

      const docs = await db
        .collection('department_templates')
        .find(filter)
        .sort({ id: 1 })
        .limit(limit + 1)
        .toArray();

      const hasMore = docs.length > limit;
      const page = hasMore ? docs.slice(0, limit) : docs;
      const last = page.at(-1);
      const nextCursor = hasMore && last ? (last as unknown as { id: string }).id : null;

      const items = page.map(stripMongoId);

      return reply.status(200).send({ items, nextCursor });
    },
  );

  /**
   * GET /admin/department-templates/:id — detalhe de um template.
   *
   * Retorna 404 se o id não existir.
   */
  app.get(
    '/admin/department-templates/:id',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, 'SUPER_ADMIN');

      const { id } = IdParamsSchema.parse(request.params);
      const db = app.db;

      const doc = await db.collection('department_templates').findOne({ id });
      if (!doc) throw new NotFoundError();

      return reply.status(200).send(stripMongoId(doc));
    },
  );

  /**
   * PATCH /admin/department-templates/:id — atualiza campos do template.
   *
   * Body: { name?, description?, nodes? } — pelo menos um campo obrigatório.
   * Quando `nodes` é enviado, valida referências internas (refine no schema).
   * Atualiza `updatedAt` automaticamente.
   */
  app.patch(
    '/admin/department-templates/:id',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, 'SUPER_ADMIN');

      const { id } = IdParamsSchema.parse(request.params);
      const updates = UpdateDepartmentTemplateBodySchema.parse(request.body);
      const db = app.db;
      const userId = request.user?.sub;

      let updated;
      try {
        updated = await db
          .collection('department_templates')
          .findOneAndUpdate(
            { id },
            { $set: { ...updates, updatedAt: new Date() } },
            { returnDocument: 'after' },
          );
      } catch (err) {
        if (err instanceof MongoServerError && err.code === 11000) {
          throw new ConflictError('Nome de template já em uso');
        }
        throw err;
      }

      if (!updated) throw new NotFoundError();

      request.log.info({ templateId: id, userId }, 'template de departamentos atualizado');
      return reply.status(200).send(stripMongoId(updated));
    },
  );

  /**
   * DELETE /admin/department-templates/:id — exclui template (hard delete).
   *
   * Templates são configuração de plataforma sem histórico de auditoria próprio.
   * Hard delete: o documento é removido fisicamente da coleção.
   * Retorna 404 se o id não existir.
   */
  app.delete(
    '/admin/department-templates/:id',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, 'SUPER_ADMIN');

      const { id } = IdParamsSchema.parse(request.params);
      const db = app.db;
      const userId = request.user?.sub;

      const result = await db.collection('department_templates').deleteOne({ id });
      if (result.deletedCount === 0) throw new NotFoundError();

      request.log.info({ templateId: id, userId }, 'template de departamentos excluído');
      return reply.status(204).send();
    },
  );
};
