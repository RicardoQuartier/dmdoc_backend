import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { TenantRepository } from '@dmdoc/db-mongo';
import type { TenantDocument } from '@dmdoc/db-mongo';
import { ConflictError, NotFoundError } from '../errors/index.js';
import { requireRole } from '../auth/role-guard.js';
import { resolveTenantId } from '../auth/resolve-tenant.js';

interface DepartmentDoc extends TenantDocument {
  parentId: string | null;
  name: string;
  level: number;
  tags: string[];
  createdAt: Date;
}

const ListDepartmentsQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
});

const CreateDepartmentBodySchema = z.object({
  name: z.string().min(1).max(200),
  parentId: z.string().uuid().nullable().default(null),
  tags: z.array(z.string()).default([]),
  tenantId: z.string().uuid().optional(), // SUPER_ADMIN apenas
});

const PatchDepartmentBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  tags: z.array(z.string()).optional(),
});

const TenantIdQuerySchema = z.object({
  tenantId: z.string().uuid().optional(), // SUPER_ADMIN apenas
});

/**
 * Rotas de CRUD de departamentos.
 *
 * GET retorna array plano ordenado (raízes primeiro, filhos depois).
 * DELETE faz cascade soft-delete de documentos e permissões vinculados.
 *
 * SUPER_ADMIN: informa tenantId via body (POST) ou ?tenantId (PATCH, DELETE).
 */
export const departmentsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /departments — retorna departamentos em array plano ordenado.
   *
   * SUPER_ADMIN: vê todos os tenants. `?tenantId=xxx` filtra por empresa.
   * Demais roles: sempre escopadas ao próprio tenant.
   */
  app.get('/departments', { preHandler: app.authenticate }, async (request, reply) => {
    const { tenantId: tenantIdParam } = ListDepartmentsQuerySchema.parse(request.query);
    const db = app.db;
    const isSuperAdmin = request.user?.role === 'SUPER_ADMIN';

    let items: DepartmentDoc[];

    if (isSuperAdmin) {
      const filter: Record<string, unknown> = { deleted: false };
      if (tenantIdParam !== undefined) filter['tenantId'] = tenantIdParam;

      items = (await db
        .collection('departments')
        .find(filter)
        .sort({ level: 1, name: 1 })
        .limit(1000)
        .toArray()) as unknown as DepartmentDoc[];
    } else {
      const tenantId = request.tenantId;
      // tenantId deve ser sempre uma string UUID para roles não-SUPER_ADMIN.
      // A checagem explícita protege contra execuções fora do fluxo normal de
      // autenticação e evita que uma query sem tenantId vaze dados de todos os
      // tenants (BSON serializa `undefined` descartando a chave do filtro).
      if (typeof tenantId !== 'string') {
        throw new Error('tenantId ausente no contexto da request');
      }

      items = (await db
        .collection('departments')
        .find({ tenantId, deleted: false })
        .sort({ level: 1, name: 1 })
        .limit(1000)
        .toArray()) as unknown as DepartmentDoc[];
    }

    return reply.status(200).send(items);
  });

  /**
   * POST /departments — cria departamento.
   * SUPER_ADMIN: informar `tenantId` no body (obrigatório).
   * Valida hierarquia e profundidade máxima.
   */
  app.post('/departments', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN');

    const body = CreateDepartmentBodySchema.parse(request.body);
    const effectiveTenantId = resolveTenantId(request, body.tenantId, true);
    const tenantId = effectiveTenantId as string;

    const { name, parentId, tags } = body;
    const db = app.db;

    const repo = new TenantRepository<DepartmentDoc>(db.collection('departments'), { tenantId });

    let level = 0;

    if (parentId !== null) {
      const parent = await repo.findById(parentId);
      if (!parent) throw new NotFoundError('Departamento pai não encontrado');
      level = parent.level + 1;
      if (level > 3) {
        throw new ConflictError('Profundidade máxima de 4 níveis atingida');
      }
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
   * SUPER_ADMIN: informar `?tenantId=xxx` (obrigatório).
   */
  app.patch('/departments/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN');

    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
    const effectiveTenantId = resolveTenantId(request, tenantIdParam, true);
    const tenantId = effectiveTenantId as string;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const updates = PatchDepartmentBodySchema.parse(request.body);
    const db = app.db;

    const repo = new TenantRepository<DepartmentDoc>(db.collection('departments'), { tenantId });
    const updated = await repo.updateById(
      id,
      removeUndefined(updates) as Parameters<typeof repo.updateById>[1]
    );
    if (!updated) throw new NotFoundError();

    request.log.info({ tenantId, departmentId: id }, 'departamento atualizado');
    return reply.status(200).send(updated);
  });

  /**
   * DELETE /departments/:id — cascade soft-delete.
   * SUPER_ADMIN: informar `?tenantId=xxx` (obrigatório).
   *
   * Proíbe deleção se houver sub-departamentos ativos.
   * Propaga soft-delete para documentos e permissões vinculadas.
   */
  app.delete('/departments/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN');

    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
    const effectiveTenantId = resolveTenantId(request, tenantIdParam, true);
    const tenantId = effectiveTenantId as string;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const db = app.db;

    const repo = new TenantRepository<DepartmentDoc>(db.collection('departments'), { tenantId });

    // Verificar se o departamento existe no tenant
    const dept = await repo.findById(id);
    if (!dept) throw new NotFoundError();

    // Verificar sub-departamentos ativos
    const childCount = await repo.count({ parentId: id } as Parameters<typeof repo.count>[0]);
    if (childCount > 0) {
      throw new ConflictError('Departamento possui sub-departamentos ativos');
    }

    // Soft-delete do departamento
    await repo.softDelete(id);

    // Cascade: soft-delete de documentos do departamento
    await db
      .collection('documents')
      .updateMany(
        { tenantId, departmentId: id, deleted: false },
        { $set: { deleted: true } }
      );

    // Cascade: soft-delete de permissões do departamento
    await db
      .collection('department_permissions')
      .updateMany({ departmentId: id }, { $set: { deleted: true } });

    request.log.info({ tenantId, departmentId: id }, 'departamento removido (soft delete)');
    return reply.status(204).send();
  });
};

// Exportação de tipo para uso em outros módulos (ex: permissions)
export type { DepartmentDoc };

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

