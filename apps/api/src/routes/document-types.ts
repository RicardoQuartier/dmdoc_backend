import type { FastifyPluginAsync } from 'fastify';
import type { Db } from 'mongodb';
import { z } from 'zod';
import { TenantRepository, newId } from '@dmdoc/db-mongo';
import type { IndexField } from '@dmdoc/shared-types';
import type { TenantDocument } from '@dmdoc/db-mongo';
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
  tenantId: z.string().uuid().optional(), // SUPER_ADMIN apenas
});

const CreateDocumentTypeBodySchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().nullable().default(null),
    tenantId: z.string().uuid().optional(), // SUPER_ADMIN apenas
    isGlobal: z.boolean().default(false),   // SUPER_ADMIN apenas
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
  tenantId: z.string().uuid().optional(), // SUPER_ADMIN apenas
});

const SetGlobalTypeDeptConfigBodySchema = z.object({
  departmentIds: z.array(z.string().uuid()).min(1),
  tenantId: z.string().uuid().optional(), // SUPER_ADMIN / MTA apenas
});

/**
 * Rotas de CRUD de tipos de documento e seus campos de índice.
 *
 * GET lista tipos do tenant + tipos globais (isGlobal: true).
 * Mutations operam apenas sobre tipos do tenant (não globais).
 *
 * SUPER_ADMIN: informa tenantId via body (POST) ou ?tenantId (PATCH, DELETE,
 * POST index-fields, PATCH index-fields, DELETE index-fields).
 */
