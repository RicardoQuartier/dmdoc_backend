import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MongoServerError } from 'mongodb';
import type { Db } from 'mongodb';
import { TenantRepository } from '@dmdoc/db-mongo';
import type { User } from '@dmdoc/shared-types';
import { ADMIN_ROLES } from '@dmdoc/shared-types';
import type { TenantDocument } from '@dmdoc/db-mongo';
import { ConflictError, NotFoundError } from '../errors/index.js';
import { requireRole } from '../auth/role-guard.js';
import { hashPassword } from '../auth/password.js';
import { resolveTenantContext, resolveTenantId } from '../auth/resolve-tenant.js';

interface UserDoc extends TenantDocument {
  email: string;
  passwordHash: string;
  name: string;
  role: User['role'];
  active: boolean;
  createdAt: Date;
  /**
   * Lista de tenants atribuídos. Presente apenas em documentos de
   * MULTI_TENANT_ADMIN; ausente (undefined) nos demais.
   */
  allowedTenantIds?: string[];
}

const CreateUserBodySchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200),
  role: z.enum(['MULTI_TENANT_ADMIN', 'TENANT_ADMIN', 'UPLOADER', 'USER']),
  password: z.string().min(8),
  active: z.boolean().default(true),
  tenantId: z.string().uuid().optional(), // SUPER_ADMIN apenas; null para MTA
  /**
   * Lista de tenants que o MULTI_TENANT_ADMIN pode acessar.
   * Máximo 20 no MVP. Ignorado para outros roles.
   */
  allowedTenantIds: z
    .array(z.string().uuid())
    .max(20, 'MULTI_TENANT_ADMIN suporta no máximo 20 tenants no MVP')
    .optional(),
});

const PatchUserBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  role: z.enum(['MULTI_TENANT_ADMIN', 'TENANT_ADMIN', 'UPLOADER', 'USER']).optional(),
  active: z.boolean().optional(),
  /**
   * Usado quando `role` é alterado para MULTI_TENANT_ADMIN.
   * Ignorado nos demais casos.
   */
  allowedTenantIds: z
    .array(z.string().uuid())
    .max(20, 'MULTI_TENANT_ADMIN suporta no máximo 20 tenants no MVP')
    .optional(),
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
   *
   * SUPER_ADMIN: informar `tenantId` no body (obrigatório para roles com empresa).
   * SUPER_ADMIN criando MULTI_TENANT_ADMIN: `tenantId` é omitido (null); informar
   *   `allowedTenantIds` opcional.
   * TENANT_ADMIN: cria usuário no próprio tenant; `tenantId` do body ignorado.
   *
   * Valida cota antes de inserir (exceto para MULTI_TENANT_ADMIN, que não
   * pertence a nenhuma empresa e não consome cota de tenant).
   */
  app.post('/users', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, ...ADMIN_ROLES);

    const body = CreateUserBodySchema.parse(request.body);
    const db = app.db;

    // MULTI_TENANT_ADMIN: tenantId null, sem validação de cota de tenant.
    // Apenas SUPER_ADMIN pode criar MTA (TENANT_ADMIN não tem permissão para
    // criar papéis sem empresa).
    if (body.role === 'MULTI_TENANT_ADMIN') {
      if (request.user?.role !== 'SUPER_ADMIN') {
        throw new ConflictError('Apenas SUPER_ADMIN pode criar usuários MULTI_TENANT_ADMIN');
      }

      const passwordHash = await hashPassword(body.password);
      const newId = crypto.randomUUID();
      const mtaDoc = {
        id: newId,
        tenantId: null,
        email: body.email,
        name: body.name,
        role: 'MULTI_TENANT_ADMIN' as const,
        active: body.active,
        passwordHash,
        createdAt: new Date(),
        deleted: false,
        allowedTenantIds: body.allowedTenantIds ?? [],
      };

      try {
        await db.collection('users').insertOne(mtaDoc);
      } catch (err) {
        if (err instanceof MongoServerError && err.code === 11000) {
          throw new ConflictError('E-mail já em uso');
        }
        throw err;
      }

      const { passwordHash: _, deleted: _d, _id: _mid, ...safeMta } = mtaDoc as typeof mtaDoc & { _id?: unknown };
      request.log.info({ userId: newId, role: 'MULTI_TENANT_ADMIN' }, 'MULTI_TENANT_ADMIN criado');
      return reply.status(201).send(safeMta);
    }

    // Demais roles: resolveTenantId normal (obrigatório para SA, implícito para
    // TENANT_ADMIN). Para SUPER_ADMIN e MULTI_TENANT_ADMIN o tenant alvo pode vir
    // via ?tenantId (query) ou no corpo; query tem precedência. resolveTenantId já
    // valida que MTA só opera em tenants ∈ allowedTenantIds (senão NotFoundError).
    const { tenantId: tenantIdQuery } = TenantIdQuerySchema.parse(request.query);
    const explicitTenantId = tenantIdQuery ?? body.tenantId;
    const effectiveTenantId = resolveTenantId(request, explicitTenantId, true);
    // effectiveTenantId nunca é null aqui (requireForSuperAdmin: true)
    const tenantId = effectiveTenantId as string;

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

    // Excluir tenantId e allowedTenantIds do body antes de inserir
    const { tenantId: _ignored, allowedTenantIds: _allowedIgnored, ...insertData } = body;

    let user: UserDoc;
    try {
      user = await usersRepo.insertOne({
        email: insertData.email,
        name: insertData.name,
        role: insertData.role as Exclude<typeof insertData.role, 'MULTI_TENANT_ADMIN'>,
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
   * MULTI_TENANT_ADMIN: sem `?tenantId` lista usuários de TODOS os
   *   `allowedTenantIds` ($in); com `?tenantId=X` (X ∈ allowedTenantIds) filtra
   *   só aquele tenant (fora da lista → 404 via resolveTenantContext).
   * Demais roles: sempre escopadas ao próprio tenant (param tenantId ignorado).
   *
   * `allowedTenantIds` é projetado em cada usuário retornado (o frontend exibe
   * os tenants do MTA na coluna Empresa); `safeUser` já o preserva quando presente.
   */
  app.get('/users', { preHandler: app.authenticate }, async (request, reply) => {
    const { limit, cursor, tenantId: tenantIdParam } = ListUsersQuerySchema.parse(request.query);
    const db = app.db;

    const ctx = resolveTenantContext(request, { explicitTenantId: tenantIdParam, write: false });

    let items: ReturnType<typeof safeUser>[];
    let nextCursor: string | null;

    if (ctx.mode === 'single') {
      // Roles normais, SUPER_ADMIN com ?tenantId, ou MTA com ?tenantId válido.
      const tenantId = ctx.tenantId;
      const usersRepo = new TenantRepository<UserDoc>(db.collection('users'), { tenantId });
      const pagination = cursor !== undefined ? { limit, cursor } : { limit };
      const page = await usersRepo.findMany({}, pagination);
      items = page.items.map(safeUser);
      nextCursor = page.nextCursor;
    } else {
      // ctx.mode === 'all'      → SUPER_ADMIN sem filtro de tenant.
      // ctx.mode === 'allowed'  → MTA sem ?tenantId: filtra $in allowedTenantIds.
      const filter: Record<string, unknown> = { deleted: false };
      if (ctx.mode === 'allowed') filter['tenantId'] = { $in: ctx.tenantIds };
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
    }

    return reply.status(200).send({ items, nextCursor });
  });

  /**
   * GET /users/:id — retorna um único usuário pelo ID.
   * TENANT_ADMIN: escopado ao próprio tenant.
   * MULTI_TENANT_ADMIN: escopado a `allowedTenantIds` ($in); fora da lista → 404.
   * SUPER_ADMIN: busca global (IDs são UUIDs globalmente únicos).
   */
  app.get('/users/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, ...ADMIN_ROLES);

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const db = app.db;
    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);

    const user = await findUserInScope(db, request, id, tenantIdParam);
    if (!user) throw new NotFoundError();

    return reply.status(200).send(safeUser(user));
  });

  /**
   * PATCH /users/:id — atualiza usuário do tenant.
   * SUPER_ADMIN: informar `?tenantId=xxx` (obrigatório).
   *
   * Transições de role:
   *   - De MTA para outro role: zera `allowedTenantIds`.
   *   - Para MTA: aceita `allowedTenantIds` no body (aplicado na atualização);
   *     a rota usa query direto no driver pois MTA não tem tenantId.
   *   - Para demais roles: `allowedTenantIds` do body é ignorado.
   */
  app.patch('/users/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, ...ADMIN_ROLES);

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const updates = PatchUserBodySchema.parse(request.body);
    const db = app.db;

    // Busca o usuário atual para determinar role original e validar escopo.
    // SUPER_ADMIN: busca global; demais roles: escopam ao próprio tenant.
    const isSuperAdmin = request.user?.role === 'SUPER_ADMIN';

    const existingDoc = isSuperAdmin
      ? ((await db.collection('users').findOne({ id, deleted: false })) as unknown as UserDoc | null)
      : null;

    // Para SUPER_ADMIN buscamos o usuário direto; para outros roles usamos
    // TenantRepository (que injeta o tenantId correto).
    if (isSuperAdmin) {
      if (!existingDoc) throw new NotFoundError();

      // Cast explícito para o union completo de roles, evitando narrowing indevido
      // pelo TypeScript quando o valor vem de um documento Mongo tipado.
      const currentRole = existingDoc.role as
        | 'SUPER_ADMIN'
        | 'MULTI_TENANT_ADMIN'
        | 'TENANT_ADMIN'
        | 'UPLOADER'
        | 'USER';
      const newRole = updates.role;

      const setFields: Record<string, unknown> = {};

      if (updates.name !== undefined) setFields['name'] = updates.name;
      if (updates.active !== undefined) setFields['active'] = updates.active;

      if (newRole !== undefined) {
        setFields['role'] = newRole;

        if (newRole === 'MULTI_TENANT_ADMIN') {
          // Promoção para MTA: aplica allowedTenantIds se fornecido
          setFields['allowedTenantIds'] = updates.allowedTenantIds ?? existingDoc.allowedTenantIds ?? [];
          // Zera tenantId (MTA não pertence a empresa fixa)
          setFields['tenantId'] = null;
        } else if (currentRole === 'MULTI_TENANT_ADMIN') {
          // Rebaixamento de MTA (newRole já é outro role neste else): zera lista de tenants
          setFields['allowedTenantIds'] = [];
        }
      } else if (updates.allowedTenantIds !== undefined && currentRole === 'MULTI_TENANT_ADMIN') {
        // Atualiza allowedTenantIds sem mudar role (só faz sentido para MTA)
        setFields['allowedTenantIds'] = updates.allowedTenantIds;
      }

      if (Object.keys(setFields).length === 0) {
        return reply.status(200).send(safeUser(existingDoc));
      }

      const updated = (await db
        .collection('users')
        .findOneAndUpdate({ id, deleted: false }, { $set: setFields }, { returnDocument: 'after' })) as unknown as UserDoc | null;
      if (!updated) throw new NotFoundError();

      request.log.info({ userId: id, role: updated.role }, 'usuário atualizado (SUPER_ADMIN)');
      return reply.status(200).send(safeUser(updated));
    }

    // Roles normais (TENANT_ADMIN, MTA): usam TenantRepository escopado ao tenant.
    // MTA: o tenant alvo precisa vir via ?tenantId (∈ allowedTenantIds). Sem ele,
    // resolveTenantId lança NotFoundError (não vaza cross-tenant). Fora da lista
    // → NotFoundError. TENANT_ADMIN: tenant vem do token.
    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
    const effectiveTenantId = resolveTenantId(request, tenantIdParam, true);
    const tenantId = effectiveTenantId as string;

    // TENANT_ADMIN e MTA não podem promover ninguém a MULTI_TENANT_ADMIN
    // (papel sem empresa, criado/gerido apenas por SUPER_ADMIN).
    if (updates.role === 'MULTI_TENANT_ADMIN') {
      throw new ConflictError('Apenas SUPER_ADMIN pode atribuir o papel MULTI_TENANT_ADMIN');
    }

    const usersRepo = new TenantRepository<UserDoc>(db.collection('users'), { tenantId });

    // allowedTenantIds é gerenciado somente via endpoints /admin/multi-tenant-admins
    // para roles não-SUPER_ADMIN; removemos do objeto de update.
    const { allowedTenantIds: _ignored, ...safeUpdates } = updates;
    const updated = await usersRepo.updateById(
      id,
      removeUndefined(safeUpdates) as Parameters<typeof usersRepo.updateById>[1],
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
    requireRole(request, ...ADMIN_ROLES);

    // MTA: tenant alvo via ?tenantId (∈ allowedTenantIds). Sem ele → NotFoundError
    // (resolveTenantId write path) — não vaza cross-tenant. Fora da lista → 404.
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
 * Busca um usuário pelo ID respeitando o escopo de tenant do solicitante.
 *
 * - SUPER_ADMIN: busca global (sem filtro de tenant).
 * - SUPER_ADMIN com `?tenantId`: restringe ao tenant informado.
 * - MULTI_TENANT_ADMIN sem `?tenantId`: restringe a `{ tenantId: { $in: allowedTenantIds } }`.
 * - MULTI_TENANT_ADMIN com `?tenantId` válido (∈ allowedTenantIds): só aquele tenant;
 *   fora da lista → lança NotFoundError (404, nunca 403).
 * - Roles normais: restringe ao tenant do token.
 *
 * Retorna `null` quando o usuário não existe no escopo (caller deve mapear para 404).
 */
async function findUserInScope(
  db: Db,
  request: FastifyRequest,
  id: string,
  explicitTenantId: string | undefined,
): Promise<UserDoc | null> {
  const ctx = resolveTenantContext(request, { explicitTenantId, write: false });

  const filter: Record<string, unknown> = { id, deleted: false };
  if (ctx.mode === 'single') {
    filter['tenantId'] = ctx.tenantId;
  } else if (ctx.mode === 'allowed') {
    filter['tenantId'] = { $in: ctx.tenantIds };
  }
  // ctx.mode === 'all' (SUPER_ADMIN sem filtro): sem restrição de tenant.

  return (await db.collection('users').findOne(filter)) as unknown as UserDoc | null;
}

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
