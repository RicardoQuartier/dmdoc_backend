import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { MongoServerError } from 'mongodb';
import { newId } from '@dmdoc/db-mongo';
import { ConflictError, NotFoundError } from '../../errors/index.js';
import { requireRole } from '../../auth/role-guard.js';

const CreateTenantBodySchema = z.object({
  name: z.string().min(1).max(200),
  diskQuotaBytes: z.number().int().nonnegative().default(10 * 1024 ** 3),
  userQuota: z.number().int().nonnegative().default(20),
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
 * A coleção `tenants` não usa TenantRepository (não tem tenantId próprio nem
 * soft-delete). Operações via driver direto.
 */
export const adminTenantsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /admin/tenants — cria nova empresa.
   */
  app.post('/admin/tenants', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'SUPER_ADMIN');

    const { name, diskQuotaBytes, userQuota } = CreateTenantBodySchema.parse(request.body);
    const db = app.db;

    const doc = {
      id: newId(),
      name,
      diskQuotaBytes,
      userQuota,
      active: true,
      createdAt: new Date(),
    };

    try {
      await db.collection('tenants').insertOne(doc);
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) {
        throw new ConflictError('Nome de empresa já em uso');
      }
      throw err;
    }

    request.log.info({ tenantId: doc.id }, 'tenant criado');
    return reply.status(201).send(doc);
  });

  /**
   * GET /admin/tenants — lista empresas com paginação por cursor.
   */
  app.get('/admin/tenants', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'SUPER_ADMIN');

    const { limit, cursor } = ListTenantsQuerySchema.parse(request.query);
    const db = app.db;

    const filter = cursor !== undefined ? { id: { $gt: cursor } } : {};

    const docs = await db
      .collection('tenants')
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
  });

  /**
   * PATCH /admin/tenants/:id — atualiza campos da empresa.
   */
  app.patch('/admin/tenants/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'SUPER_ADMIN');

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const updates = PatchTenantBodySchema.parse(request.body);
    const db = app.db;

    if (Object.keys(updates).length === 0) {
      const existing = await db.collection('tenants').findOne({ id });
      if (!existing) throw new NotFoundError();
      return reply.status(200).send(stripMongoId(existing));
    }

    let updated;
    try {
      updated = await db
        .collection('tenants')
        .findOneAndUpdate({ id }, { $set: updates }, { returnDocument: 'after' });
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) {
        throw new ConflictError('Nome de empresa já em uso');
      }
      throw err;
    }

    if (!updated) throw new NotFoundError();

    request.log.info({ tenantId: id }, 'tenant atualizado');
    return reply.status(200).send(stripMongoId(updated));
  });
};

function stripMongoId(doc: unknown): Record<string, unknown> {
  const record = doc as Record<string, unknown>;
  const { _id: _ignored, ...rest } = record;
  return rest;
}
