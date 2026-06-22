import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { TenantRepository, assertUserScopeInvariant, validateUserDocument } from '@dmdoc/db-pg';
import type { User, Role } from '@dmdoc/shared-types';
import { ADMIN_ROLES, isGlobalRole } from '@dmdoc/shared-types';
import type { TenantDocument } from '@dmdoc/db-pg';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors/index.js';
import { requireRole, requireCanManageRole } from '../auth/role-guard.js';
import { hashPassword } from '../auth/password.js';
import { resolveTenantContext, resolveTenantId } from '../auth/resolve-tenant.js';
import { AuditLogger } from '../auth/audit.js';

interface UserDoc extends TenantDocument {
  email: string;
  passwordHash: string;
  name: string;
  role: User['role'];
  active: boolean;
  createdAt: Date;
  allowedTenantIds?: string[];
}

const CreateUserBodySchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200),
  role: z.enum(['SUPER_ADMIN', 'MULTI_TENANT_ADMIN', 'TENANT_ADMIN', 'UPLOADER', 'USER']),
  password: z.string().min(8),
  active: z.boolean().default(true),
  tenantId: z.string().uuid().optional(),
  allowedTenantIds: z
    .array(z.string().uuid())
    .max(20, 'MULTI_TENANT_ADMIN suporta no máximo 20 tenants no MVP')
    .optional(),
});

const PatchUserBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  role: z
    .enum(['SUPER_ADMIN', 'MULTI_TENANT_ADMIN', 'TENANT_ADMIN', 'UPLOADER', 'USER'])
    .optional(),
  active: z.boolean().optional(),
  allowedTenantIds: z
    .array(z.string().uuid())
    .max(20, 'MULTI_TENANT_ADMIN suporta no máximo 20 tenants no MVP')
    .optional(),
});

const ResetPasswordBodySchema = z.object({
  newPassword: z.string().min(8),
});

const ListUsersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  tenantId: z.string().uuid().optional(),
});

const TenantIdQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
});

type UserRow = {
  id: string;
  tenant_id: string | null;
  email: string;
  password_hash: string;
  name: string;
  role: string;
  active: boolean;
  created_at: Date;
  deleted: boolean;
  allowed_tenant_ids: string[] | null;
};

function rowToUserDoc(r: UserRow): UserDoc {
  const doc: UserDoc = {
    id: r.id,
    tenantId: r.tenant_id ?? '',
    email: r.email,
    passwordHash: r.password_hash,
    name: r.name,
    role: r.role as UserDoc['role'],
    active: r.active,
    createdAt: r.created_at,
    deleted: r.deleted,
  };
  if (r.allowed_tenant_ids !== null && r.allowed_tenant_ids.length > 0) {
    doc.allowedTenantIds = r.allowed_tenant_ids;
  }
  return doc;
}

/**
 * Rotas de CRUD de usuários — PostgreSQL.
 */
