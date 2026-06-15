import type { FastifyPluginAsync } from 'fastify';
import type { Document as MongoDocument } from 'mongodb';
import { z } from 'zod';
import { DocumentEventsRepository, DOCUMENT_EVENTS_COLLECTION } from '@dmdoc/db-mongo';
import type { DocumentEvent } from '@dmdoc/shared-types';
import { requireRole } from '../auth/role-guard.js';
import { resolveTenantContext } from '../auth/resolve-tenant.js';
import { NotFoundError, ValidationError } from '../errors/index.js';

const TenantIdQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo:   z.coerce.date().optional(),
});

/**
 * Schema dos filtros de `GET /reports/uploads`. Os campos CSV (`userIds`,
 * `mimeTypes`, `documentTypeIds`) chegam como string única na query e são
 * transformados em arrays validados item a item:
 *
 * - split por vírgula, trim em cada item, descarta vazios;
 * - `userIds` / `documentTypeIds`: cada item deve ser UUID;
 * - `mimeTypes`: cada item é string livre não vazia.
 *
 * Datas via `z.coerce.date()` (filtram `createdAt` do evento). `groupBy` opcional
 * adiciona a quebra extra em `groups`.
 */
const csvUuids = z
  .string()
  .optional()
  .transform((raw) =>
    (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
  .pipe(z.array(z.string().uuid('cada id deve ser um UUID válido')));

const csvStrings = z
  .string()
  .optional()
  .transform((raw) =>
    (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
  .pipe(z.array(z.string().min(1)));

const UploadsReportQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  userIds: csvUuids,
  mimeTypes: csvStrings,
  documentTypeIds: csvUuids,
  groupBy: z.enum(['format', 'user', 'documentType']).optional(),
});

/** Linha de agregação de totais globais do relatório de uploads. */
interface UploadsTotalsRow {
  _id: null;
  files: number;
  pages: number;
  sizeBytes: number;
}

/** Linha de agregação quebrada por formato (mimeType). */
interface UploadsByFormatRow {
  _id: string;
  files: number;
  pages: number;
  sizeBytes: number;
}

/** Linha de agregação genérica de `groups` — `_id` é a chave da quebra. */
interface UploadsGroupRow {
  _id: string | null;
  files: number;
  pages: number;
  sizeBytes: number;
  documentTypeName?: string | null;
}

/** Documento mínimo de usuário para denormalizar o nome em groupBy=user. */
interface UserNameDoc {
  id: string;
  name: string;
}

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

  /**
   * GET /reports/uploads — relatório agregado de uploads para o dashboard de
   * uso/cobrança (Fase 5). Agrega a coleção append-only `document_events` —
   * NÃO a coleção `documents` — porque o faturamento conta o que FOI ENVIADO,
   * não o que existe no acervo agora (wiki "Histórico de eventos de upload e
   * relatório de uso (cobrança)").
   *
   * Conta TODOS os eventos do filtro, incluindo `deduplicated:true` e eventos
   * cujo documento já foi excluído (a coleção não tem `deleted`, e o repositório
   * append-only nunca injeta filtro de exclusão). `pageCount` null vira 0 mas o
   * evento ainda conta para `files` e `sizeBytes`.
   *
   * Acesso (idêntico a /reports/documents-summary):
   *   - TENANT_ADMIN: usa o tenantId do JWT
   *   - SUPER_ADMIN: exige ?tenantId explícito (ConflictError 409 sem ele)
   *   - MULTI_TENANT_ADMIN: exige ?tenantId explícito (NotFoundError 404 sem ele)
   *
   * O isolamento por tenant é garantido pelo `DocumentEventsRepository.aggregate`,
   * que SEMPRE prefixa um `$match: { tenantId }` — a rota nunca acessa a coleção
   * direto.
   */
  app.get(
    '/reports/uploads',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, 'TENANT_ADMIN', 'MULTI_TENANT_ADMIN');

      const {
        tenantId: tenantIdParam,
        dateFrom,
        dateTo,
        userIds,
        mimeTypes,
        documentTypeIds,
        groupBy,
      } = UploadsReportQuerySchema.parse(request.query);

      // Período inválido: dateFrom posterior a dateTo → 422 tipado.
      if (dateFrom !== undefined && dateTo !== undefined && dateFrom > dateTo) {
        throw new ValidationError('dateFrom não pode ser posterior a dateTo');
      }

      // write: true força tenantId explícito para SA e MTA; TENANT_ADMIN usa o token.
      const ctx = resolveTenantContext(request, {
        explicitTenantId: tenantIdParam,
        write: true,
      });

      if (ctx.mode !== 'single') {
        // Ramo defensivo: write:true garante single, mas o TS não infere narrowing.
        throw new NotFoundError('tenantId é obrigatório para esta operação');
      }

      const tenantId = ctx.tenantId;
      const db = app.db;

      // O repositório append-only prefixa o $match { tenantId } automaticamente —
      // nunca acessamos a coleção direto (isolamento inegociável).
      const eventsRepo = new DocumentEventsRepository(
        db.collection<DocumentEvent>(DOCUMENT_EVENTS_COLLECTION),
        { tenantId },
      );

      // ----------------------------------------------------------------------
      // $match adicional (datas/usuários/formatos/tipos). O tenantId NÃO entra
      // aqui — o repositório o injeta. NUNCA reintroduzir filtro de `deleted`.
      // ----------------------------------------------------------------------
      const createdAtFilter: Record<string, Date> = {};
      if (dateFrom !== undefined) createdAtFilter['$gte'] = dateFrom;
      if (dateTo !== undefined) createdAtFilter['$lte'] = dateTo;

      const matchFilter: Record<string, unknown> = {};
      if (Object.keys(createdAtFilter).length > 0) matchFilter['createdAt'] = createdAtFilter;
      if (userIds.length > 0) matchFilter['uploadedById'] = { $in: userIds };
      if (mimeTypes.length > 0) matchFilter['mimeType'] = { $in: mimeTypes };
      if (documentTypeIds.length > 0) matchFilter['documentTypeId'] = { $in: documentTypeIds };

      const matchStage: MongoDocument[] =
        Object.keys(matchFilter).length > 0 ? [{ $match: matchFilter }] : [];

      // pageCount null conta como 0, mas o evento ainda soma em files/sizeBytes.
      const pageCountExpr = { $ifNull: ['$pageCount', 0] };

      // Estágio de soma reutilizado pelos três $group.
      const sumFields = {
        files: { $sum: 1 },
        pages: { $sum: pageCountExpr },
        sizeBytes: { $sum: '$sizeBytes' },
      } as const;

      // ----------------------------------------------------------------------
      // Pipelines de agregação (rodados em paralelo).
      // ----------------------------------------------------------------------
      const totalsPipeline: MongoDocument[] = [
        ...matchStage,
        { $group: { _id: null, ...sumFields } },
      ];

      const byFormatPipeline: MongoDocument[] = [
        ...matchStage,
        { $group: { _id: '$mimeType', ...sumFields } },
        { $sort: { sizeBytes: -1, _id: 1 } },
      ];

      // groups: presente apenas quando groupBy é informado.
      let groupsPipeline: MongoDocument[] | null = null;
      if (groupBy === 'format') {
        groupsPipeline = byFormatPipeline;
      } else if (groupBy === 'user') {
        groupsPipeline = [
          ...matchStage,
          { $group: { _id: '$uploadedById', ...sumFields } },
          { $sort: { sizeBytes: -1, _id: 1 } },
        ];
      } else if (groupBy === 'documentType') {
        groupsPipeline = [
          ...matchStage,
          {
            $group: {
              _id: '$documentTypeId',
              ...sumFields,
              // documentTypeName já vem denormalizado no evento.
              documentTypeName: { $first: '$documentTypeName' },
            },
          },
          { $sort: { sizeBytes: -1, _id: 1 } },
        ];
      }

      const [totalsRaw, byFormatRaw, groupsRaw] = await Promise.all([
        eventsRepo.aggregate<UploadsTotalsRow>(totalsPipeline),
        eventsRepo.aggregate<UploadsByFormatRow>(byFormatPipeline),
        groupsPipeline
          ? eventsRepo.aggregate<UploadsGroupRow>(groupsPipeline)
          : Promise.resolve<UploadsGroupRow[]>([]),
      ]);

      const totals = {
        files: totalsRaw[0]?.files ?? 0,
        pages: totalsRaw[0]?.pages ?? 0,
        sizeBytes: totalsRaw[0]?.sizeBytes ?? 0,
      };

      const byFormat = byFormatRaw.map((row) => ({
        mimeType: row._id,
        files: row.files,
        pages: row.pages,
        sizeBytes: row.sizeBytes,
      }));

      // ----------------------------------------------------------------------
      // Monta `groups` com label conforme o modo de quebra.
      // ----------------------------------------------------------------------
      let groups: Array<{
        key: string | null;
        label: string | null;
        files: number;
        pages: number;
        sizeBytes: number;
      }> = [];

      if (groupBy === 'format') {
        groups = groupsRaw.map((row) => ({
          key: row._id,
          label: row._id, // key=mimeType, label=mimeType
          files: row.files,
          pages: row.pages,
          sizeBytes: row.sizeBytes,
        }));
      } else if (groupBy === 'documentType') {
        groups = groupsRaw.map((row) => ({
          key: row._id,
          // documentTypeName denormalizado; null quando o evento não tem tipo.
          label: row._id !== null ? (row.documentTypeName ?? null) : null,
          files: row.files,
          pages: row.pages,
          sizeBytes: row.sizeBytes,
        }));
      } else if (groupBy === 'user') {
        // Denormaliza o nome do usuário buscando em `users` por id.
        const groupUserIds = groupsRaw
          .map((r) => r._id)
          .filter((id): id is string => id !== null);

        const userDocs =
          groupUserIds.length > 0
            ? await db
                .collection<UserNameDoc>('users')
                .find({ id: { $in: groupUserIds } })
                .project<UserNameDoc>({ id: 1, name: 1, _id: 0 })
                .toArray()
            : [];

        const userNameById = new Map<string, string>(userDocs.map((u) => [u.id, u.name]));

        groups = groupsRaw.map((row) => ({
          key: row._id,
          label: row._id !== null ? (userNameById.get(row._id) ?? null) : null,
          files: row.files,
          pages: row.pages,
          sizeBytes: row.sizeBytes,
        }));
      }

      request.log.info(
        {
          tenantId,
          userId: request.user?.sub,
          filters: {
            dateFrom: dateFrom ?? null,
            dateTo: dateTo ?? null,
            userIds,
            mimeTypes,
            documentTypeIds,
            groupBy: groupBy ?? null,
          },
          totalFiles: totals.files,
        },
        'relatório de uploads consultado',
      );

      return reply.status(200).send({
        tenantId,
        filters: {
          dateFrom: dateFrom ?? null,
          dateTo: dateTo ?? null,
          userIds,
          mimeTypes,
          documentTypeIds,
          groupBy: groupBy ?? null,
        },
        totals,
        byFormat,
        groups,
      });
    },
  );
};
