import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { TenantRepository, newId } from '@dmdoc/db-mongo';
import type { IndexField } from '@dmdoc/shared-types';
import type { TenantDocument } from '@dmdoc/db-mongo';
import { ForbiddenError, NotFoundError } from '../errors/index.js';
import { requireRole } from '../auth/role-guard.js';
// TODO: migrar para resolveTenantContext — cada handler precisa tratar mode:'allowed'
//       (MULTI_TENANT_ADMIN em leitura) e ajustar a lógica de tipos globais separadamente.
import { resolveTenantId } from '../auth/resolve-tenant.js';
import { ADMIN_ROLES } from '@dmdoc/shared-types';

interface DocumentTypeDoc extends TenantDocument {
  name: string;
  description: string | null;
  isGlobal: boolean;
  createdAt: Date;
  indexFields: IndexField[];
}

const ListDocumentTypesQuerySchema = z.object({
  tenantId: z.string().uuid().optional(), // SUPER_ADMIN apenas
});

const CreateDocumentTypeBodySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().nullable().default(null),
  tenantId: z.string().uuid().optional(), // SUPER_ADMIN apenas
  isGlobal: z.boolean().default(false),   // SUPER_ADMIN apenas
});

const PatchDocumentTypeBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
});

const CreateIndexFieldBodySchema = z.object({
  name: z.string().min(1).max(200),
  fieldType: z.enum(['TEXT', 'DATE', 'NUMBER', 'CUSTOMER', 'PROVIDER']),
  required: z.boolean().default(false),
  aiExtractionHint: z.string().nullable().default(null),
  order: z.number().int().nonnegative().default(0),
  showOnSearch: z.boolean().default(true),
});

const PatchIndexFieldBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  fieldType: z.enum(['TEXT', 'DATE', 'NUMBER', 'CUSTOMER', 'PROVIDER']).optional(),
  required: z.boolean().optional(),
  aiExtractionHint: z.string().nullable().optional(),
  order: z.number().int().nonnegative().optional(),
  showOnSearch: z.boolean().optional(),
});

const TenantIdQuerySchema = z.object({
  tenantId: z.string().uuid().optional(), // SUPER_ADMIN apenas
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
   * - SA com ?tenantId: tipos do tenant + tipos globais
   * - SA sem ?tenantId: todos os tipos de todos os tenants (incluindo globais)
   * - Outros: tipos do próprio tenant + globais
   */
  app.get('/document-types', { preHandler: app.authenticate }, async (request, reply) => {
    const { tenantId: tenantIdParam } = ListDocumentTypesQuerySchema.parse(request.query);
    const db = app.db;
    const isSuperAdmin = request.user?.role === 'SUPER_ADMIN';

    let items: Record<string, unknown>[];

    if (isSuperAdmin) {
      if (tenantIdParam !== undefined) {
        // SA com tenantId: tipos do tenant específico + tipos globais
        items = await db
          .collection('document_types')
          .find({
            deleted: false,
            $or: [{ tenantId: tenantIdParam }, { isGlobal: true, tenantId: null }],
          })
          .sort({ name: 1 })
          .toArray() as unknown as Record<string, unknown>[];
      } else {
        // SA sem tenantId: todos os tipos de todos os tenants, incluindo globais
        items = await db
          .collection('document_types')
          .find({ deleted: false })
          .sort({ name: 1 })
          .toArray() as unknown as Record<string, unknown>[];
      }
    } else {
      const tenantId = request.tenantId!;
      items = await db
        .collection('document_types')
        .find({
          deleted: false,
          $or: [{ tenantId }, { isGlobal: true, tenantId: null }],
        })
        .sort({ name: 1 })
        .toArray() as unknown as Record<string, unknown>[];
    }

    return reply.status(200).send(items.map(stripMongoId));
  });

  /**
   * POST /document-types — cria tipo de documento para o tenant.
   * SUPER_ADMIN: informar `tenantId` no body (obrigatório).
   * isGlobal sempre false; tenantId do request (ou body para SA).
   */
  app.post('/document-types', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, ...ADMIN_ROLES);

    const body = CreateDocumentTypeBodySchema.parse(request.body);
    const isSuperAdmin = request.user?.role === 'SUPER_ADMIN';
    const { name, description } = body;
    const db = app.db;

    if (isSuperAdmin && body.isGlobal) {
      // Tipo global — sem escopo de tenant
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
      return reply.status(201).send(docType);
    }

    const effectiveTenantId = resolveTenantId(request, body.tenantId, true);
    const tenantId = effectiveTenantId as string;

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
    });

    request.log.info({ tenantId, documentTypeId: docType.id }, 'tipo de documento criado');
    return reply.status(201).send(docType);
  });

  /**
   * PATCH /document-types/:id — atualiza tipo de documento.
   * SUPER_ADMIN em tipo global: sem tenantId necessário.
   * SUPER_ADMIN em tipo de tenant: informar `?tenantId=xxx`.
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
      const clean = removeUndefined(updates);
      const result = await db.collection('document_types').findOneAndUpdate(
        { id, deleted: false },
        { $set: clean },
        { returnDocument: 'after' }
      );
      if (!result) throw new NotFoundError();
      request.log.info({ documentTypeId: id }, 'tipo de documento global atualizado');
      return reply.status(200).send(stripMongoId(result as Record<string, unknown>));
    }

    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
    const effectiveTenantId = resolveTenantId(request, tenantIdParam, true);
    const tenantId = effectiveTenantId as string;

    const repo = new TenantRepository<DocumentTypeDoc>(db.collection('document_types'), { tenantId });
    const updated = await repo.updateById(id, removeUndefined(updates) as Parameters<typeof repo.updateById>[1]);
    if (!updated) throw new NotFoundError();

    request.log.info({ tenantId, documentTypeId: id }, 'tipo de documento atualizado');
    return reply.status(200).send(updated);
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
