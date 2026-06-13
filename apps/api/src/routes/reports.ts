import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/role-guard.js';
import { resolveTenantContext } from '../auth/resolve-tenant.js';
import { NotFoundError } from '../errors/index.js';

const TenantIdQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo:   z.coerce.date().optional(),
});

interface DepartmentDoc {
  id: string;
  name: string;
}

interface DocumentTypeDoc {
  id: string;
  name: string;
}

interface TotalAggResult {
  documents: number;
  pages: number;
}

interface GroupAggResult {
  _id: string | null;
  documents: number;
  pages: number;
}

interface StatusAggResult {
  _id: string;
  count: number;
}

/**
 * Rotas de relatórios — Fase 5.
 *
 * GET /reports/documents-summary — retorna um resumo agregado dos documentos
 * do tenant: totais, agrupamento por departamento, por tipo de documento e
 * por status.
 *
 * A contagem de páginas vem de `document_content.extraction.pageCount` via
 * $lookup. Documentos sem conteúdo extraído contribuem com 0 páginas.
 *
 * Acesso:
 *   - TENANT_ADMIN: usa o tenantId do JWT
 *   - SUPER_ADMIN: exige ?tenantId explícito (write: true lança ConflictError sem ele)
 *   - MULTI_TENANT_ADMIN: exige ?tenantId explícito (NotFoundError se ausente)
 */
export const reportsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/reports/documents-summary',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, 'TENANT_ADMIN', 'MULTI_TENANT_ADMIN');

      const { tenantId: tenantIdParam, dateFrom, dateTo } = TenantIdQuerySchema.parse(request.query);

      // write: true força tenantId explícito para SA e MTA.
      // Para TENANT_ADMIN retorna mode:'single' com o tenantId do token.
      const ctx = resolveTenantContext(request, {
        explicitTenantId: tenantIdParam,
        write: true,
      });

      if (ctx.mode !== 'single') {
        // Ramo defensivo: write:true garante que nunca chegamos aqui, mas o
        // TypeScript não infere narrowing via throw do resolveTenantContext.
        throw new NotFoundError('tenantId é obrigatório para esta operação');
      }

      const tenantId = ctx.tenantId;
      const db = app.db;

      // Filtro de data condicional sobre o campo uploadedAt.
      const dateFilter: Record<string, unknown> = {};
      if (dateFrom !== undefined) dateFilter['$gte'] = dateFrom;
      if (dateTo !== undefined)   dateFilter['$lte'] = dateTo;

      const uploadedAtFilter = Object.keys(dateFilter).length > 0
        ? { uploadedAt: dateFilter }
        : {};

      /**
       * Pipeline base com $lookup em document_content para obter pageCount.
       * Reutilizado pelas agregações de totais, por departamento e por tipo.
       */
      const basePipeline = [
        { $match: { tenantId, deleted: false, ...uploadedAtFilter } },
        {
          $lookup: {
            from: 'document_content',
            let: { docId: '$id' },
            pipeline: [
              { $match: { $expr: { $eq: ['$documentId', '$$docId'] } } },
              {
                $project: {
                  pageCount: '$extraction.pageCount',
                  _id: 0,
                },
              },
            ],
            as: 'content',
          },
        },
        {
          $addFields: {
            pageCount: {
              $ifNull: [{ $arrayElemAt: ['$content.pageCount', 0] }, 0],
            },
          },
        },
      ] as const;

      // Executa as 4 agregações em paralelo para minimizar latência.
      const [totalsRaw, byDeptRaw, byTypeRaw, byStatusRaw] = await Promise.all([
        // 1. Totais globais
        db
          .collection('documents')
          .aggregate<TotalAggResult>([
            ...basePipeline,
            {
              $group: {
                _id: null,
                documents: { $sum: 1 },
                pages: { $sum: '$pageCount' },
              },
            },
          ])
          .toArray(),

        // 2. Por departamento
        db
          .collection('documents')
          .aggregate<GroupAggResult>([
            ...basePipeline,
            {
              $group: {
                _id: '$departmentId',
                documents: { $sum: 1 },
                pages: { $sum: '$pageCount' },
              },
            },
          ])
          .toArray(),

        // 3. Por tipo de documento
        db
          .collection('documents')
          .aggregate<GroupAggResult>([
            ...basePipeline,
            {
              $group: {
                _id: '$documentTypeId',
                documents: { $sum: 1 },
                pages: { $sum: '$pageCount' },
              },
            },
          ])
          .toArray(),

        // 4. Por status — sem $lookup (status é campo simples na coleção)
        db
          .collection('documents')
          .aggregate<StatusAggResult>([
            { $match: { tenantId, deleted: false, ...uploadedAtFilter } },
            { $group: { _id: '$status', count: { $sum: 1 } } },
          ])
          .toArray(),
      ]);

      // Totais
      const totalDocuments = totalsRaw[0]?.documents ?? 0;
      const totalPages = totalsRaw[0]?.pages ?? 0;

      // Enriquecer por departamento com nomes
      const departmentIds = byDeptRaw
        .map((r) => r._id)
        .filter((id): id is string => id !== null);

      const departmentDocs =
        departmentIds.length > 0
          ? await db
              .collection<DepartmentDoc>('departments')
              .find({ id: { $in: departmentIds } })
              .project<DepartmentDoc>({ id: 1, name: 1, _id: 0 })
              .toArray()
          : [];

      const departmentNameById = new Map<string, string>(
        departmentDocs.map((d) => [d.id, d.name]),
      );

      const byDepartment = byDeptRaw.map((row) => ({
        departmentId: row._id,
        departmentName: row._id !== null ? (departmentNameById.get(row._id) ?? null) : null,
        documents: row.documents,
        pages: row.pages,
      }));

      // Enriquecer por tipo de documento com nomes
      const documentTypeIds = byTypeRaw
        .map((r) => r._id)
        .filter((id): id is string => id !== null);

      const documentTypeDocs =
        documentTypeIds.length > 0
          ? await db
              .collection<DocumentTypeDoc>('document_types')
              .find({ id: { $in: documentTypeIds } })
              .project<DocumentTypeDoc>({ id: 1, name: 1, _id: 0 })
              .toArray()
          : [];

      const documentTypeNameById = new Map<string, string>(
        documentTypeDocs.map((d) => [d.id, d.name]),
      );

      const byDocumentType = byTypeRaw.map((row) => ({
        documentTypeId: row._id,
        documentTypeName:
          row._id !== null ? (documentTypeNameById.get(row._id) ?? null) : null,
        documents: row.documents,
        pages: row.pages,
      }));

      // Índice de status: Record<string, number>
      const byStatus = byStatusRaw.reduce<Record<string, number>>((acc, row) => {
        acc[row._id] = row.count;
        return acc;
      }, {});

      request.log.info(
        { tenantId, totalDocuments, totalPages, dateFrom, dateTo },
        'relatório de documentos consultado',
      );

      return reply.status(200).send({
        tenantId,
        totals: {
          documents: totalDocuments,
          pages: totalPages,
        },
        byDepartment,
        byDocumentType,
        byStatus,
      });
    },
  );
};
