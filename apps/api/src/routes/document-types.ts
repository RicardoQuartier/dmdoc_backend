import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Sql } from '@dmdoc/db-pg';
import { z } from 'zod';
import { TenantRepository, newId } from '@dmdoc/db-pg';
import type { IndexField } from '@dmdoc/shared-types';
import type { TenantDocument } from '@dmdoc/db-pg';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors/index.js';
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
  // Quando informado, o catálogo é escopado a ESTE departamento para TODOS os
  // papéis (inclusive admins), reproduzindo `resolveDepartmentDocumentTypeCatalog`
  // (globais visíveis ao dept + tipos da empresa associados ao dept). Sem ele, o
  // comportamento por papel documentado é preservado (admin vê todos + globais).
  departmentId: z.string().uuid().optional(),
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

/**
 * Linha de `document_types` — NÃO inclui mais `index_fields` (coluna JSONB
 * legada/congelada, ver comentário em `schema.ts`). Os campos de índice são
 * lidos separadamente de `document_type_index_fields` (fonte de verdade),
 * ver `IndexFieldDbRow` e `fetchIndexFields*` abaixo.
 */
type DocTypeRow = {
  id: string;
  tenant_id: string | null;
  name: string;
  description: string | null;
  is_global: boolean;
  created_at: Date;
  department_ids: string[] | null;
  deleted: boolean;
};

/** Linha de `document_type_index_fields` (tabela normalizada, fonte de verdade). */
type IndexFieldDbRow = {
  id: string;
  document_type_id: string;
  name: string;
  field_type: 'TEXT' | 'DATE' | 'NUMBER';
  required: boolean;
  ai_extraction_hint: string | null;
  sort_order: number;
  show_on_search: boolean;
  deleted: boolean;
};

function indexFieldRowToIndexField(r: IndexFieldDbRow): IndexField {
  return {
    id: r.id,
    name: r.name,
    fieldType: r.field_type,
    required: r.required,
    aiExtractionHint: r.ai_extraction_hint,
    order: r.sort_order,
    showOnSearch: r.show_on_search,
    deleted: r.deleted,
  };
}

function rowToDocType(r: DocTypeRow, indexFields: IndexField[]): DocumentTypeDoc {
  const base: DocumentTypeDoc = {
    id: r.id,
    tenantId: r.tenant_id ?? '',
    name: r.name,
    description: r.description,
    isGlobal: r.is_global,
    createdAt: r.created_at,
    indexFields,
    deleted: r.deleted,
  };
  if (r.department_ids !== null && r.department_ids !== undefined) {
    base.departmentIds = r.department_ids;
  }
  return base;
}

/**
 * Busca em lote os campos de índice de vários tipos de documento — evita N+1
 * em `GET /document-types`. Inclui entradas com `deleted: true` (o frontend
 * já filtra isso; mesmo comportamento de antes com o JSONB). Ordenado por
 * `sort_order ASC` — a ordem relativa dentro de cada grupo é preservada ao
 * agrupar por `document_type_id`.
 */
async function fetchIndexFieldsBatch(
  sql: Sql,
  documentTypeIds: string[]
): Promise<Map<string, IndexField[]>> {
  const map = new Map<string, IndexField[]>();
  if (documentTypeIds.length === 0) return map;

  const rows = await sql<IndexFieldDbRow[]>`
    SELECT id, document_type_id, name, field_type, required, ai_extraction_hint, sort_order, show_on_search, deleted
    FROM document_type_index_fields
    WHERE document_type_id = ANY(${documentTypeIds}::uuid[])
    ORDER BY sort_order ASC
  `;

  for (const row of rows) {
    const field = indexFieldRowToIndexField(row);
    const existing = map.get(row.document_type_id);
    if (existing) {
      existing.push(field);
    } else {
      map.set(row.document_type_id, [field]);
    }
  }

  return map;
}

/** Busca os campos de índice de um único tipo de documento, ordenados por `sort_order`. */
async function fetchIndexFields(sql: Sql, documentTypeId: string): Promise<IndexField[]> {
  const map = await fetchIndexFieldsBatch(sql, [documentTypeId]);
  return map.get(documentTypeId) ?? [];
}

/**
 * Valida o acesso da requisição a um tipo de documento antes de mexer em seus
 * campos de índice: tipos globais só podem ser editados por SUPER_ADMIN;
 * tipos de tenant precisam pertencer ao tenant resolvido da requisição — se
 * não pertencerem, é tratado como recurso inexistente (404, nunca 403,
 * seguindo o invariante de isolamento multi-tenant).
 */
