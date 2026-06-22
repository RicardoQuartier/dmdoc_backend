import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { TenantRepository } from '@dmdoc/db-pg';
import type { TenantDocument } from '@dmdoc/db-pg';
import { ConflictError, NotFoundError } from '../errors/index.js';
import { requireRole } from '../auth/role-guard.js';
import { resolveTenantId, resolveTenantContext } from '../auth/resolve-tenant.js';
import { resolveAccessibleDepartmentIds } from '../auth/department-access.js';

interface DepartmentDoc extends TenantDocument {
  parentId: string | null;
  name: string;
  level: number;
  tags: string[];
  createdAt: Date;
}

const ListDepartmentsQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
  writable: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

const CreateDepartmentBodySchema = z.object({
  name: z.string().min(1).max(200),
  parentId: z.string().uuid().nullable().default(null),
  tags: z.array(z.string()).default([]),
  tenantId: z.string().uuid().optional(),
});

const PatchDepartmentBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  tags: z.array(z.string()).optional(),
});

const TenantIdQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
});

/**
 * Rotas de CRUD de departamentos — PostgreSQL.
 */
export const departmentsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /departments — retorna departamentos em array plano ordenado.
   */
  app.get('/departments', { preHandler: app.authenticate }, async (request, reply) => {
    const { tenantId: tenantIdParam, writable } = ListDepartmentsQuerySchema.parse(request.query);
    const sql = app.db;
    const role = request.user?.role;

    type DeptRow = {
      id: string;
      tenant_id: string;
      parent_id: string | null;
      name: string;
      level: number;
      tags: string[];
      created_at: Date;
      deleted: boolean;
    };

    const aclTenantId =
      role === 'SUPER_ADMIN' || role === 'MULTI_TENANT_ADMIN'
        ? tenantIdParam ?? null
        : (request.tenantId as string | null) ?? null;

    let rows: DeptRow[];

    if (role === 'SUPER_ADMIN') {
      if (tenantIdParam !== undefined) {
        rows = await sql<DeptRow[]>`
          SELECT id, tenant_id, parent_id, name, level, tags, created_at, deleted
          FROM departments
          WHERE tenant_id = ${tenantIdParam}
            AND deleted = false
          ORDER BY level ASC, name ASC
          LIMIT 1000
        `;
      } else {
        rows = await sql<DeptRow[]>`
          SELECT id, tenant_id, parent_id, name, level, tags, created_at, deleted
          FROM departments
          WHERE deleted = false
          ORDER BY level ASC, name ASC
          LIMIT 1000
        `;
      }
    } else if (role === 'MULTI_TENANT_ADMIN') {
      const context = resolveTenantContext(request, { explicitTenantId: tenantIdParam, write: false });

      if (context.mode === 'single') {
        rows = await sql<DeptRow[]>`
          SELECT id, tenant_id, parent_id, name, level, tags, created_at, deleted
          FROM departments
          WHERE tenant_id = ${context.tenantId}
            AND deleted = false
          ORDER BY level ASC, name ASC
          LIMIT 1000
        `;
      } else {
        const allowedTenantIds = request.user?.allowedTenantIds ?? [];
        rows = await sql<DeptRow[]>`
          SELECT id, tenant_id, parent_id, name, level, tags, created_at, deleted
          FROM departments
          WHERE tenant_id = ANY(${allowedTenantIds}::uuid[])
            AND deleted = false
          ORDER BY level ASC, name ASC
          LIMIT 1000
        `;
      }
    } else {
      const tenantId = request.tenantId;
      if (typeof tenantId !== 'string') {
        throw new Error('tenantId ausente no contexto da request');
      }
      rows = await sql<DeptRow[]>`
        SELECT id, tenant_id, parent_id, name, level, tags, created_at, deleted
        FROM departments
        WHERE tenant_id = ${tenantId}
          AND deleted = false
        ORDER BY level ASC, name ASC
        LIMIT 1000
      `;
    }

    let items = rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      parentId: r.parent_id,
      name: r.name,
      level: r.level,
      tags: r.tags,
      createdAt: r.created_at,
      deleted: r.deleted,
    })) as (DepartmentDoc & { documentCount?: number })[];

    // Filtro de ESCRITA
    if (writable) {
      const userId = request.user?.sub;
      if (typeof userId !== 'string') {
        throw new Error('userId ausente no contexto da request');
      }
      const accessible = await resolveAccessibleDepartmentIds(
        sql,
        userId,
        aclTenantId,
        role ?? ''
      );
      if (accessible !== null) {
        const accessibleSet = new Set(accessible);
        items = items.filter((dept) => accessibleSet.has(dept.id));
      }
    }

    // Contagem de documentos por departamento
    const departmentIds = items.map((d) => d.id);
    const countMap = new Map<string, number>();

    if (departmentIds.length > 0) {
      const counts = await sql<Array<{ department_id: string; count: string }>>`
        SELECT department_id, COUNT(*) AS count
        FROM documents
        WHERE department_id = ANY(${departmentIds}::uuid[])
          AND deleted = false
        GROUP BY department_id
      `;
      for (const { department_id, count } of counts) {
        countMap.set(department_id, parseInt(count, 10));
      }
    }

    const itemsWithCount = items.map((dept) => ({
      ...dept,
      documentCount: countMap.get(dept.id) ?? 0,
    }));

    return reply.status(200).send(itemsWithCount);
  });

  /**
   * POST /departments — cria departamento.
   */
  app.post('/departments', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN', 'MULTI_TENANT_ADMIN');

    const body = CreateDepartmentBodySchema.parse(request.body);
    const effectiveTenantId = resolveTenantId(request, body.tenantId, true);
    const tenantId = effectiveTenantId as string;

    const { name, parentId, tags } = body;
    const sql = app.db;

    const repo = new TenantRepository<DepartmentDoc>(sql, 'departments', { tenantId });

    let level = 0;

    if (parentId !== null) {
      const parent = await repo.findById(parentId);
      if (!parent) throw new NotFoundError('Departamento pai não encontrado');
      level = parent.level + 1;
    }

    const dept = await repo.insertOne({
      parentId,
      name,
      level,
      tags,
      createdAt: new Date(),
    });

    request.log.info({ tenantId, departmentId: dept.id }, 'departamento criado');
    return reply.status(201).send(dept);
  });

  /**
   * PATCH /departments/:id — atualiza nome ou tags do departamento.
   */
  app.patch('/departments/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN', 'MULTI_TENANT_ADMIN');

    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
    const effectiveTenantId = resolveTenantId(request, tenantIdParam, true);
    const tenantId = effectiveTenantId as string;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const updates = PatchDepartmentBodySchema.parse(request.body);
    const sql = app.db;

    const repo = new TenantRepository<DepartmentDoc>(sql, 'departments', { tenantId });
    const updated = await repo.updateById(
      id,
      removeUndefined(updates) as Parameters<typeof repo.updateById>[1]
    );
    if (!updated) throw new NotFoundError();

    request.log.info({ tenantId, departmentId: id }, 'departamento atualizado');
    return reply.status(200).send(updated);
  });

  /**
   * DELETE /departments/:id — exclusão lógica somente do departamento.
   */
  app.delete('/departments/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN', 'MULTI_TENANT_ADMIN');

    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
    const effectiveTenantId = resolveTenantId(request, tenantIdParam, true);
    const tenantId = effectiveTenantId as string;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const sql = app.db;

    const repo = new TenantRepository<DepartmentDoc>(sql, 'departments', { tenantId });

    const dept = await repo.findById(id);
    if (!dept) throw new NotFoundError();

    const childCount = await repo.count({ parentId: id } as Partial<DepartmentDoc>);
    if (childCount > 0) {
      throw new ConflictError('Departamento possui sub-departamentos ativos');
    }

    await repo.softDelete(id);

    request.log.info(
      { tenantId, departmentId: id },
      'departamento removido (soft delete); documentos e permissões preservados'
    );
    return reply.status(204).send();
  });
};

export type { DepartmentDoc };

function removeUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
}