export const documentTypesRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /document-types — lista tipos de documento.
   *
   * - SA sem ?tenantId: todos os tipos de todos os tenants (incluindo globais)
   * - SA/MTA com ?tenantId: tipos do tenant específico + tipos globais
   * - MTA sem ?tenantId: tipos de todos os seus tenants + globais
   * - TENANT_ADMIN: tipos do próprio tenant + globais (sem restrição de ACL)
   * - UPLOADER/USER: tipos globais + tipos de empresa cujos departmentIds
   *   tenham interseção com os departamentos acessíveis ao usuário
   *
   * A resposta inclui o campo `departments: [{id, name}]` para cada tipo,
   * resolvido via lookup na coleção `departments`.
   */
  app.get('/document-types', { preHandler: app.authenticate }, async (request, reply) => {
    const { tenantId: tenantIdParam } = ListDocumentTypesQuerySchema.parse(request.query);
    const db = app.db;

    const ctx = resolveTenantContext(request, { explicitTenantId: tenantIdParam });
    const role = request.user?.role ?? '';
    const userId = request.user?.sub ?? '';

    let items: Record<string, unknown>[];

    if (ctx.mode === 'all') {
      items = await db
        .collection('document_types')
        .find({ deleted: false })
        .sort({ name: 1 })
        .toArray() as unknown as Record<string, unknown>[];
    } else if (ctx.mode === 'allowed') {
      items = await db
        .collection('document_types')
        .find({
          deleted: false,
          $or: [
            { tenantId: { $in: ctx.tenantIds } },
            { isGlobal: true, tenantId: null },
          ],
        })
        .sort({ name: 1 })
        .toArray() as unknown as Record<string, unknown>[];
    } else {
      // mode === 'single'
      const baseTenantId = ctx.tenantId as string;

      // Para UPLOADER e USER, aplica filtro de visibilidade por departamento.
      const accessibleDeptIds = await resolveAccessibleDepartmentIds(
        db,
        userId,
        baseTenantId,
        role
      );

      let tenantFilter: Record<string, unknown>;
      if (accessibleDeptIds !== null) {
        // Carrega configurações de visibilidade de tipos globais para este tenant.
        const globalConfigs = await db
          .collection('global_type_tenant_depts')
          .find({ tenantId: baseTenantId, deleted: false })
          .project<{ globalTypeId: string; departmentIds: string[] }>({ _id: 0, globalTypeId: 1, departmentIds: 1 })
          .toArray();

        // Tipos globais visíveis = aqueles com config cujos depts intersectem com os acessíveis.
        const visibleGlobalIds = globalConfigs
          .filter((c) => c.departmentIds.some((id) => accessibleDeptIds.includes(id)))
          .map((c) => c.globalTypeId);

        const globalCondition =
          visibleGlobalIds.length > 0
            ? [{ isGlobal: true, tenantId: null, id: { $in: visibleGlobalIds } }]
            : [];

        tenantFilter = {
          deleted: false,
          $or: [
            ...globalCondition,
            {
              tenantId: baseTenantId,
              departmentIds: { $in: accessibleDeptIds },
            },
          ],
        };
      } else {
        // Admins: veem todos os tipos do tenant + globais.
        tenantFilter = {
          deleted: false,
          $or: [{ tenantId: baseTenantId }, { isGlobal: true, tenantId: null }],
        };
      }

      items = await db
        .collection('document_types')
        .find(tenantFilter)
        .sort({ name: 1 })
        .toArray() as unknown as Record<string, unknown>[];
    }

    // Resolve nomes dos departamentos: coleta todos os departmentIds únicos
    // de todos os tipos retornados e faz um único lookup em batch.
    const allDeptIds = new Set<string>();
    for (const item of items) {
      const deptIds = item['departmentIds'] as string[] | undefined;
      if (Array.isArray(deptIds)) {
        for (const deptId of deptIds) allDeptIds.add(deptId);
      }
    }

    const deptNameMap = new Map<string, string>();
    if (allDeptIds.size > 0) {
      const deptDocs = await db
        .collection('departments')
        .find({ id: { $in: [...allDeptIds] }, deleted: false })
        .project<DepartmentNameDoc>({ _id: 0, id: 1, name: 1 })
        .toArray();
      for (const dept of deptDocs) {
        deptNameMap.set(dept.id, dept.name);
      }
    }

    const enriched = items.map((item) => {
      const stripped = stripMongoId(item);
      const deptIds = stripped['departmentIds'] as string[] | undefined;
      const departments = Array.isArray(deptIds)
        ? deptIds.map((deptId) => ({ id: deptId, name: deptNameMap.get(deptId) ?? '' }))
        : [];
      return { ...stripped, departments };
    });

    return reply.status(200).send(enriched);
  });

  /**
   * POST /document-types — cria tipo de documento para o tenant.
   * SUPER_ADMIN: informar `tenantId` no body (obrigatório).
   * isGlobal sempre false; tenantId do request (ou body para SA).
   *
   * Para tipos de empresa (isGlobal: false), `departmentIds` é obrigatório
   * (min 1) e todos os IDs devem existir no tenant (→ 404 caso contrário).
   * Para tipos globais (isGlobal: true), `departmentIds` é ignorado.
   */
  app.post('/document-types', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, ...ADMIN_ROLES);

    const body = CreateDocumentTypeBodySchema.parse(request.body);
    const isSuperAdmin = request.user?.role === 'SUPER_ADMIN';
    const { name, description, departmentIds } = body;
    const db = app.db;

    if (isSuperAdmin && body.isGlobal) {
      // Tipo global — sem escopo de tenant; departmentIds é ignorado.
      const id = newId();
      const docType = {
        id,
        tenantId: null,
        name,
        description: description ?? null,
        isGlobal: true,
        createdAt: new Date(),
        indexFields: [],
        deleted: false,
      };
      await db.collection('document_types').insertOne(docType);
      request.log.info({ documentTypeId: id }, 'tipo de documento global criado');
      // Tipos globais não têm departamentos — enrichWithDepartments retorna departments: [].
      const enrichedGlobal = await enrichWithDepartments(
        docType as unknown as Record<string, unknown>,
        db as Db
      );
      return reply.status(201).send(enrichedGlobal);
    }

    const effectiveTenantId = resolveTenantId(request, body.tenantId, true);
    const tenantId = effectiveTenantId as string;

    // departmentIds é obrigatório para tipos de empresa (garantido pelo superRefine,
    // mas verificado aqui também para garantir o tipo).
    const resolvedDeptIds = departmentIds as string[];

    // Valida que todos os departmentIds existem e pertencem ao tenant.
    const foundCount = await db
      .collection('departments')
      .countDocuments({ id: { $in: resolvedDeptIds }, tenantId, deleted: false });
    if (foundCount !== resolvedDeptIds.length) {
      request.log.warn(
        { tenantId, departmentIds: resolvedDeptIds },
        'um ou mais departmentIds não encontrados no tenant'
      );
      throw new NotFoundError();
    }

    const repo = new TenantRepository<DocumentTypeDoc>(
      db.collection('document_types'),
      { tenantId }
    );

    const docType = await repo.insertOne({
      name,
      description,
      isGlobal: false,
      createdAt: new Date(),
      indexFields: [],
      departmentIds: resolvedDeptIds,
    });

    request.log.info({ tenantId, documentTypeId: docType.id }, 'tipo de documento criado');
    const enrichedDocType = await enrichWithDepartments(
      docType as unknown as Record<string, unknown>,
      db as Db
    );
    return reply.status(201).send(enrichedDocType);
  });

  /**
   * PATCH /document-types/:id — atualiza tipo de documento.
   * SUPER_ADMIN em tipo global: sem tenantId necessário.
   * SUPER_ADMIN em tipo de tenant: informar `?tenantId=xxx`.
   *
   * Para tipos de empresa, se `departmentIds` for informado, todos os IDs
   * devem existir no tenant (→ 404 caso contrário).
   * Tipos globais não aceitam `departmentIds`.
   */
  app.patch('/document-types/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, ...ADMIN_ROLES);

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const updates = PatchDocumentTypeBodySchema.parse(request.body);
    const db = app.db;
    const isSuperAdmin = request.user?.role === 'SUPER_ADMIN';

    const existing = await db.collection('document_types').findOne({ id, deleted: false });
    if (!existing) throw new NotFoundError();
    const doc = existing as unknown as DocumentTypeDoc;

    if (doc.isGlobal) {
      if (!isSuperAdmin) throw new ForbiddenError('Tipos globais só podem ser editados por SUPER_ADMIN');
      // Tipos globais não têm departmentIds — ignorar o campo mesmo que enviado.
      const { departmentIds: _ignored, ...globalUpdates } = updates;
      const clean = removeUndefined(globalUpdates);
      const result = await db.collection('document_types').findOneAndUpdate(
        { id, deleted: false },
        { $set: clean },
        { returnDocument: 'after' }
      );
      if (!result) throw new NotFoundError();
      request.log.info({ documentTypeId: id }, 'tipo de documento global atualizado');
      // Tipos globais não têm departamentos — enrichWithDepartments retorna departments: [].
      const enrichedGlobalPatch = await enrichWithDepartments(
        result as Record<string, unknown>,
        db as Db
      );
      return reply.status(200).send(enrichedGlobalPatch);
    }

    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
    const effectiveTenantId = resolveTenantId(request, tenantIdParam, true);
    const tenantId = effectiveTenantId as string;

    // Se departmentIds foi fornecido, valida existência no tenant.
    if (updates.departmentIds !== undefined) {
      const deptIds = updates.departmentIds;
      const foundCount = await db
        .collection('departments')
        .countDocuments({ id: { $in: deptIds }, tenantId, deleted: false });
      if (foundCount !== deptIds.length) {
        request.log.warn(
          { tenantId, documentTypeId: id, departmentIds: deptIds },
          'um ou mais departmentIds não encontrados no tenant'
        );
        throw new NotFoundError();
      }
    }

    const repo = new TenantRepository<DocumentTypeDoc>(db.collection('document_types'), { tenantId });
    const updated = await repo.updateById(id, removeUndefined(updates) as Parameters<typeof repo.updateById>[1]);
    if (!updated) throw new NotFoundError();

    request.log.info({ tenantId, documentTypeId: id }, 'tipo de documento atualizado');
    const enrichedUpdated = await enrichWithDepartments(
      updated as unknown as Record<string, unknown>,
      db as Db
    );
    return reply.status(200).send(enrichedUpdated);
  });

  /**
   * DELETE /document-types/:id — soft-delete de tipo do tenant.
   * SUPER_ADMIN pode deletar tipos globais sem tenantId.
   * Tenants não podem deletar tipos globais.
   */
  app.delete('/document-types/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, ...ADMIN_ROLES);

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const db = app.db;
    const isSuperAdmin = request.user?.role === 'SUPER_ADMIN';

    const existing = await db.collection('document_types').findOne({ id, deleted: false });
    if (!existing) throw new NotFoundError();
    const doc = existing as unknown as DocumentTypeDoc;

    if (doc.isGlobal) {
      if (!isSuperAdmin) throw new ForbiddenError('Tipos globais não podem ser excluídos por tenants');
      await db.collection('document_types').updateOne({ id }, { $set: { deleted: true } });
      request.log.info({ documentTypeId: id }, 'tipo de documento global removido');
      return reply.status(204).send();
    }

    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
    const effectiveTenantId = resolveTenantId(request, tenantIdParam, true);
    const tenantId = effectiveTenantId as string;

    const repo = new TenantRepository<DocumentTypeDoc>(db.collection('document_types'), { tenantId });
    const deleted = await repo.softDelete(id);
    if (!deleted) throw new NotFoundError();

    request.log.info({ tenantId, documentTypeId: id }, 'tipo de documento removido');
    return reply.status(204).send();
  });

  /**
   * POST /document-types/:id/index-fields — adiciona campo ao tipo.
   * SUPER_ADMIN: informar `?tenantId=xxx` (obrigatório).
   */
  app.post(
    '/document-types/:id/index-fields',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, ...ADMIN_ROLES);

      const { id } = z.object({ id: z.string() }).parse(request.params);
      const fieldInput = CreateIndexFieldBodySchema.parse(request.body);
      const db = app.db;
      const isSuperAdmin = request.user?.role === 'SUPER_ADMIN';

      const existing = await db.collection('document_types').findOne({ id, deleted: false });
      if (!existing) throw new NotFoundError();
      const docType = existing as unknown as DocumentTypeDoc;
      if (docType.isGlobal && !isSuperAdmin) throw new ForbiddenError('Tipos globais só podem ser editados por SUPER_ADMIN');

      const typeFilter = docType.isGlobal
        ? { id, deleted: false }
        : (() => {
            const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
            const tenantId = resolveTenantId(request, tenantIdParam, true) as string;
            return { id, tenantId, deleted: false };
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

      const updated = await db
        .collection('document_types')
        .findOneAndUpdate(
          typeFilter,
          { $push: { indexFields: newField } } as Record<string, unknown>,
          { returnDocument: 'after' }
        );

      if (!updated) throw new NotFoundError();

      request.log.info(
        { documentTypeId: id, fieldId: newField.id },
        'campo de índice adicionado'
      );
      return reply.status(200).send(stripMongoId(updated as Record<string, unknown>));
    }
  );

  /**
   * PATCH /document-types/:id/index-fields/:fieldId — atualiza campo.
   * SUPER_ADMIN em tipo global: sem tenantId necessário.
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
      const db = app.db;
      const isSuperAdmin = request.user?.role === 'SUPER_ADMIN';

      const existing = await db.collection('document_types').findOne({ id, deleted: false });
      if (!existing) throw new NotFoundError();
      const docType = existing as unknown as DocumentTypeDoc;
      if (docType.isGlobal && !isSuperAdmin) throw new ForbiddenError('Tipos globais só podem ser editados por SUPER_ADMIN');

      const typeFilter = docType.isGlobal
        ? { id, deleted: false }
        : (() => {
            const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
            const tenantId = resolveTenantId(request, tenantIdParam, true) as string;
            return { id, tenantId, deleted: false };
          })();

      // Monta o $set para o subdocumento usando arrayFilters
      const setOps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fieldUpdates)) {
        if (value !== undefined) {
          setOps[`indexFields.$[elem].${key}`] = value;
        }
      }

      if (Object.keys(setOps).length === 0) {
        const noopExisting = await db.collection('document_types').findOne(typeFilter);
        if (!noopExisting) throw new NotFoundError();
        return reply.status(200).send(stripMongoId(noopExisting as Record<string, unknown>));
      }

      const updated = await db
        .collection('document_types')
        .findOneAndUpdate(
          { ...typeFilter, 'indexFields.id': fieldId },
          { $set: setOps },
          {
            returnDocument: 'after',
            arrayFilters: [{ 'elem.id': fieldId, 'elem.deleted': false }],
          }
        );

      if (!updated) throw new NotFoundError();

      request.log.info(
        { documentTypeId: id, fieldId },
        'campo de índice atualizado'
      );
      return reply.status(200).send(stripMongoId(updated as Record<string, unknown>));
    }
  );

  /**
   * GET /document-types/:id/dept-config — retorna config de departamentos do tenant
   * para um tipo global. Apenas ADMIN_ROLES.
   */
  app.get(
    '/document-types/:id/dept-config',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, ...ADMIN_ROLES);

      const { id } = z.object({ id: z.string() }).parse(request.params);
      const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
      const db = app.db;

      const existing = await db.collection('document_types').findOne({ id, deleted: false });
      if (!existing) throw new NotFoundError();
      const doc = existing as unknown as DocumentTypeDoc;
      if (!doc.isGlobal) throw new NotFoundError();

      const effectiveTenantId = resolveTenantId(request, tenantIdParam, true);
      const tenantId = effectiveTenantId as string;

      const config = await db
        .collection('global_type_tenant_depts')
        .findOne({ globalTypeId: id, tenantId, deleted: false });

      if (!config) return reply.status(200).send(null);

      return reply.status(200).send(stripMongoId(config as unknown as Record<string, unknown>));
    }
  );

  /**
   * PUT /document-types/:id/dept-config — cria ou atualiza config de departamentos
   * do tenant para um tipo global. Apenas ADMIN_ROLES.
   */
  app.put(
    '/document-types/:id/dept-config',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, ...ADMIN_ROLES);

      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = SetGlobalTypeDeptConfigBodySchema.parse(request.body);
      const db = app.db;

      const existing = await db.collection('document_types').findOne({ id, deleted: false });
      if (!existing) throw new NotFoundError();
      const doc = existing as unknown as DocumentTypeDoc;
      if (!doc.isGlobal) throw new NotFoundError();

      const effectiveTenantId = resolveTenantId(request, body.tenantId, true);
      const tenantId = effectiveTenantId as string;

      // Valida que todos os departmentIds existem e pertencem ao tenant.
      const { departmentIds } = body;
      const foundCount = await db
        .collection('departments')
        .countDocuments({ id: { $in: departmentIds }, tenantId, deleted: false });
      if (foundCount !== departmentIds.length) {
        request.log.warn(
          { tenantId, globalTypeId: id, departmentIds },
          'um ou mais departmentIds não encontrados no tenant'
        );
        throw new NotFoundError();
      }

      const now = new Date();
      const configResult = await db
        .collection('global_type_tenant_depts')
        .findOneAndUpdate(
          { globalTypeId: id, tenantId, deleted: false },
          {
            $set: { departmentIds, updatedAt: now },
            $setOnInsert: { id: newId(), globalTypeId: id, tenantId, createdAt: now, deleted: false },
          },
          { upsert: true, returnDocument: 'after' }
        );

      request.log.info(
        { tenantId, globalTypeId: id, departmentIds },
        'config de departamentos para tipo global atualizada'
      );
      return reply.status(200).send(stripMongoId(configResult as unknown as Record<string, unknown>));
    }
  );

  /**
   * DELETE /document-types/:id/dept-config — remove config de departamentos
   * do tenant para um tipo global (tipo fica invisível para todos no tenant).
   */
  app.delete(
    '/document-types/:id/dept-config',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, ...ADMIN_ROLES);

      const { id } = z.object({ id: z.string() }).parse(request.params);
      const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
      const db = app.db;

      const existing = await db.collection('document_types').findOne({ id, deleted: false });
      if (!existing) throw new NotFoundError();
      const doc = existing as unknown as DocumentTypeDoc;
      if (!doc.isGlobal) throw new NotFoundError();

      const effectiveTenantId = resolveTenantId(request, tenantIdParam, true);
      const tenantId = effectiveTenantId as string;

      const result = await db
        .collection('global_type_tenant_depts')
        .updateOne({ globalTypeId: id, tenantId, deleted: false }, { $set: { deleted: true, updatedAt: new Date() } });

      if (result.matchedCount === 0) throw new NotFoundError();

      request.log.info(
        { tenantId, globalTypeId: id },
        'config de departamentos para tipo global removida'
      );
      return reply.status(204).send();
    }
  );

  /**
   * DELETE /document-types/:id/index-fields/:fieldId — soft-delete do campo.
   * SUPER_ADMIN em tipo global: sem tenantId necessário.
   */
  app.delete(
    '/document-types/:id/index-fields/:fieldId',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, ...ADMIN_ROLES);

      const { id, fieldId } = z
        .object({ id: z.string(), fieldId: z.string() })
        .parse(request.params);
      const db = app.db;
      const isSuperAdmin = request.user?.role === 'SUPER_ADMIN';

      const existing = await db.collection('document_types').findOne({ id, deleted: false });
      if (!existing) throw new NotFoundError();
      const docType = existing as unknown as DocumentTypeDoc;
      if (docType.isGlobal && !isSuperAdmin) throw new ForbiddenError('Tipos globais só podem ser editados por SUPER_ADMIN');

      const typeFilter = docType.isGlobal
        ? { id, deleted: false }
        : (() => {
            const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
            const tenantId = resolveTenantId(request, tenantIdParam, true) as string;
            return { id, tenantId, deleted: false };
          })();

      const updated = await db
        .collection('document_types')
        .findOneAndUpdate(
          { ...typeFilter, 'indexFields.id': fieldId },
          { $set: { 'indexFields.$[elem].deleted': true } },
          {
            returnDocument: 'after',
            arrayFilters: [{ 'elem.id': fieldId }],
          }
        );

      if (!updated) throw new NotFoundError();

      request.log.info(
        { documentTypeId: id, fieldId },
        'campo de índice removido (soft delete)'
      );
      return reply.status(200).send(stripMongoId(updated as Record<string, unknown>));
    }
  );
};

