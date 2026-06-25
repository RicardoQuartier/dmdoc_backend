import type { FastifyPluginAsync } from 'fastify';
import type { Sql } from '@dmdoc/db-pg';
import { z } from 'zod';
import { TenantRepository, newId } from '@dmdoc/db-pg';
import type { IndexField } from '@dmdoc/shared-types';
import type { TenantDocument } from '@dmdoc/db-pg';
import { ForbiddenError, NotFoundError } from '../errors/index.js';
import { requireRole } from '../auth/role-guard.js';
import { resolveTenantContext, resolveTenantId } from '../auth/resolve-tenant.js';
import { ADMIN_ROLES } from '@dmdoc/shared-types';
import { resolveAccessibleDepartmentIds } from '../auth/department-access.js';

interface DocumentTypeDoc extends TenantDocument {
  name: string;
  description: string | null;
  isGlobal: boolean;
  createdAt: Date;
  indexFields: IndexField[];
  departmentIds?: string[];
}

interface DepartmentNameDoc {
  id: string;
  name: string;
}

const ListDocumentTypesQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
});

const CreateDocumentTypeBodySchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().nullable().default(null),
    tenantId: z.string().uuid().optional(),
    isGlobal: z.boolean().default(false),
    departmentIds: z.array(z.string().uuid()).min(1).optional(),
  })
  .superRefine((val, ctx) => {
    if (!val.isGlobal && (val.departmentIds === undefined || val.departmentIds.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['departmentIds'],
        message: 'departmentIds é obrigatório para tipos de empresa (isGlobal: false)',
      });
    }
  });

const PatchDocumentTypeBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  departmentIds: z.array(z.string().uuid()).min(1).optional(),
});

const CreateIndexFieldBodySchema = z.object({
  name: z.string().min(1).max(200),
  fieldType: z.enum(['TEXT', 'DATE', 'NUMBER']),
  required: z.boolean().default(false),
  aiExtractionHint: z.string().nullable().default(null),
  order: z.number().int().nonnegative().default(0),
  showOnSearch: z.boolean().default(true),
});

const PatchIndexFieldBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  fieldType: z.enum(['TEXT', 'DATE', 'NUMBER']).optional(),
  required: z.boolean().optional(),
  aiExtractionHint: z.string().nullable().optional(),
  order: z.number().int().nonnegative().optional(),
  showOnSearch: z.boolean().optional(),
});

const TenantIdQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
});

const SetGlobalTypeDeptConfigBodySchema = z.object({
  departmentIds: z.array(z.string().uuid()).min(1),
  tenantId: z.string().uuid().optional(),
});

type DocTypeRow = {
  id: string;
  tenant_id: string | null;
  name: string;
  description: string | null;
  is_global: boolean;
  created_at: Date;
  index_fields: IndexField[];
  department_ids: string[] | null;
  deleted: boolean;
};

function rowToDocType(r: DocTypeRow): DocumentTypeDoc {
  const base: DocumentTypeDoc = {
    id: r.id,
    tenantId: r.tenant_id ?? '',
    name: r.name,
    description: r.description,
    isGlobal: r.is_global,
    createdAt: r.created_at,
    indexFields: r.index_fields ?? [],
    deleted: r.deleted,
  };
  if (r.department_ids !== null && r.department_ids !== undefined) {
    base.departmentIds = r.department_ids;
  }
  return base;
}

/**
 * Rotas de CRUD de tipos de documento e seus campos de índice — PostgreSQL.
 */
