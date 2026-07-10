import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { newId } from '@dmdoc/db-pg';
import type { User } from '@dmdoc/shared-types';
import { ADMIN_ROLES } from '@dmdoc/shared-types';
import { NotFoundError, ValidationError } from '../errors/index.js';
import { requireRole } from '../auth/role-guard.js';
import { resolveTenantContext } from '../auth/resolve-tenant.js';
import { AuditLogger } from '../auth/audit.js';

interface UserRow {
  id: string;
  tenant_id: string | null;
  role: User['role'];
}

interface DepartmentRow {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  deleted: boolean;
}

interface PermissionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  department_id: string;
  can_read: boolean;
  can_write: boolean;
  deleted: boolean;
}

const PutPermissionsBodySchema = z.object({
  rootDepartmentIds: z.array(z.string().uuid()),
});

const TenantIdQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
});

/**
 * Rotas de permissões usuário × departamento — PostgreSQL.
 */
export const permissionsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /users/:id/permissions — lista as raízes concedidas do usuário.
   */
  app.get('/users/:id/permissions', { preHandler: app.authenticate }, async (request, reply) => {
    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
    const ctx = resolveTenantContext(request, { explicitTenantId: tenantIdParam, write: false });
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const sql = app.db;

    let permissionTenantId: string | null;

    if (ctx.mode === 'single') {
      const userRows = await sql<UserRow[]>`
        SELECT id, tenant_id, role
        FROM users
        WHERE id = ${id}
          AND tenant_id = ${ctx.tenantId}
          AND deleted = false
        LIMIT 1
      `;
      if (userRows.length === 0) throw new NotFoundError();
      permissionTenantId = ctx.tenantId;
    } else if (ctx.mode === 'allowed') {
      const userRows = await sql<UserRow[]>`
        SELECT id, tenant_id, role
        FROM users
        WHERE id = ${id}
          AND tenant_id = ANY(${ctx.tenantIds}::uuid[])
          AND deleted = false
        LIMIT 1
      `;
      if (userRows.length === 0) throw new NotFoundError();
      permissionTenantId = userRows[0]!.tenant_id;
    } else {
      // SUPER_ADMIN sem filtro: busca global por userId
      const userRows = await sql<UserRow[]>`
        SELECT id, tenant_id, role
        FROM users
        WHERE id = ${id}
          AND deleted = false
        LIMIT 1
      `;
      if (userRows.length === 0) throw new NotFoundError();
      permissionTenantId = null;
    }

    let permRows: PermissionRow[];

    if (permissionTenantId !== null) {
      permRows = await sql<PermissionRow[]>`
        SELECT id, tenant_id, user_id, department_id, can_read, can_write, deleted
        FROM department_permissions
        WHERE user_id = ${id}
          AND tenant_id = ${permissionTenantId}
          AND deleted = false
          AND can_read = true
      `;
    } else {
      permRows = await sql<PermissionRow[]>`
        SELECT id, tenant_id, user_id, department_id, can_read, can_write, deleted
        FROM department_permissions
        WHERE user_id = ${id}
          AND deleted = false
          AND can_read = true
      `;
    }

    const rootDepartmentIds = permRows.map((p) => p.department_id);

    return reply.status(200).send({ rootDepartmentIds });
  });

  /**
   * PUT /users/:id/permissions — substitui todas as concessões do usuário.
   */
  app.put('/users/:id/permissions', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, ...ADMIN_ROLES);

    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
    const ctx = resolveTenantContext(request, { explicitTenantId: tenantIdParam, write: true });
    /* c8 ignore next */
    if (ctx.mode !== 'single') throw new NotFoundError();
    const tenantId = ctx.tenantId;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { rootDepartmentIds } = PutPermissionsBodySchema.parse(request.body);
    const sql = app.db;

    const uniqueRootIds = [...new Set(rootDepartmentIds)];

    // Verificar usuário
    const userRows = await sql<UserRow[]>`
      SELECT id, tenant_id, role
      FROM users
      WHERE id = ${id}
        AND tenant_id = ${tenantId}
        AND deleted = false
      LIMIT 1
    `;
    if (userRows.length === 0) throw new NotFoundError();

    // Verificar cada departamento: existe no tenant E é raiz (parent_id IS NULL).
    for (const departmentId of uniqueRootIds) {
      const deptRows = await sql<DepartmentRow[]>`
        SELECT id, tenant_id, parent_id, deleted
        FROM departments
        WHERE id = ${departmentId}
          AND tenant_id = ${tenantId}
          AND deleted = false
        LIMIT 1
      `;
      if (deptRows.length === 0) throw new NotFoundError(`Departamento ${departmentId} não encontrado`);
      if (deptRows[0]!.parent_id !== null) {
        throw new ValidationError(
          `Departamento ${departmentId} não é uma raiz (nível 0); apenas raízes podem ser concedidas`,
        );
      }
    }

    // Substituição completa: soft-delete das atuais e inserção das novas
    await sql`
      UPDATE department_permissions
      SET deleted = true
      WHERE user_id = ${id}
        AND tenant_id = ${tenantId}
        AND deleted = false
    `;

    if (uniqueRootIds.length > 0) {
      for (const departmentId of uniqueRootIds) {
        // Upsert: reativa a concessão caso já exista uma linha (o índice único
        // uniq_dept_perm_user_dept é sobre (user_id, department_id) e não
        // considera `deleted`, então a linha soft-deletada acima ainda ocupa o
        // par e um INSERT puro colidiria com ela — 23505).
        await sql`
          INSERT INTO department_permissions (id, tenant_id, user_id, department_id, can_read, can_write, deleted)
          VALUES (${newId()}, ${tenantId}, ${id}, ${departmentId}, true, true, false)
          ON CONFLICT (user_id, department_id)
          DO UPDATE SET
            deleted = false,
            can_read = true,
            can_write = true,
            tenant_id = EXCLUDED.tenant_id
        `;
      }
    }

    // Retornar lista atualizada
    const updatedRows = await sql<PermissionRow[]>`
      SELECT department_id
      FROM department_permissions
      WHERE user_id = ${id}
        AND tenant_id = ${tenantId}
        AND deleted = false
        AND can_read = true
    `;

    const updatedRootDepartmentIds = updatedRows.map((p) => p.department_id);

    // AuditLog
    const auditLogger = new AuditLogger(sql);
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
        'falha ao registrar audit log de mudança de permissão',
      );
    }

    request.log.info({ tenantId, userId: id }, 'permissões atualizadas');
    return reply.status(200).send({ rootDepartmentIds: updatedRootDepartmentIds });
  });
};