export const usersRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /users — cria usuário no tenant.
   */
  app.post('/users', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, ...ADMIN_ROLES);

    const body = CreateUserBodySchema.parse(request.body);
    const sql = app.db;

    requireCanManageRole(request, body.role);

    if (isGlobalRole(body.role) && request.user?.role !== 'SUPER_ADMIN') {
      throw new ForbiddenError(
        'Apenas SUPER_ADMIN pode criar papéis globais (SUPER_ADMIN, MULTI_TENANT_ADMIN)',
      );
    }

    const passwordHash = await hashPassword(body.password);
    const newUserId = randomUUID();
    const createdAt = new Date();

    // Papéis GLOBAIS
    if (isGlobalRole(body.role)) {
      const { tenantId: tenantIdQuery } = TenantIdQuerySchema.parse(request.query);
      if (tenantIdQuery !== undefined || body.tenantId !== undefined) {
        throw new ForbiddenError(
          `Papel global ${body.role} não pode ser associado a um tenantId`,
        );
      }

      const allowedTenantIds =
        body.role === 'MULTI_TENANT_ADMIN' ? (body.allowedTenantIds ?? []) : [];

      const globalDoc = {
        id: newUserId,
        tenantId: null as string | null,
        email: body.email,
        name: body.name,
        role: body.role,
        active: body.active,
        passwordHash,
        createdAt,
        deleted: false,
        ...(body.role === 'MULTI_TENANT_ADMIN' ? { allowedTenantIds } : {}),
      };

      assertUserScopeInvariant({ role: globalDoc.role, tenantId: globalDoc.tenantId });
      validateUserDocument(globalDoc);

      try {
        await sql`
          INSERT INTO users (id, tenant_id, email, password_hash, name, role, active, created_at, deleted, allowed_tenant_ids)
          VALUES (
            ${newUserId},
            NULL,
            ${body.email},
            ${passwordHash},
            ${body.name},
            ${body.role},
            ${body.active},
            ${createdAt},
            false,
            ${allowedTenantIds}
          )
        `;
      } catch (err: unknown) {
        const pgErr = err as { code?: string };
        if (pgErr.code === '23505') {
          throw new ConflictError('E-mail já em uso');
        }
        throw err;
      }

      const safeGlobal = {
        id: newUserId,
        tenantId: null,
        email: body.email,
        name: body.name,
        role: body.role,
        active: body.active,
        createdAt,
        ...(body.role === 'MULTI_TENANT_ADMIN' ? { allowedTenantIds } : {}),
      };
      request.log.info({ userId: newUserId, role: body.role }, 'usuário global criado');
      return reply.status(201).send(safeGlobal);
    }

    // Papéis LOCAIS
    const { tenantId: tenantIdQuery } = TenantIdQuerySchema.parse(request.query);
    const explicitTenantId = tenantIdQuery ?? body.tenantId;
    const effectiveTenantId = resolveTenantId(request, explicitTenantId, true);
    const tenantId = effectiveTenantId as string;

    // Validação de cota
    const tenantRows = await sql<Array<{ user_quota: number }>>`
      SELECT user_quota FROM tenants WHERE id = ${tenantId} LIMIT 1
    `;
    if (tenantRows.length === 0) throw new NotFoundError('Empresa não encontrada');
    const userQuota = tenantRows[0]!.user_quota;

    const usersRepo = new TenantRepository<UserDoc>(sql, 'users', { tenantId });
    const count = await usersRepo.count({ active: true } as Partial<UserDoc>);
    if (count >= userQuota) {
      throw new ConflictError('Cota de usuários atingida');
    }

    const localRole = body.role as Exclude<Role, 'SUPER_ADMIN' | 'MULTI_TENANT_ADMIN'>;

    assertUserScopeInvariant({ role: localRole, tenantId });
    validateUserDocument({
      id: newUserId,
      tenantId,
      email: body.email,
      passwordHash,
      name: body.name,
      role: localRole,
      active: body.active,
      createdAt,
    });

    let user: UserDoc;
    try {
      user = await usersRepo.insertOne({
        id: newUserId,
        email: body.email,
        name: body.name,
        role: localRole,
        active: body.active,
        passwordHash,
        createdAt,
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        throw new ConflictError('E-mail já em uso nesta empresa');
      }
      throw err;
    }

    request.log.info({ tenantId, userId: user.id }, 'usuário criado');
    return reply.status(201).send(safeUser(user));
  });

  /**
   * GET /users — lista usuários.
   */
  app.get('/users', { preHandler: app.authenticate }, async (request, reply) => {
    const { limit, cursor, tenantId: tenantIdParam } = ListUsersQuerySchema.parse(request.query);
    const sql = app.db;

    const ctx = resolveTenantContext(request, { explicitTenantId: tenantIdParam, write: false });

    let items: ReturnType<typeof safeUser>[];
    let nextCursor: string | null;

    if (ctx.mode === 'single') {
      const tenantId = ctx.tenantId;
      const usersRepo = new TenantRepository<UserDoc>(sql, 'users', { tenantId });
      const pagination = cursor !== undefined ? { limit, cursor } : { limit };
      const page = await usersRepo.findMany({}, pagination);
      items = page.items.map(safeUser);
      nextCursor = page.nextCursor;
    } else {
      let rows: UserRow[];
      if (ctx.mode === 'allowed') {
        if (cursor !== undefined) {
          rows = await sql<UserRow[]>`
            SELECT id, tenant_id, email, password_hash, name, role, active, created_at, deleted, allowed_tenant_ids
            FROM users
            WHERE tenant_id = ANY(${ctx.tenantIds}::uuid[])
              AND deleted = false
              AND id > ${cursor}
            ORDER BY id ASC
            LIMIT ${limit + 1}
          `;
        } else {
          rows = await sql<UserRow[]>`
            SELECT id, tenant_id, email, password_hash, name, role, active, created_at, deleted, allowed_tenant_ids
            FROM users
            WHERE tenant_id = ANY(${ctx.tenantIds}::uuid[])
              AND deleted = false
            ORDER BY id ASC
            LIMIT ${limit + 1}
          `;
        }
      } else {
        // mode === 'all' (SUPER_ADMIN)
        if (cursor !== undefined) {
          rows = await sql<UserRow[]>`
            SELECT id, tenant_id, email, password_hash, name, role, active, created_at, deleted, allowed_tenant_ids
            FROM users
            WHERE deleted = false
              AND id > ${cursor}
            ORDER BY id ASC
            LIMIT ${limit + 1}
          `;
        } else {
          rows = await sql<UserRow[]>`
            SELECT id, tenant_id, email, password_hash, name, role, active, created_at, deleted, allowed_tenant_ids
            FROM users
            WHERE deleted = false
            ORDER BY id ASC
            LIMIT ${limit + 1}
          `;
        }
      }

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      nextCursor = hasMore && page.at(-1) ? page.at(-1)!.id : null;
      items = page.map((r) => safeUser(rowToUserDoc(r)));
    }

    return reply.status(200).send({ items, nextCursor });
  });

  /**
   * GET /users/:id
   */
  app.get('/users/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, ...ADMIN_ROLES);

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const sql = app.db;
    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);

    const user = await findUserInScope(sql, request, id, tenantIdParam);
    if (!user) throw new NotFoundError();

    return reply.status(200).send(safeUser(user));
  });

  /**
   * PATCH /users/:id
   */
  app.patch('/users/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, ...ADMIN_ROLES);

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const updates = PatchUserBodySchema.parse(request.body);
    const sql = app.db;

    const isSuperAdmin = request.user?.role === 'SUPER_ADMIN';

    if (isSuperAdmin) {
      const existingRows = await sql<UserRow[]>`
        SELECT id, tenant_id, email, password_hash, name, role, active, created_at, deleted, allowed_tenant_ids
        FROM users
        WHERE id = ${id}
          AND deleted = false
        LIMIT 1
      `;
      if (existingRows.length === 0) throw new NotFoundError();
      const existingDoc = rowToUserDoc(existingRows[0]!);

      const currentRole = existingDoc.role as Role;
      const newRole = updates.role;

      requireCanManageRole(request, currentRole);
      if (newRole !== undefined) requireCanManageRole(request, newRole);

      const setParts: string[] = [];
      const values: unknown[] = [id];
      let paramIdx = 2;

      if (updates.name !== undefined) { setParts.push(`name = $${paramIdx++}`); values.push(updates.name); }
      if (updates.active !== undefined) { setParts.push(`active = $${paramIdx++}`); values.push(updates.active); }

      let finalTenantId: string | null = existingDoc.tenantId as string | null;
      if (existingDoc.tenantId === '') finalTenantId = null;
      const finalRole: Role = newRole ?? currentRole;

      if (newRole !== undefined) {
        setParts.push(`role = $${paramIdx++}`);
        values.push(newRole);

        if (isGlobalRole(newRole)) {
          setParts.push(`tenant_id = $${paramIdx++}`);
          values.push(null);
          finalTenantId = null;

          if (newRole === 'MULTI_TENANT_ADMIN') {
            setParts.push(`allowed_tenant_ids = $${paramIdx++}`);
            values.push(updates.allowedTenantIds ?? existingDoc.allowedTenantIds ?? []);
          } else {
            setParts.push(`allowed_tenant_ids = $${paramIdx++}`);
            values.push([]);
          }
        } else {
          if (existingDoc.tenantId === null || existingDoc.tenantId === '') {
            const { tenantId: targetTenantId } = TenantIdQuerySchema.parse(request.query);
            if (targetTenantId === undefined) {
              throw new ConflictError('Rebaixar papel global para local exige ?tenantId de destino');
            }
            const tenantExists = await sql<Array<{ id: string }>>`SELECT id FROM tenants WHERE id = ${targetTenantId} LIMIT 1`;
            if (tenantExists.length === 0) throw new NotFoundError('Empresa não encontrada');
            setParts.push(`tenant_id = $${paramIdx++}`);
            values.push(targetTenantId);
            finalTenantId = targetTenantId;
          }
          if (currentRole === 'MULTI_TENANT_ADMIN') {
            setParts.push(`allowed_tenant_ids = $${paramIdx++}`);
            values.push([]);
          }
        }
      } else if (updates.allowedTenantIds !== undefined && currentRole === 'MULTI_TENANT_ADMIN') {
        setParts.push(`allowed_tenant_ids = $${paramIdx++}`);
        values.push(updates.allowedTenantIds);
      }

      if (setParts.length === 0) {
        return reply.status(200).send(safeUser(existingDoc));
      }

      assertUserScopeInvariant({ role: finalRole, tenantId: finalTenantId });

      const query = `
        UPDATE users
        SET ${setParts.join(', ')}
        WHERE id = $1
          AND deleted = false
        RETURNING id, tenant_id, email, password_hash, name, role, active, created_at, deleted, allowed_tenant_ids
      `;

      const updRows = await sql.unsafe<UserRow[]>(query, values as Parameters<typeof sql.unsafe>[1]);
      if (updRows.length === 0) throw new NotFoundError();

      const updated = rowToUserDoc(updRows[0]!);
      request.log.info({ userId: id, role: updated.role }, 'usuário atualizado (SUPER_ADMIN)');
      return reply.status(200).send(safeUser(updated));
    }

    // Roles normais
    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
    const effectiveTenantId = resolveTenantId(request, tenantIdParam, true);
    const tenantId = effectiveTenantId as string;

    const usersRepo = new TenantRepository<UserDoc>(sql, 'users', { tenantId });

    const target = await usersRepo.findById(id);
    if (!target) throw new NotFoundError();

    const currentRole = target.role as Role;
    const newRole = updates.role;

    requireCanManageRole(request, currentRole);
    if (newRole !== undefined) {
      requireCanManageRole(request, newRole);
      if (isGlobalRole(newRole)) {
        throw new ForbiddenError(
          'Não é possível atribuir papel global a um usuário escopado a uma empresa por esta rota',
        );
      }
    }

    const { allowedTenantIds: _ignored, ...safeUpdates } = updates;

    assertUserScopeInvariant({ role: newRole ?? currentRole, tenantId });

    const updated = await usersRepo.updateById(
      id,
      removeUndefined(safeUpdates) as Parameters<typeof usersRepo.updateById>[1],
    );
    if (!updated) throw new NotFoundError();

    request.log.info({ tenantId, userId: id }, 'usuário atualizado');
    return reply.status(200).send(safeUser(updated));
  });

  /**
   * DELETE /users/:id
   */
  app.delete('/users/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, ...ADMIN_ROLES);

    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
    const effectiveTenantId = resolveTenantId(request, tenantIdParam, true);
    const tenantId = effectiveTenantId as string;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const sql = app.db;

    const usersRepo = new TenantRepository<UserDoc>(sql, 'users', { tenantId });
    const deleted = await usersRepo.softDelete(id);
    if (!deleted) throw new NotFoundError();

    request.log.info({ tenantId, userId: id }, 'usuário removido (soft delete)');
    return reply.status(204).send();
  });

  /**
   * POST /users/:id/reset-password
   */
  app.post('/users/:id/reset-password', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, ...ADMIN_ROLES);

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { newPassword } = ResetPasswordBodySchema.parse(request.body);
    const sql = app.db;

    const isSuperAdmin = request.user?.role === 'SUPER_ADMIN';

    let target: UserDoc | null;
    let targetTenantId: string | null;

    if (isSuperAdmin) {
      const rows = await sql<UserRow[]>`
        SELECT id, tenant_id, email, password_hash, name, role, active, created_at, deleted, allowed_tenant_ids
        FROM users
        WHERE id = ${id}
          AND deleted = false
        LIMIT 1
      `;
      target = rows.length > 0 ? rowToUserDoc(rows[0]!) : null;
      targetTenantId = target?.tenantId ?? null;
      if (targetTenantId === '') targetTenantId = null;
    } else {
      const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
      const effectiveTenantId = resolveTenantId(request, tenantIdParam, true);
      const tenantId = effectiveTenantId as string;

      const usersRepo = new TenantRepository<UserDoc>(sql, 'users', { tenantId });
      target = await usersRepo.findById(id);
      targetTenantId = tenantId;
    }

    if (!target) throw new NotFoundError();

    requireCanManageRole(request, target.role as Role);

    const passwordHash = await hashPassword(newPassword);
    const updRows = await sql<UserRow[]>`
      UPDATE users
      SET password_hash = ${passwordHash}
      WHERE id = ${id}
        AND deleted = false
      RETURNING id, tenant_id, email, password_hash, name, role, active, created_at, deleted, allowed_tenant_ids
    `;
    if (updRows.length === 0) throw new NotFoundError();

    const auditLogger = new AuditLogger(sql);
    try {
      await auditLogger.record({
        tenantId: targetTenantId,
        userId: request.user!.sub,
        action: 'user.reset_password',
        resource: `users/${id}`,
        metadata: { targetUserId: id, targetRole: target.role },
      });
    } catch (auditError) {
      request.log.error(
        { err: auditError, tenantId: targetTenantId, userId: id },
        'falha ao registrar audit log de reset de senha',
      );
    }

    request.log.info(
      { tenantId: targetTenantId, userId: id, actorId: request.user!.sub },
      'senha redefinida por admin',
    );
    return reply.status(204).send();
  });
};