export const documentTypesRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /document-types — lista tipos de documento.
   */
  app.get('/document-types', { preHandler: app.authenticate }, async (request, reply) => {
    const { tenantId: tenantIdParam } = ListDocumentTypesQuerySchema.parse(request.query);
    const sql = app.db;

    const ctx = resolveTenantContext(request, { explicitTenantId: tenantIdParam });
    const role = request.user?.role ?? '';
    const userId = request.user?.sub ?? '';

    let rows: DocTypeRow[];

    if (ctx.mode === 'all') {
      rows = await sql<DocTypeRow[]>`
        SELECT id, tenant_id, name, description, is_global, created_at, index_fields, department_ids, deleted
        FROM document_types
        WHERE deleted = false
        ORDER BY name ASC
      `;
    } else if (ctx.mode === 'allowed') {
      rows = await sql<DocTypeRow[]>`
        SELECT id, tenant_id, name, description, is_global, created_at, index_fields, department_ids, deleted
        FROM document_types
        WHERE deleted = false
          AND (
            tenant_id = ANY(${ctx.tenantIds}::uuid[])
            OR (is_global = true AND tenant_id IS NULL)
          )
        ORDER BY name ASC
      `;
    } else {
      const baseTenantId = ctx.tenantId;

      const accessibleDeptIds = await resolveAccessibleDepartmentIds(sql, userId, baseTenantId, role);

      if (accessibleDeptIds !== null) {
        // UPLOADER/USER: filtra por departamentos acessíveis
        // Tipos globais visíveis = aqueles com config cujos depts intersectem com os acessíveis
        const globalConfigs = await sql<Array<{ global_type_id: string; department_ids: string[] }>>`
          SELECT global_type_id, department_ids
          FROM global_type_tenant_depts
          WHERE tenant_id = ${baseTenantId}
            AND deleted = false
        `;

        const visibleGlobalIds = globalConfigs
          .filter((c) => c.department_ids.some((id) => accessibleDeptIds.includes(id)))
          .map((c) => c.global_type_id);

        if (visibleGlobalIds.length > 0) {
          rows = await sql<DocTypeRow[]>`
            SELECT id, tenant_id, name, description, is_global, created_at, index_fields, department_ids, deleted
            FROM document_types
            WHERE deleted = false
              AND (
                (is_global = true AND tenant_id IS NULL AND id = ANY(${visibleGlobalIds}::uuid[]))
                OR (tenant_id = ${baseTenantId} AND department_ids && ${accessibleDeptIds}::uuid[])
              )
            ORDER BY name ASC
          `;
        } else {
          rows = await sql<DocTypeRow[]>`
            SELECT id, tenant_id, name, description, is_global, created_at, index_fields, department_ids, deleted
            FROM document_types
            WHERE deleted = false
              AND tenant_id = ${baseTenantId}
              AND department_ids && ${accessibleDeptIds}::uuid[]
            ORDER BY name ASC
          `;
        }
      } else {
        // Admins: veem todos os tipos do tenant + globais
        rows = await sql<DocTypeRow[]>`
          SELECT id, tenant_id, name, description, is_global, created_at, index_fields, department_ids, deleted
          FROM document_types
          WHERE deleted = false
            AND (
              tenant_id = ${baseTenantId}
              OR (is_global = true AND tenant_id IS NULL)
            )
          ORDER BY name ASC
        `;
      }
    }

    const items = rows.map(rowToDocType);

    // Resolve nomes dos departamentos em batch
    const allDeptIds = new Set<string>();
    for (const item of items) {
      if (Array.isArray(item.departmentIds)) {
        for (const deptId of item.departmentIds) allDeptIds.add(deptId);
      }
    }

    const deptNameMap = new Map<string, string>();
    if (allDeptIds.size > 0) {
      const deptDocs = await sql<DepartmentNameDoc[]>`
        SELECT id, name
        FROM departments
        WHERE id = ANY(${[...allDeptIds]}::uuid[])
          AND deleted = false
      `;
      for (const dept of deptDocs) {
        deptNameMap.set(dept.id, dept.name);
      }
    }

    const enriched = items.map((item) => {
      const deptIds = item.departmentIds;
      const departments = Array.isArray(deptIds)
        ? deptIds.map((deptId) => ({ id: deptId, name: deptNameMap.get(deptId) ?? '' }))
        : [];
      return { ...item, departments };
    });

    return reply.status(200).send(enriched);
  });

  /**
   * POST /document-types — cria tipo de documento para o tenant.
   */
  app.post('/document-types', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, ...ADMIN_ROLES);

    const body = CreateDocumentTypeBodySchema.parse(request.body);
    const isSuperAdmin = request.user?.role === 'SUPER_ADMIN';
    const { name, description, departmentIds } = body;
    const sql = app.db;

    if (isSuperAdmin && body.isGlobal) {
      const id = newId();
      const now = new Date();
      await sql`
        INSERT INTO document_types (id, tenant_id, name, description, is_global, created_at, index_fields, department_ids, deleted)
        VALUES (${id}, NULL, ${name}, ${description ?? null}, true, ${now}, ${JSON.stringify([])}, NULL, false)
      `;
      request.log.info({ documentTypeId: id }, 'tipo de documento global criado');
      const enrichedGlobal = await enrichWithDepartments(
        { id, tenantId: null as unknown as string, name, description: description ?? null, isGlobal: true, createdAt: now, indexFields: [], deleted: false },
        sql
      );
      return reply.status(201).send(enrichedGlobal);
    }

    const effectiveTenantId = resolveTenantId(request, body.tenantId, true);
    const tenantId = effectiveTenantId as string;

    const resolvedDeptIds = departmentIds as string[];

    // Valida que todos os departmentIds existem e pertencem ao tenant
    const foundDepts = await sql<Array<{ count: string }>>`
      SELECT COUNT(*) AS count
      FROM departments
      WHERE id = ANY(${resolvedDeptIds}::uuid[])
        AND tenant_id = ${tenantId}
        AND deleted = false
    `;
    const foundCount = parseInt(foundDepts[0]?.count ?? '0', 10);
    if (foundCount !== resolvedDeptIds.length) {
      request.log.warn({ tenantId, departmentIds: resolvedDeptIds }, 'um ou mais departmentIds não encontrados no tenant');
      throw new NotFoundError();
    }

    const repo = new TenantRepository<DocumentTypeDoc>(sql, 'document_types', { tenantId });

    const docType = rowToDocType(await repo.insertOne({
      name,
      description: description ?? null,
      isGlobal: false,
      createdAt: new Date(),
      indexFields: [],
      departmentIds: resolvedDeptIds,
    }) as unknown as DocTypeRow);

    request.log.info({ tenantId, documentTypeId: docType.id }, 'tipo de documento criado');
    const enrichedDocType = await enrichWithDepartments(docType, sql);
    return reply.status(201).send(enrichedDocType);
  });

  /**
   * PATCH /document-types/:id — atualiza tipo de documento.
   */
  app.patch('/document-types/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, ...ADMIN_ROLES);

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const updates = PatchDocumentTypeBodySchema.parse(request.body);
    const sql = app.db;
    const isSuperAdmin = request.user?.role === 'SUPER_ADMIN';

    const existingRows = await sql<DocTypeRow[]>`
      SELECT id, tenant_id, name, description, is_global, created_at, index_fields, department_ids, deleted
      FROM document_types
      WHERE id = ${id}
        AND deleted = false
      LIMIT 1
    `;
    if (existingRows.length === 0) throw new NotFoundError();
    const doc = rowToDocType(existingRows[0]!);

    if (doc.isGlobal) {
      if (!isSuperAdmin) throw new ForbiddenError('Tipos globais só podem ser editados por SUPER_ADMIN');
      const { departmentIds: _ignored, ...globalUpdates } = updates;
      const clean = removeUndefined(globalUpdates);

      const setParts: string[] = [];
      const values: unknown[] = [id];
      let paramIdx = 2;

      if (clean.name !== undefined) { setParts.push(`name = $${paramIdx++}`); values.push(clean.name); }
      if ('description' in clean && clean.description !== undefined) { setParts.push(`description = $${paramIdx++}`); values.push(clean.description); }

      if (setParts.length === 0) {
        const enrichedNoOp = await enrichWithDepartments(doc, sql);
        return reply.status(200).send(enrichedNoOp);
      }

      const query = `UPDATE document_types SET ${setParts.join(', ')} WHERE id = $1 AND deleted = false RETURNING id, tenant_id, name, description, is_global, created_at, index_fields, department_ids, deleted`;
      const updRows = await sql.unsafe<DocTypeRow[]>(query, values as Parameters<typeof sql.unsafe>[1]);
      if (updRows.length === 0) throw new NotFoundError();

      request.log.info({ documentTypeId: id }, 'tipo de documento global atualizado');
      const enrichedGlobalPatch = await enrichWithDepartments(rowToDocType(updRows[0]!), sql);
      return reply.status(200).send(enrichedGlobalPatch);
    }

    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
    const effectiveTenantId = resolveTenantId(request, tenantIdParam, true);
    const tenantId = effectiveTenantId as string;

    if (updates.departmentIds !== undefined) {
      const deptIds = updates.departmentIds;
      const foundDepts = await sql<Array<{ count: string }>>`
        SELECT COUNT(*) AS count
        FROM departments
        WHERE id = ANY(${deptIds}::uuid[])
          AND tenant_id = ${tenantId}
          AND deleted = false
      `;
      const foundCount = parseInt(foundDepts[0]?.count ?? '0', 10);
      if (foundCount !== deptIds.length) {
        request.log.warn({ tenantId, documentTypeId: id, departmentIds: deptIds }, 'um ou mais departmentIds não encontrados no tenant');
        throw new NotFoundError();
      }
    }

    const repo = new TenantRepository<DocumentTypeDoc>(sql, 'document_types', { tenantId });
    const updated = await repo.updateById(id, removeUndefined(updates) as Parameters<typeof repo.updateById>[1]);
    if (!updated) throw new NotFoundError();

    request.log.info({ tenantId, documentTypeId: id }, 'tipo de documento atualizado');
    const enrichedUpdated = await enrichWithDepartments(rowToDocType(updated as unknown as DocTypeRow), sql);
    return reply.status(200).send(enrichedUpdated);
  });

  /**
   * DELETE /document-types/:id — soft-delete de tipo do tenant.
   */
  app.delete('/document-types/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, ...ADMIN_ROLES);

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const sql = app.db;
    const isSuperAdmin = request.user?.role === 'SUPER_ADMIN';

    const existingRows = await sql<DocTypeRow[]>`
      SELECT id, tenant_id, is_global, deleted
      FROM document_types
      WHERE id = ${id}
        AND deleted = false
      LIMIT 1
    `;
    if (existingRows.length === 0) throw new NotFoundError();
    const doc = existingRows[0]!;

    if (doc.is_global) {
      if (!isSuperAdmin) throw new ForbiddenError('Tipos globais não podem ser excluídos por tenants');
      await sql`UPDATE document_types SET deleted = true WHERE id = ${id}`;
      request.log.info({ documentTypeId: id }, 'tipo de documento global removido');
      return reply.status(204).send();
    }

    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
    const effectiveTenantId = resolveTenantId(request, tenantIdParam, true);
    const tenantId = effectiveTenantId as string;

    const repo = new TenantRepository<DocumentTypeDoc>(sql, 'document_types', { tenantId });
    const deleted = await repo.softDelete(id);
    if (!deleted) throw new NotFoundError();

    request.log.info({ tenantId, documentTypeId: id }, 'tipo de documento removido');
    return reply.status(204).send();
  });

  /**
   * POST /document-types/:id/index-fields — adiciona campo ao tipo.
   */
  app.post(
    '/document-types/:id/index-fields',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, ...ADMIN_ROLES);

      const { id } = z.object({ id: z.string() }).parse(request.params);
      const fieldInput = CreateIndexFieldBodySchema.parse(request.body);
      const sql = app.db;
      const isSuperAdmin = request.user?.role === 'SUPER_ADMIN';

      const existingRows = await sql<DocTypeRow[]>`
        SELECT id, tenant_id, name, description, is_global, created_at, index_fields, department_ids, deleted
        FROM document_types
        WHERE id = ${id}
          AND deleted = false
        LIMIT 1
      `;
      if (existingRows.length === 0) throw new NotFoundError();
      const docType = rowToDocType(existingRows[0]!);
      if (docType.isGlobal && !isSuperAdmin) throw new ForbiddenError('Tipos globais só podem ser editados por SUPER_ADMIN');

      const tenantIdFilter = docType.isGlobal
        ? null
        : (() => {
            const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
            return resolveTenantId(request, tenantIdParam, true) as string;
          })();

      const newField: IndexField = {
        id: newId(),
        name: fieldInput.name,
        fieldType: fieldInput.fieldType,
        required: fieldInput.required,
        aiExtractionHint: fieldInput.aiExtractionHint,
        order: fieldInput.order,
        showOnSearch: fieldInput.showOnSearch,
        deleted: false,
      };

      const currentFields = docType.indexFields ?? [];
      const newFields = [...currentFields, newField];

      let updRows: DocTypeRow[];
      if (docType.isGlobal) {
        updRows = await sql<DocTypeRow[]>`
          UPDATE document_types
          SET index_fields = ${JSON.stringify(newFields)}
          WHERE id = ${id}
            AND deleted = false
          RETURNING id, tenant_id, name, description, is_global, created_at, index_fields, department_ids, deleted
        `;
      } else {
        updRows = await sql<DocTypeRow[]>`
          UPDATE document_types
          SET index_fields = ${JSON.stringify(newFields)}
          WHERE id = ${id}
            AND tenant_id = ${tenantIdFilter}
            AND deleted = false
          RETURNING id, tenant_id, name, description, is_global, created_at, index_fields, department_ids, deleted
        `;
      }

      if (updRows.length === 0) throw new NotFoundError();

      request.log.info({ documentTypeId: id, fieldId: newField.id }, 'campo de índice adicionado');
      return reply.status(200).send(rowToDocType(updRows[0]!));
    }
  );

  /**
   * PATCH /document-types/:id/index-fields/:fieldId — atualiza campo.
   */
  app.patch(
    '/document-types/:id/index-fields/:fieldId',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, ...ADMIN_ROLES);

      const { id, fieldId } = z
        .object({ id: z.string(), fieldId: z.string() })
        .parse(request.params);
      const fieldUpdates = PatchIndexFieldBodySchema.parse(request.body);
      const sql = app.db;
      const isSuperAdmin = request.user?.role === 'SUPER_ADMIN';

      const existingRows = await sql<DocTypeRow[]>`
        SELECT id, tenant_id, name, description, is_global, created_at, index_fields, department_ids, deleted
        FROM document_types
        WHERE id = ${id}
          AND deleted = false
        LIMIT 1
      `;
      if (existingRows.length === 0) throw new NotFoundError();
      const docType = rowToDocType(existingRows[0]!);
      if (docType.isGlobal && !isSuperAdmin) throw new ForbiddenError('Tipos globais só podem ser editados por SUPER_ADMIN');

      const tenantIdFilter = docType.isGlobal
        ? null
        : (() => {
            const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
            return resolveTenantId(request, tenantIdParam, true) as string;
          })();

      const currentFields: IndexField[] = docType.indexFields ?? [];
      const fieldIdx = currentFields.findIndex((f) => f.id === fieldId && !f.deleted);
      if (fieldIdx === -1) throw new NotFoundError();

      const updatedFields = currentFields.map((f, i) =>
        i === fieldIdx ? { ...f, ...removeUndefined(fieldUpdates as Record<string, unknown>) } : f
      );

      let updRows: DocTypeRow[];
      if (docType.isGlobal) {
        updRows = await sql<DocTypeRow[]>`
          UPDATE document_types
          SET index_fields = ${JSON.stringify(updatedFields)}
          WHERE id = ${id}
            AND deleted = false
          RETURNING id, tenant_id, name, description, is_global, created_at, index_fields, department_ids, deleted
        `;
      } else {
        updRows = await sql<DocTypeRow[]>`
          UPDATE document_types
          SET index_fields = ${JSON.stringify(updatedFields)}
          WHERE id = ${id}
            AND tenant_id = ${tenantIdFilter}
            AND deleted = false
          RETURNING id, tenant_id, name, description, is_global, created_at, index_fields, department_ids, deleted
        `;
      }

      if (updRows.length === 0) throw new NotFoundError();

      request.log.info({ documentTypeId: id, fieldId }, 'campo de índice atualizado');
      return reply.status(200).send(rowToDocType(updRows[0]!));
    }
  );

  /**
   * GET /document-types/:id/dept-config
   */
  app.get(
    '/document-types/:id/dept-config',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, ...ADMIN_ROLES);

      const { id } = z.object({ id: z.string() }).parse(request.params);
      const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
      const sql = app.db;

      const existingRows = await sql<Array<{ id: string; is_global: boolean }>>`
        SELECT id, is_global FROM document_types WHERE id = ${id} AND deleted = false LIMIT 1
      `;
      if (existingRows.length === 0) throw new NotFoundError();
      if (!existingRows[0]!.is_global) throw new NotFoundError();

      const effectiveTenantId = resolveTenantId(request, tenantIdParam, true);
      const tenantId = effectiveTenantId as string;

      type ConfigRow = { id: string; global_type_id: string; tenant_id: string; department_ids: string[]; deleted: boolean; created_at: Date; updated_at: Date };
      const configRows = await sql<ConfigRow[]>`
        SELECT id, global_type_id, tenant_id, department_ids, deleted, created_at, updated_at
        FROM global_type_tenant_depts
        WHERE global_type_id = ${id}
          AND tenant_id = ${tenantId}
          AND deleted = false
        LIMIT 1
      `;

      if (configRows.length === 0) return reply.status(200).send(null);

      const r = configRows[0]!;
      return reply.status(200).send({ id: r.id, globalTypeId: r.global_type_id, tenantId: r.tenant_id, departmentIds: r.department_ids, createdAt: r.created_at, updatedAt: r.updated_at });
    }
  );

  /**
   * PUT /document-types/:id/dept-config
   */
  app.put(
    '/document-types/:id/dept-config',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, ...ADMIN_ROLES);

      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = SetGlobalTypeDeptConfigBodySchema.parse(request.body);
      const sql = app.db;

      const existingRows = await sql<Array<{ id: string; is_global: boolean }>>`
        SELECT id, is_global FROM document_types WHERE id = ${id} AND deleted = false LIMIT 1
      `;
      if (existingRows.length === 0) throw new NotFoundError();
      if (!existingRows[0]!.is_global) throw new NotFoundError();

      const effectiveTenantId = resolveTenantId(request, body.tenantId, true);
      const tenantId = effectiveTenantId as string;

      const { departmentIds } = body;
      const foundDepts = await sql<Array<{ count: string }>>`
        SELECT COUNT(*) AS count
        FROM departments
        WHERE id = ANY(${departmentIds}::uuid[])
          AND tenant_id = ${tenantId}
          AND deleted = false
      `;
      const foundCount = parseInt(foundDepts[0]?.count ?? '0', 10);
      if (foundCount !== departmentIds.length) {
        request.log.warn({ tenantId, globalTypeId: id, departmentIds }, 'um ou mais departmentIds não encontrados no tenant');
        throw new NotFoundError();
      }

      const now = new Date();
      const configId = newId();

      // UPSERT
      type ConfigRow = { id: string; global_type_id: string; tenant_id: string; department_ids: string[]; deleted: boolean; created_at: Date; updated_at: Date };
      const upsertRows = await sql<ConfigRow[]>`
        INSERT INTO global_type_tenant_depts (id, global_type_id, tenant_id, department_ids, deleted, created_at, updated_at)
        VALUES (${configId}, ${id}, ${tenantId}, ${departmentIds}, false, ${now}, ${now})
        ON CONFLICT (global_type_id, tenant_id)
        DO UPDATE SET department_ids = EXCLUDED.department_ids, updated_at = EXCLUDED.updated_at, deleted = false
        RETURNING id, global_type_id, tenant_id, department_ids, deleted, created_at, updated_at
      `;

      const r = upsertRows[0]!;
      request.log.info({ tenantId, globalTypeId: id, departmentIds }, 'config de departamentos para tipo global atualizada');
      return reply.status(200).send({ id: r.id, globalTypeId: r.global_type_id, tenantId: r.tenant_id, departmentIds: r.department_ids, createdAt: r.created_at, updatedAt: r.updated_at });
    }
  );

  /**
   * DELETE /document-types/:id/dept-config
   */
  app.delete(
    '/document-types/:id/dept-config',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, ...ADMIN_ROLES);

      const { id } = z.object({ id: z.string() }).parse(request.params);
      const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
      const sql = app.db;

      const existingRows = await sql<Array<{ id: string; is_global: boolean }>>`
        SELECT id, is_global FROM document_types WHERE id = ${id} AND deleted = false LIMIT 1
      `;
      if (existingRows.length === 0) throw new NotFoundError();
      if (!existingRows[0]!.is_global) throw new NotFoundError();

      const effectiveTenantId = resolveTenantId(request, tenantIdParam, true);
      const tenantId = effectiveTenantId as string;

      const result = await sql`
        UPDATE global_type_tenant_depts
        SET deleted = true, updated_at = NOW()
        WHERE global_type_id = ${id}
          AND tenant_id = ${tenantId}
          AND deleted = false
      `;

      if (result.count === 0) throw new NotFoundError();

      request.log.info({ tenantId, globalTypeId: id }, 'config de departamentos para tipo global removida');
      return reply.status(204).send();
    }
  );

  /**
   * DELETE /document-types/:id/index-fields/:fieldId — soft-delete do campo.
   */
  app.delete(
    '/document-types/:id/index-fields/:fieldId',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, ...ADMIN_ROLES);

      const { id, fieldId } = z
        .object({ id: z.string(), fieldId: z.string() })
        .parse(request.params);
      const sql = app.db;
      const isSuperAdmin = request.user?.role === 'SUPER_ADMIN';

      const existingRows = await sql<DocTypeRow[]>`
        SELECT id, tenant_id, name, description, is_global, created_at, index_fields, department_ids, deleted
        FROM document_types
        WHERE id = ${id}
          AND deleted = false
        LIMIT 1
      `;
      if (existingRows.length === 0) throw new NotFoundError();
      const docType = rowToDocType(existingRows[0]!);
      if (docType.isGlobal && !isSuperAdmin) throw new ForbiddenError('Tipos globais só podem ser editados por SUPER_ADMIN');

      const tenantIdFilter = docType.isGlobal
        ? null
        : (() => {
            const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
            return resolveTenantId(request, tenantIdParam, true) as string;
          })();

      const currentFields: IndexField[] = docType.indexFields ?? [];
      const fieldIdx = currentFields.findIndex((f) => f.id === fieldId);
      if (fieldIdx === -1) throw new NotFoundError();

      const updatedFields = currentFields.map((f, i) =>
        i === fieldIdx ? { ...f, deleted: true } : f
      );

      let updRows: DocTypeRow[];
      if (docType.isGlobal) {
        updRows = await sql<DocTypeRow[]>`
          UPDATE document_types
          SET index_fields = ${JSON.stringify(updatedFields)}
          WHERE id = ${id}
            AND deleted = false
          RETURNING id, tenant_id, name, description, is_global, created_at, index_fields, department_ids, deleted
        `;
      } else {
        updRows = await sql<DocTypeRow[]>`
          UPDATE document_types
          SET index_fields = ${JSON.stringify(updatedFields)}
          WHERE id = ${id}
            AND tenant_id = ${tenantIdFilter}
            AND deleted = false
          RETURNING id, tenant_id, name, description, is_global, created_at, index_fields, department_ids, deleted
        `;
      }

      if (updRows.length === 0) throw new NotFoundError();

      request.log.info({ documentTypeId: id, fieldId }, 'campo de índice removido (soft delete)');
      return reply.status(200).send(rowToDocType(updRows[0]!));
    }
  );
};

function removeUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
}

async function enrichWithDepartments(
  doc: DocumentTypeDoc,
  sql: Sql
): Promise<Record<string, unknown>> {
  const deptIds = doc.departmentIds;

  if (!Array.isArray(deptIds) || deptIds.length === 0) {
    return { ...doc, departments: [] };
  }

  const deptDocs = await sql<DepartmentNameDoc[]>`
    SELECT id, name
    FROM departments
    WHERE id = ANY(${deptIds}::uuid[])
      AND deleted = false
  `;

  const nameMap = new Map<string, string>(deptDocs.map((d) => [d.id, d.name]));
  const departments = deptIds.map((deptId) => ({ id: deptId, name: nameMap.get(deptId) ?? '' }));

  return { ...doc, departments };
}
