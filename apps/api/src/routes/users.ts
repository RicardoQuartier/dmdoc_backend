import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { MongoServerError } from 'mongodb';
import { TenantRepository } from '@dmdoc/db-mongo';
import type { User } from '@dmdoc/shared-types';
import type { TenantDocument } from '@dmdoc/db-mongo';
import { ConflictError, NotFoundError } from '../errors/index.js';
import { requireRole } from '../auth/role-guard.js';
import { hashPassword } from '../auth/password.js';
import { resolveTenantId } from '../auth/resolve-tenant.js';

interface UserDoc extends TenantDocument {
  email: string;
  passwordHash: string;
  name: string;
  role: User['role'];
  active: boolean;
  createdAt: Date;
}

const CreateUserBodySchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200),
  role: z.enum(['TENANT_ADMIN', 'UPLOADER', 'USER']),
  password: z.string().min(8),
  active: z.boolean().default(true),
  tenantId: z.string().uuid().optional(), // SUPER_ADMIN apenas
});

const PatchUserBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  role: z.enum(['TENANT_ADMIN', 'UPLOADER', 'USER']).optional(),
  active: z.boolean().optional(),
});

const ListUsersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  tenantId: z.string().uuid().optional(),
});

const TenantIdQuerySchema = z.object({
  tenantId: z.string().uuid().optional(), // SUPER_ADMIN apenas
});

/**
 * Rotas de CRUD de usuários. O `tenantId` vem sempre de `request.tenantId`
 * para roles normais; SUPER_ADMIN o informa via body (POST) ou query param
 * (PATCH, DELETE).
 *
 * `passwordHash` NUNCA é devolvido em nenhum response.
 */
export const usersRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /users — cria usuário no tenant.
   * SUPER_ADMIN: informar `tenantId` no body (obrigatório).
   * Valida cota antes de inserir.
   */
  app.post('/users', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN');

    const body = CreateUserBodySchema.parse(request.body);
    const effectiveTenantId = resolveTenantId(request, body.tenantId, true);
    // effectiveTenantId nunca é null aqui (requireForSuperAdmin: true)
    const tenantId = effectiveTenantId as string;
    const db = app.db;

    // Validação de cota
    const tenant = await db.collection('tenants').findOne({ id: tenantId });
    if (!tenant) throw new NotFoundError('Empresa não encontrada');

    const usersRepo = new TenantRepository<UserDoc>(db.collection('users'), { tenantId });
    const count = await usersRepo.count({ active: true });
    const userQuota = (tenant as unknown as { userQuota: number }).userQuota;
    if (count >= userQuota) {
      throw new ConflictError('Cota de usuários atingida');
    }

    const passwordHash = await hashPassword(body.password);

    // Excluir tenantId do body antes de inserir (é gerenciado pelo TenantRepository)
    const { tenantId: _ignored, ...insertData } = body;

    let user: UserDoc;
    try {
      user = await usersRepo.insertOne({
        email: insertData.email,
        name: insertData.name,
        role: insertData.role,
        active: insertData.active,
        passwordHash,
        createdAt: new Date(),
      });
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) {
        throw new ConflictError('E-mail já em uso nesta empresa');
      }
      throw err;
    }

    request.log.info({ tenantId, userId: user.id }, 'usuário criado');
    return reply.status(201).send(safeUser(user));
  });

  /**
   * GET /users — lista usuários.
   *
   * SUPER_ADMIN: vê todos os tenants. `?tenantId=xxx` filtra por empresa.
   * Demais roles: sempre escopadas ao próprio tenant (param tenantId ignorado).
   */
  app.get('/users', { preHandler: app.authenticate }, async (request, reply) => {
    const { limit, cursor, tenantId: tenantIdParam } = ListUsersQuerySchema.parse(request.query);
    const db = app.db;
    const isSuperAdmin = request.user?.role === 'SUPER_ADMIN';

    let items: ReturnType<typeof safeUser>[];
    let nextCursor: string | null;

    if (isSuperAdmin) {
      // SUPER_ADMIN: query direta sem filtro de tenant, ou filtrando pelo param
      const filter: Record<string, unknown> = { deleted: false };
      if (tenantIdParam !== undefined) filter['tenantId'] = tenantIdParam;
      if (cursor !== undefined) filter['id'] = { $gt: cursor };

      const docs = await db
        .collection('users')
        .find(filter)
        .sort({ id: 1 })
        .limit(limit + 1)
        .toArray();

      const hasMore = docs.length > limit;
      const page = hasMore ? docs.slice(0, limit) : docs;
      nextCursor = hasMore && page.at(-1) ? (page.at(-1) as unknown as { id: string }).id : null;
      items = page.map((d) => safeUser(d as unknown as UserDoc));
    } else {
      const tenantId = request.tenantId!;
      const usersRepo = new TenantRepository<UserDoc>(db.collection('users'), { tenantId });
      const pagination = cursor !== undefined ? { limit, cursor } : { limit };
      const page = await usersRepo.findMany({}, pagination);
      items = page.items.map(safeUser);
      nextCursor = page.nextCursor;
    }

    return reply.status(200).send({ items, nextCursor });
  });

  /**
   * PATCH /users/:id — atualiza usuário do tenant.
   * SUPER_ADMIN: informar `?tenantId=xxx` (obrigatório).
   */
  app.patch('/users/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN');

    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
    const effectiveTenantId = resolveTenantId(request, tenantIdParam, true);
    const tenantId = effectiveTenantId as string;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const updates = PatchUserBodySchema.parse(request.body);
    const db = app.db;

    const usersRepo = new TenantRepository<UserDoc>(db.collection('users'), { tenantId });
    const updated = await usersRepo.updateById(
      id,
      removeUndefined(updates) as Parameters<typeof usersRepo.updateById>[1]
    );
    if (!updated) throw new NotFoundError();

    request.log.info({ tenantId, userId: id }, 'usuário atualizado');
    return reply.status(200).send(safeUser(updated));
  });

  /**
   * DELETE /users/:id — soft-delete de usuário do tenant.
   * SUPER_ADMIN: informar `?tenantId=xxx` (obrigatório).
   */
  app.delete('/users/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN');

    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
    const effectiveTenantId = resolveTenantId(request, tenantIdParam, true);
    const tenantId = effectiveTenantId as string;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const db = app.db;

    const usersRepo = new TenantRepository<UserDoc>(db.collection('users'), { tenantId });
    const deleted = await usersRepo.softDelete(id);
    if (!deleted) throw new NotFoundError();

    request.log.info({ tenantId, userId: id }, 'usuário removido (soft delete)');
    return reply.status(204).send();
  });
};

/**
 * Remove `passwordHash` antes de devolver ao cliente.
 */
function safeUser(user: UserDoc): Omit<UserDoc, 'passwordHash'> {
  const { passwordHash: _, ...safe } = user;
  return safe;
}

/**
 * Remove propriedades com valor `undefined` do objeto, para compatibilidade
 * com `exactOptionalPropertyTypes`.
 */
function removeUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
}