async function findUserInScope(
  sql: import('@dmdoc/db-pg').Sql,
  request: FastifyRequest,
  id: string,
  explicitTenantId: string | undefined,
): Promise<UserDoc | null> {
  const ctx = resolveTenantContext(request, { explicitTenantId, write: false });

  let rows: UserRow[];

  if (ctx.mode === 'single') {
    rows = await sql<UserRow[]>`
      SELECT id, tenant_id, email, password_hash, name, role, active, created_at, deleted, allowed_tenant_ids
      FROM users
      WHERE id = ${id}
        AND tenant_id = ${ctx.tenantId}
        AND deleted = false
      LIMIT 1
    `;
  } else if (ctx.mode === 'allowed') {
    rows = await sql<UserRow[]>`
      SELECT id, tenant_id, email, password_hash, name, role, active, created_at, deleted, allowed_tenant_ids
      FROM users
      WHERE id = ${id}
        AND tenant_id = ANY(${ctx.tenantIds}::uuid[])
        AND deleted = false
      LIMIT 1
    `;
  } else {
    // mode === 'all' (SUPER_ADMIN)
    rows = await sql<UserRow[]>`
      SELECT id, tenant_id, email, password_hash, name, role, active, created_at, deleted, allowed_tenant_ids
      FROM users
      WHERE id = ${id}
        AND deleted = false
      LIMIT 1
    `;
  }

  return rows.length > 0 ? rowToUserDoc(rows[0]!) : null;
}

function safeUser(user: UserDoc): Omit<UserDoc, 'passwordHash'> {
  const { passwordHash: _, ...safe } = user;
  return safe;
}

function removeUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
}