function stripMongoId(doc: Record<string, unknown>): Record<string, unknown> {
  const { _id: _ignored, ...rest } = doc;
  return rest;
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

/**
 * Enriquece um único tipo de documento com o campo `departments: [{id, name}]`,
 * resolvendo os nomes a partir da coleção `departments` do banco.
 *
 * Tipos globais (sem departmentIds) retornam sempre `departments: []`.
 * Tipos de empresa retornam um objeto por departmentId com o nome resolvido;
 * IDs sem documento correspondente (ex.: departamento soft-deleted) ficam com
 * `name: ''` para não quebrar a resposta.
 */
async function enrichWithDepartments(
  doc: Record<string, unknown>,
  db: Db
): Promise<Record<string, unknown>> {
  const stripped = stripMongoId(doc);
  const deptIds = stripped['departmentIds'] as string[] | undefined;

  if (!Array.isArray(deptIds) || deptIds.length === 0) {
    return { ...stripped, departments: [] };
  }

  const deptDocs = await db
    .collection('departments')
    .find({ id: { $in: deptIds }, deleted: false })
    .project<DepartmentNameDoc>({ _id: 0, id: 1, name: 1 })
    .toArray();

  const nameMap = new Map<string, string>(deptDocs.map((d) => [d.id, d.name]));
  const departments = deptIds.map((deptId) => ({ id: deptId, name: nameMap.get(deptId) ?? '' }));

  return { ...stripped, departments };
}
