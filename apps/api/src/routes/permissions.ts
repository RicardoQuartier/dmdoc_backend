import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { TenantRepository, newId } from '@dmdoc/db-mongo';
import type { TenantDocument } from '@dmdoc/db-mongo';
import type { User } from '@dmdoc/shared-types';
import { ADMIN_ROLES } from '@dmdoc/shared-types';
import { NotFoundError, ValidationError } from '../errors/index.js';
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
  rootDepartmentIds: z.array(z.string().uuid()),
});

const TenantIdQuerySchema = z.object({
  tenantId: z.string().uuid().optional(), // SUPER_ADMIN apenas
});

/**
 * Rotas de permissões usuário × departamento (ACL por raiz, Fase 6).
 *
 * O acesso é concedido por DEPARTAMENTO RAIZ (nível 0, `parentId: null`).
 * Conceder uma raiz dá acesso de leitura E escrita a toda a subárvore (herança
 * dinâmica — a expansão acontece em tempo de leitura/escrita, não é
 * materializada). Cada doc de `department_permissions` representa uma raiz
 * concedida, com `canRead = canWrite = true`.
 *
 * GET: retorna as raízes concedidas do usuário (`{ rootDepartmentIds }`).
 *   SUPER_ADMIN sem tenantId: busca globalmente por userId (sem filtro de tenant).
 *   SUPER_ADMIN com tenantId: busca no tenant especificado.
 *
 * PUT: substitui TODAS as concessões do usuário (TENANT_ADMIN / SUPER_ADMIN).
 *   SUPER_ADMIN: tenantId obrigatório via query param.
 */
export const permissionsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /users/:id/permissions — lista as raízes concedidas do usuário.
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

    const permFilter: Record<string, unknown> = { userId: id, deleted: false, canRead: true };
    if (permissionTenantId !== null) permFilter['tenantId'] = permissionTenantId;

    const permissions = await db.collection('department_permissions').find(permFilter).toArray();

    const rootDepartmentIds = permissions.map(
      (p) => (p as unknown as { departmentId: string }).departmentId
    );

    return reply.status(200).send({ rootDepartmentIds });
  });

  /**
   * PUT /users/:id/permissions — substitui todas as concessões do usuário.
   *
   * Body: `{ rootDepartmentIds: string[] }`.
   *
   * 1. Verifica usuário existe no tenant.
   * 2. Valida cada id: existe no tenant E é RAIZ (`parentId: null` / nível 0).
   *    - id inexistente no tenant → 404 (mantém invariante de isolamento).
   *    - id existe mas não é raiz → 422 VALIDATION_ERROR.
   * 3. Deleta as concessões atuais.
   * 4. Insere uma concessão por raiz com `canRead = canWrite = true`.
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
    const { rootDepartmentIds } = PutPermissionsBodySchema.parse(request.body);
    const db = app.db;

    // Deduplicar para não inserir concessões repetidas da mesma raiz.
    const uniqueRootIds = [...new Set(rootDepartmentIds)];

    // Verificar usuário
    const usersRepo = new TenantRepository<UserDoc>(db.collection('users'), { tenantId });
    const user = await usersRepo.findById(id);
    if (!user) throw new NotFoundError();

    // Verificar cada departamento: existe no tenant E é raiz (parentId: null).
    //   - inexistente → 404 (invariante de isolamento)
    //   - existe mas não é raiz → 422 VALIDATION_ERROR
    const deptsRepo = new TenantRepository<DepartmentDoc>(
      db.collection('departments'),
      { tenantId }
    );
    for (const departmentId of uniqueRootIds) {
      const dept = await deptsRepo.findById(departmentId);
      if (!dept) throw new NotFoundError(`Departamento ${departmentId} não encontrado`);
      if (dept.parentId !== null) {
        throw new ValidationError(
          `Departamento ${departmentId} não é uma raiz (nível 0); apenas raízes podem ser concedidas`
        );
      }
    }

    // Substituição completa: deleta atuais e insere uma por raiz (canRead=canWrite=true).
    await db
      .collection('department_permissions')
      .deleteMany({ userId: id, tenantId });

    if (uniqueRootIds.length > 0) {
      await db.collection('department_permissions').insertMany(
        uniqueRootIds.map((departmentId) => ({
          id: newId(),
          tenantId,
          userId: id,
          departmentId,
          canRead: true,
          canWrite: true,
          deleted: false,
        }))
      );
    }

    // Retornar lista atualizada das raízes concedidas
    const updated = await db
      .collection('department_permissions')
      .find({ userId: id, tenantId, deleted: false, canRead: true })
      .toArray();

    const updatedRootDepartmentIds = updated.map(
      (p) => (p as unknown as { departmentId: string }).departmentId
    );

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
          permissionCount: uniqueRootIds.length,
          rootDepartmentIds: uniqueRootIds,
        },
      });
    } catch (auditError) {
      request.log.error(
        { err: auditError, tenantId, userId: id },
        'falha ao registrar audit log de mudança de permissão'
      );
    }

    request.log.info({ tenantId, userId: id }, 'permissões atualizadas');
    return reply.status(200).send({ rootDepartmentIds: updatedRootDepartmentIds });
  });
};
