import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { TenantRepository, newId } from '@dmdoc/db-mongo';
import type { TenantDocument } from '@dmdoc/db-mongo';
import type { User } from '@dmdoc/shared-types';
import { ADMIN_ROLES } from '@dmdoc/shared-types';
import { NotFoundError } from '../errors/index.js';
import { requireRole } from '../auth/role-guard.js';
import { resolveTenantContext } from '../auth/resolve-tenant.js';
import { AuditLogger } from '../auth/audit.js';

interface UserDoc extends TenantDocument {
  email: string;
  passwordHash: string;
  name: string;
  role: User['role'];
  active: boolean;
  createdAt: Date;
}

interface DepartmentDoc extends TenantDocument {
  parentId: string | null;
  name: string;
  level: number;
  tags: string[];
  createdAt: Date;
}

const PutPermissionsBodySchema = z.object({
  permissions: z.array(
    z.object({
      departmentId: z.string().uuid(),
      canRead: z.boolean(),
      canWrite: z.boolean(),
    })
  ),
});

const TenantIdQuerySchema = z.object({
  tenantId: z.string().uuid().optional(), // SUPER_ADMIN apenas
});

/**
 * Rotas de permissões usuário × departamento.
 *
 * GET: retorna permissões atuais do usuário (qualquer role autenticada).
 *   SUPER_ADMIN sem tenantId: busca globalmente por userId (sem filtro de tenant).
 *   SUPER_ADMIN com tenantId: busca no tenant especificado.
 *
 * PUT: substitui TODAS as permissões do usuário (TENANT_ADMIN / SUPER_ADMIN).
 *   SUPER_ADMIN: tenantId obrigatório via query param.
 */
export const permissionsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /users/:id/permissions — lista permissões do usuário.
   *
   * SUPER_ADMIN sem ?tenantId: busca global por userId, sem filtro de tenant.
   * SUPER_ADMIN com ?tenantId: verifica usuário no tenant e filtra permissões.
   * Outros roles: sempre no próprio tenant.
   */
  app.get('/users/:id/permissions', { preHandler: app.authenticate }, async (request, reply) => {
    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
    const ctx = resolveTenantContext(request, { explicitTenantId: tenantIdParam, write: false });
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const db = app.db;

    // Resolve o tenant efetivo do usuário-alvo conforme o escopo do solicitante.
    // Para MTA sem ?tenantId (mode 'allowed') localizamos o usuário entre os
    // allowedTenantIds e usamos o tenantId dele para escopar as permissões.
    let permissionTenantId: string | null;

    if (ctx.mode === 'single') {
      // Verifica que o usuário existe no tenant escopado.
      const usersRepo = new TenantRepository<UserDoc>(db.collection('users'), { tenantId: ctx.tenantId });
      const user = await usersRepo.findById(id);
      if (!user) throw new NotFoundError();
      permissionTenantId = ctx.tenantId;
    } else if (ctx.mode === 'allowed') {
      const user = (await db
        .collection('users')
        .findOne({ id, tenantId: { $in: ctx.tenantIds }, deleted: false })) as unknown as UserDoc | null;
      if (!user) throw new NotFoundError();
      permissionTenantId = user.tenantId;
    } else {
      // SUPER_ADMIN sem filtro: busca global por userId.
      const user = await db.collection('users').findOne({ id, deleted: false });
      if (!user) throw new NotFoundError();
      permissionTenantId = null;
    }

    const permFilter: Record<string, unknown> = { userId: id, deleted: false };
    if (permissionTenantId !== null) permFilter['tenantId'] = permissionTenantId;

    const permissions = await db.collection('department_permissions').find(permFilter).toArray();

    const result = permissions.map(stripMongoId).map((p) => ({
      departmentId: (p as { departmentId: string }).departmentId,
      canRead: (p as { canRead: boolean }).canRead,
      canWrite: (p as { canWrite: boolean }).canWrite,
    }));

    return reply.status(200).send({ permissions: result });
  });

  /**
   * PUT /users/:id/permissions — substitui todas as permissões do usuário.
   *
   * 1. Verifica usuário existe no tenant.
   * 2. Valida todos os departmentIds existem no tenant.
   * 3. Deleta as permissões atuais.
   * 4. Insere as novas.
   *
   * SUPER_ADMIN: tenantId obrigatório via ?tenantId.
   */
  app.put('/users/:id/permissions', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, ...ADMIN_ROLES);

    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
    // write: true exige tenant explícito para SUPER_ADMIN e MULTI_TENANT_ADMIN.
    // MTA com ?tenantId ∈ allowedTenantIds → mode 'single'; fora da lista → 404.
    // SA/MTA sem ?tenantId → erro (mode nunca cai em 'single'). O usuário-alvo e
    // todos os departamentos são validados contra o tenant resolvido abaixo.
    const ctx = resolveTenantContext(request, { explicitTenantId: tenantIdParam, write: true });
    /* c8 ignore next */
    if (ctx.mode !== 'single') throw new NotFoundError();
    const tenantId = ctx.tenantId;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { permissions } = PutPermissionsBodySchema.parse(request.body);
    const db = app.db;

    // Verificar usuário
    const usersRepo = new TenantRepository<UserDoc>(db.collection('users'), { tenantId });
    const user = await usersRepo.findById(id);
    if (!user) throw new NotFoundError();

    // Verificar cada departamento existe no tenant
    const deptsRepo = new TenantRepository<DepartmentDoc>(
      db.collection('departments'),
      { tenantId }
    );
    for (const perm of permissions) {
      const dept = await deptsRepo.findById(perm.departmentId);
      if (!dept) throw new NotFoundError(`Departamento ${perm.departmentId} não encontrado`);
    }

    // Substituição completa: deleta atuais e insere novas
    await db
      .collection('department_permissions')
      .deleteMany({ userId: id, tenantId });

    if (permissions.length > 0) {
      await db.collection('department_permissions').insertMany(
        permissions.map((p) => ({
          id: newId(),
          tenantId,
          userId: id,
          departmentId: p.departmentId,
          canRead: p.canRead,
          canWrite: p.canWrite,
          deleted: false,
        }))
      );
    }

    // Retornar lista atualizada
    const updated = await db
      .collection('department_permissions')
      .find({ userId: id, tenantId, deleted: false })
      .toArray();

    const result = updated.map(stripMongoId).map((p) => ({
      departmentId: (p as { departmentId: string }).departmentId,
      canRead: (p as { canRead: boolean }).canRead,
      canWrite: (p as { canWrite: boolean }).canWrite,
    }));

    // AuditLog de mudança de permissão (spec §10, invariante 7 — Fase 5)
    const auditLogger = new AuditLogger(db);
    try {
      await auditLogger.record({
        tenantId,
        userId: request.user!.sub,
        action: 'permission.update',
        resource: `users/${id}/permissions`,
        metadata: {
          targetUserId: id,
          permissionCount: permissions.length,
          departmentIds: permissions.map((p) => p.departmentId),
        },
      });
    } catch (auditError) {
      request.log.error(
        { err: auditError, tenantId, userId: id },
        'falha ao registrar audit log de mudança de permissão'
      );
    }

    request.log.info({ tenantId, userId: id }, 'permissões atualizadas');
    return reply.status(200).send({ permissions: result });
  });
};

function stripMongoId(doc: Record<string, unknown>): Record<string, unknown> {
  const { _id: _ignored, ...rest } = doc;
  return rest;
}
