import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { TenantRepository } from '@dmdoc/db-mongo';
import type { TenantDocument } from '@dmdoc/db-mongo';
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
  // Querystrings chegam como string. `writable=true` ativa o filtro de escrita
  // (seletor de upload); qualquer outro valor (ou ausência) mantém o
  // comportamento de gestão (lista todos os departamentos do escopo).
  writable: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
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
 * DELETE exclui logicamente apenas o departamento; documentos e permissões
 * vinculados são preservados.
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
    const { tenantId: tenantIdParam, writable } = ListDepartmentsQuerySchema.parse(request.query);
    const db = app.db;
    const role = request.user?.role;

    let items: DepartmentDoc[];

    if (role === 'SUPER_ADMIN') {
      const filter: Record<string, unknown> = { deleted: false };
      if (tenantIdParam !== undefined) filter['tenantId'] = tenantIdParam;

      items = (await db
        .collection('departments')
        .find(filter)
        .sort({ level: 1, name: 1 })
        .limit(1000)
        .toArray()) as unknown as DepartmentDoc[];
    } else if (role === 'MULTI_TENANT_ADMIN') {
      // MTA sem tenantId explícito: retorna departamentos de todos os tenants
      // da lista allowedTenantIds. Com tenantId explícito: resolveTenantContext
      // valida que está na lista e retorna mode:'single'.
      const context = resolveTenantContext(request, { explicitTenantId: tenantIdParam, write: false });
      const filter: Record<string, unknown> = { deleted: false };

      if (context.mode === 'single') {
        filter['tenantId'] = context.tenantId;
      } else {
        // mode: 'allowed' — filtra por $in sobre os tenants permitidos
        const allowedTenantIds = request.user?.allowedTenantIds ?? [];
        filter['tenantId'] = { $in: allowedTenantIds };
      }

      items = (await db
        .collection('departments')
        .find(filter)
        .sort({ level: 1, name: 1 })
        .limit(1000)
        .toArray()) as unknown as DepartmentDoc[];
    } else {
      const tenantId = request.tenantId;
      // tenantId deve ser sempre uma string UUID para roles não-SUPER_ADMIN/MTA.
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

    // Filtro de ESCRITA (?writable=true) — superfície do seletor de upload.
    // Retorna apenas departamentos em que o ator pode escrever (wiki "Permissões
    // por departamento (ACL)" → seção "Seletor de departamento no upload"):
    //   - Admin (TENANT_ADMIN / SUPER_ADMIN / MULTI_TENANT_ADMIN): sem restrição
    //     de ACL — `resolveAccessibleDepartmentIds` retorna `null` e mantemos
    //     todos os departamentos ATIVOS do escopo já carregados em `items`.
    //   - UPLOADER / USER: subárvore expandida das raízes concedidas; sem raiz
    //     concedida → conjunto vazio → resposta `[]` (200, não erro).
    // `items` já está restrito a `deleted: false`, então a interseção com o
    // conjunto acessível resulta apenas em departamentos ATIVOS — destino válido
    // de upload (um soft-deletado dentro da subárvore concedida não aparece).
    // Sem `writable`, o endpoint mantém o comportamento de gestão (lista tudo).
    if (writable) {
      const userId = request.user?.sub;
      if (typeof userId !== 'string') {
        throw new Error('userId ausente no contexto da request');
      }
      const accessible = await resolveAccessibleDepartmentIds(
        db,
        userId,
        request.tenantId ?? null,
        role ?? ''
      );
      if (accessible !== null) {
        const accessibleSet = new Set(accessible);
        items = items.filter((dept) => accessibleSet.has(dept.id));
      }
    }

    // Contagem direta de documentos por departamento. Os departmentIds já estão
    // escopados ao(s) tenant(s) permitido(s) acima, então o $in sobre eles é
    // intrinsecamente multi-tenant safe. Não é recursivo: conta apenas
    // documentos diretamente vinculados ao nó (departmentId == dept.id).
    const departmentIds = items.map((d) => d.id);
    const countMap = new Map<string, number>();

    if (departmentIds.length > 0) {
      const counts = (await db
        .collection('documents')
        .aggregate([
          { $match: { departmentId: { $in: departmentIds }, deleted: false } },
          { $group: { _id: '$departmentId', count: { $sum: 1 } } },
        ])
        .toArray()) as Array<{ _id: string; count: number }>;

      for (const { _id, count } of counts) {
        countMap.set(_id, count);
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
   * SUPER_ADMIN: informar `tenantId` no body (obrigatório).
   * Valida hierarquia (profundidade ilimitada).
   */
  app.post('/departments', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN', 'MULTI_TENANT_ADMIN');

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
    requireRole(request, 'TENANT_ADMIN', 'MULTI_TENANT_ADMIN');

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
   * DELETE /departments/:id — exclusão lógica somente do departamento.
   * SUPER_ADMIN: informar `?tenantId=xxx` (obrigatório).
   *
   * Marca apenas o departamento como `deleted: true`. Documentos e permissões
   * vinculados são PRESERVADOS (continuam `deleted: false`) para que documentos
   * já carregados não sumam e continuem encontráveis na busca e nas listagens
   * por quem tem `canRead`.
   *
   * Proíbe a deleção se houver sub-departamentos ativos (filhos diretos com
   * `deleted: false`) → ConflictError 409.
   */
  app.delete('/departments/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN', 'MULTI_TENANT_ADMIN');

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

    // Soft-delete apenas do departamento. Documentos e permissões vinculados
    // são intencionalmente preservados (continuam deleted: false).
    await repo.softDelete(id);

    request.log.info(
      { tenantId, departmentId: id },
      'departamento removido (soft delete); documentos e permissões preservados'
    );
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