function assertDocTypeAccess(
  docType: DocumentTypeDoc,
  request: FastifyRequest,
  isSuperAdmin: boolean
): void {
  if (docType.isGlobal) {
    if (!isSuperAdmin) {
      throw new ForbiddenError('Tipos globais só podem ser editados por SUPER_ADMIN');
    }
    return;
  }

  const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
  const tenantId = resolveTenantId(request, tenantIdParam, true) as string;
  if (docType.tenantId !== tenantId) {
    throw new NotFoundError();
  }
}

/**
 * Rotas de CRUD de tipos de documento e seus campos de índice — PostgreSQL.
 */
export const documentTypesRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /document-types — lista tipos de documento.
   */
  app.get('/document-types', { preHandler: app.authenticate }, async (request, reply) => {
    const { tenantId: tenantIdParam, departmentId } = ListDocumentTypesQuerySchema.parse(
      request.query
    );
    const sql = app.db;

    const ctx = resolveTenantContext(request, { explicitTenantId: tenantIdParam });
    const role = request.user?.role ?? '';
    const userId = request.user?.sub ?? '';

    let rows: DocTypeRow[];

    if (departmentId !== undefined) {
      // Escopo por departamento — mesma regra de `resolveDepartmentDocumentTypeCatalog`
      // (helper compartilhado com o worker). Vale para TODOS os papéis: fecha o
      // vazamento em que admins recebiam tipos de qualquer departamento do tenant.

      // Resolve o tenant do departamento, respeitando o isolamento do contexto.
      let deptRows: Array<{ tenant_id: string }>;
      if (ctx.mode === 'single') {
        deptRows = await sql<Array<{ tenant_id: string }>>`
          SELECT tenant_id FROM departments
          WHERE id = ${departmentId} AND tenant_id = ${ctx.tenantId} LIMIT 1
        `;
      } else if (ctx.mode === 'allowed') {
        deptRows = await sql<Array<{ tenant_id: string }>>`
          SELECT tenant_id FROM departments
          WHERE id = ${departmentId} AND tenant_id = ANY(${ctx.tenantIds}::uuid[]) LIMIT 1
        `;
      } else {
        deptRows = await sql<Array<{ tenant_id: string }>>`
          SELECT tenant_id FROM departments WHERE id = ${departmentId} LIMIT 1
        `;
      }

      // Departamento inexistente ou fora do escopo → 404 (nunca 403).
      if (deptRows.length === 0) {
        throw new NotFoundError('Departamento não encontrado');
      }
      const scopeTenantId = deptRows[0]!.tenant_id;

      // UPLOADER/USER só podem consultar departamentos dentro da subárvore
      // concedida a eles — fora dela, 404 (mesmo invariante de ACL).
      const accessibleDeptIds = await resolveAccessibleDepartmentIds(
        sql,
        userId,
        scopeTenantId,
        role
      );
      if (accessibleDeptIds !== null && !accessibleDeptIds.includes(departmentId)) {
        throw new NotFoundError('Departamento não encontrado');
      }

      rows = await sql<DocTypeRow[]>`
        SELECT DISTINCT dt.id, dt.tenant_id, dt.name, dt.description, dt.is_global,
                        dt.created_at, dt.department_ids, dt.deleted
        FROM document_types dt
        WHERE dt.deleted = false
          AND (
            (
              dt.is_global = true
              AND dt.tenant_id IS NULL
              AND EXISTS (
                SELECT 1
                FROM global_type_tenant_depts g
                WHERE g.global_type_id = dt.id
                  AND g.tenant_id = ${scopeTenantId}
                  AND g.deleted = false
                  AND g.department_ids && ${[departmentId]}::uuid[]
              )
            )
            OR (
              dt.tenant_id = ${scopeTenantId}
              AND dt.department_ids && ${[departmentId]}::uuid[]
            )
          )
        ORDER BY dt.name ASC
      `;
    } else if (ctx.mode === 'all') {
      rows = await sql<DocTypeRow[]>`
        SELECT id, tenant_id, name, description, is_global, created_at, department_ids, deleted
        FROM document_types
        WHERE deleted = false
        ORDER BY name ASC
      `;
    } else if (ctx.mode === 'allowed') {
      rows = await sql<DocTypeRow[]>`
        SELECT id, tenant_id, name, description, is_global, created_at, department_ids, deleted
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
        // UPLOADER/USER — regra "Tipos de documento globais e por empresa"
        // (Visibilidade por papel): SEMPRE veem TODOS os tipos GLOBAIS (que não
        // têm associação com departamento e são visíveis a todos os papéis, sem
        // restrição) + os tipos da EMPRESA cujos `departmentIds` intersectem a
        // subárvore das raízes concedidas. Sem concessão (`accessibleDeptIds`
        // vazio), a interseção com tipos de empresa é vazia e restam só os
        // globais — comportamento documentado.
        //
        // NB: o escopo de tipos globais por departamento (`global_type_tenant_depts`)
        // vale apenas para a visão POR DEPARTAMENTO (query param `departmentId`
        // acima e catálogo de classificação por IA no worker), NÃO para esta
        // lista geral. Gatear os globais por aquela config aqui era a causa da
        // lista vazia para papéis não-admin.
        rows = await sql<DocTypeRow[]>`
          SELECT id, tenant_id, name, description, is_global, created_at, department_ids, deleted
          FROM document_types
          WHERE deleted = false
            AND (
              (is_global = true AND tenant_id IS NULL)
              OR (tenant_id = ${baseTenantId} AND department_ids && ${accessibleDeptIds}::uuid[])
            )
          ORDER BY name ASC
        `;
      } else {
        // Admins: veem todos os tipos do tenant + globais
        rows = await sql<DocTypeRow[]>`
          SELECT id, tenant_id, name, description, is_global, created_at, department_ids, deleted
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

    // Busca em lote os campos de índice de todos os tipos retornados (evita N+1).
    const indexFieldsMap = await fetchIndexFieldsBatch(sql, rows.map((r) => r.id));
    const items = rows.map((r) => rowToDocType(r, indexFieldsMap.get(r.id) ?? []));

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

    // Criar tipo GLOBAL é exclusivo do SUPER_ADMIN. Sem este gate, um
    // TENANT_ADMIN com `isGlobal: true` escapava da validação de `departmentIds`
    // (não exigida para globais) e caía adiante com `departmentIds` undefined,
    // estourando a query → 500. Autorização deve responder 403 explícito antes
    // de qualquer persistência (nenhum tipo global é criado por não-SA).
    if (body.isGlobal && !isSuperAdmin) {
      throw new ForbiddenError('Apenas SUPER_ADMIN pode criar tipos de documento globais');
    }

    const { name, description, departmentIds } = body;
    const sql = app.db;

    // Tipo nasce sem campos de índice — nada a inserir em
    // `document_type_index_fields` aqui. `index_fields` (JSONB legado) recebe
    // o default '[]' da coluna, sem escrita explícita.
    if (isSuperAdmin && body.isGlobal) {
      const id = newId();
      const now = new Date();
      try {
        await sql`
          INSERT INTO document_types (id, tenant_id, name, description, is_global, created_at, department_ids, deleted)
          VALUES (${id}, NULL, ${name}, ${description ?? null}, true, ${now}, NULL, false)
        `;
      } catch (err: unknown) {
        if ((err as { code?: string }).code === '23505') {
          throw new ConflictError(`Já existe um tipo de documento global chamado "${name}"`);
        }
        throw err;
      }
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

    let inserted: DocTypeRow;
    try {
      inserted = (await repo.insertOne({
        name,
        description: description ?? null,
        isGlobal: false,
        createdAt: new Date(),
        indexFields: [],
        departmentIds: resolvedDeptIds,
      })) as unknown as DocTypeRow;
    } catch (err: unknown) {
      // Índice único (tenant_id, name) — nome do tipo é único dentro da empresa
      // (regra "Tipos de documento globais e por empresa"). Mapeia a violação
      // para 409 tratado em vez de vazar como 500.
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError(`Já existe um tipo de documento chamado "${name}" nesta empresa`);
      }
      throw err;
    }
    const docType = rowToDocType(inserted, []);

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
      SELECT id, tenant_id, name, description, is_global, created_at, department_ids, deleted
      FROM document_types
      WHERE id = ${id}
        AND deleted = false
      LIMIT 1
    `;
    if (existingRows.length === 0) throw new NotFoundError();
    const indexFields = await fetchIndexFields(sql, id);
    const doc = rowToDocType(existingRows[0]!, indexFields);

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

      const query = `UPDATE document_types SET ${setParts.join(', ')} WHERE id = $1 AND deleted = false RETURNING id, tenant_id, name, description, is_global, created_at, department_ids, deleted`;
      const updRows = await sql.unsafe<DocTypeRow[]>(query, values as Parameters<typeof sql.unsafe>[1]);
      if (updRows.length === 0) throw new NotFoundError();

      request.log.info({ documentTypeId: id }, 'tipo de documento global atualizado');
      const enrichedGlobalPatch = await enrichWithDepartments(rowToDocType(updRows[0]!, indexFields), sql);
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
    const enrichedUpdated = await enrichWithDepartments(rowToDocType(updated as unknown as DocTypeRow, indexFields), sql);
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
   * Grava direto em `document_type_index_fields` (fonte de verdade) — nunca
   * mais reescreve o array `document_types.index_fields` (JSONB legado).
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
        SELECT id, tenant_id, name, description, is_global, created_at, department_ids, deleted
        FROM document_types
        WHERE id = ${id}
          AND deleted = false
        LIMIT 1
      `;
      if (existingRows.length === 0) throw new NotFoundError();
      const docType = rowToDocType(existingRows[0]!, []);
      assertDocTypeAccess(docType, request, isSuperAdmin);

      const newFieldId = newId();

      try {
        await sql`
          INSERT INTO document_type_index_fields (
            id, document_type_id, name, field_type, required, ai_extraction_hint, sort_order, show_on_search, deleted
          )
          VALUES (
            ${newFieldId}, ${id}, ${fieldInput.name}, ${fieldInput.fieldType}, ${fieldInput.required},
            ${fieldInput.aiExtractionHint}, ${fieldInput.order}, ${fieldInput.showOnSearch}, false
          )
        `;
      } catch (err: unknown) {
        const pgErr = err as { code?: string };
        if (pgErr.code === '23505') {
          throw new ConflictError(`Já existe um campo de índice chamado "${fieldInput.name}" neste tipo de documento`);
        }
        throw err;
      }

      request.log.info({ documentTypeId: id, fieldId: newFieldId }, 'campo de índice adicionado');
      const indexFields = await fetchIndexFields(sql, id);
      return reply.status(200).send(rowToDocType(existingRows[0]!, indexFields));
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
        SELECT id, tenant_id, name, description, is_global, created_at, department_ids, deleted
        FROM document_types
        WHERE id = ${id}
          AND deleted = false
        LIMIT 1
      `;
      if (existingRows.length === 0) throw new NotFoundError();
      const docType = rowToDocType(existingRows[0]!, []);
      assertDocTypeAccess(docType, request, isSuperAdmin);

      const updateRow = indexFieldUpdatesToRow(fieldUpdates);

      if (Object.keys(updateRow).length > 0) {
        let result;
        try {
          result = await sql`
            UPDATE document_type_index_fields
            SET ${sql(updateRow)}
            WHERE id = ${fieldId}
              AND document_type_id = ${id}
              AND deleted = false
          `;
        } catch (err: unknown) {
          const pgErr = err as { code?: string };
          if (pgErr.code === '23505') {
            throw new ConflictError('Já existe um campo de índice com esse nome neste tipo de documento');
          }
          throw err;
        }
        if (result.count === 0) throw new NotFoundError();
      } else {
        const existsRows = await sql`
          SELECT 1 FROM document_type_index_fields
          WHERE id = ${fieldId} AND document_type_id = ${id} AND deleted = false
          LIMIT 1
        `;
        if (existsRows.length === 0) throw new NotFoundError();
      }

      request.log.info({ documentTypeId: id, fieldId }, 'campo de índice atualizado');
      const indexFields = await fetchIndexFields(sql, id);
      return reply.status(200).send(rowToDocType(existingRows[0]!, indexFields));
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
        SELECT id, tenant_id, name, description, is_global, created_at, department_ids, deleted
        FROM document_types
        WHERE id = ${id}
          AND deleted = false
        LIMIT 1
      `;
      if (existingRows.length === 0) throw new NotFoundError();
      const docType = rowToDocType(existingRows[0]!, []);
      assertDocTypeAccess(docType, request, isSuperAdmin);

      const result = await sql`
        UPDATE document_type_index_fields
        SET deleted = true
        WHERE id = ${fieldId}
          AND document_type_id = ${id}
      `;
      if (result.count === 0) throw new NotFoundError();

      request.log.info({ documentTypeId: id, fieldId }, 'campo de índice removido (soft delete)');
      const indexFields = await fetchIndexFields(sql, id);
      return reply.status(200).send(rowToDocType(existingRows[0]!, indexFields));
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

/**
 * Converte o body de `PATCH .../index-fields/:fieldId` (camelCase, campos
 * opcionais) para um objeto snake_case pronto para `SET ${sql(obj)}` —
 * apenas as chaves presentes no update. `order` é mapeado explicitamente
 * para `sort_order` (não é uma conversão automática de camelCase).
 */
function indexFieldUpdatesToRow(
  updates: z.infer<typeof PatchIndexFieldBodySchema>
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (updates.name !== undefined) row['name'] = updates.name;
  if (updates.fieldType !== undefined) row['field_type'] = updates.fieldType;
  if (updates.required !== undefined) row['required'] = updates.required;
  if ('aiExtractionHint' in updates && updates.aiExtractionHint !== undefined) {
    row['ai_extraction_hint'] = updates.aiExtractionHint;
  }
  if (updates.order !== undefined) row['sort_order'] = updates.order;
  if (updates.showOnSearch !== undefined) row['show_on_search'] = updates.showOnSearch;
  return row;
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
