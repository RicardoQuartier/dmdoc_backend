import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { DocumentEventsRepository } from '@dmdoc/db-pg';
import { ROLE_LEVEL, type Role } from '@dmdoc/shared-types';
import { requireRole } from '../auth/role-guard.js';
import { resolveTenantContext } from '../auth/resolve-tenant.js';
import { NotFoundError, ValidationError } from '../errors/index.js';

/**
 * Papéis visíveis a um ator segundo a regra "inferior ou igual": todos os
 * papéis cujo nível (`ROLE_LEVEL`) seja MENOR OU IGUAL ao do ator. Usado para
 * não expor, em relatórios, nome/e-mail de usuários de nível ACIMA do
 * solicitante (ex.: TENANT_ADMIN não deve ver um MULTI_TENANT_ADMIN que fez
 * upload no tenant). Ver wiki "Hierarquia de papéis e gestão de usuários".
 */
function rolesVisibleTo(actorRole: Role): Role[] {
  const actorLevel = ROLE_LEVEL[actorRole];
  return (Object.keys(ROLE_LEVEL) as Role[]).filter((r) => ROLE_LEVEL[r] <= actorLevel);
}

const TenantIdQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
});

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
  .pipe(
    z.array(
      z
        .string()
        .regex(
          /^[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*$/,
          'Invalid MIME type format',
        ),
    ),
  );

const UploadersQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
});

const UploadsReportQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  userIds: csvUuids,
  mimeTypes: csvStrings,
  documentTypeIds: csvUuids,
  groupBy: z.enum(['format', 'user', 'documentType']).optional(),
});

type TotalRow = { documents: string; pages: string };
type GroupRow = { group_key: string | null; documents: string; pages: string; label?: string | null };
type StatusRow = { status: string; count: string };
type MimeTypeRow = { group_key: string | null; files: string; pages: string; size_bytes: string };
type UserIdRow = { group_key: string | null; files: string; pages: string; size_bytes: string };
type DocTypeRow = { group_key: string | null; files: string; pages: string; size_bytes: string; document_type_name?: string | null };
type UploaderRow = { id: string; name: string; email: string };

export const reportsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /reports/documents-summary — resumo agregado dos documentos do tenant.
   */
  app.get(
    '/reports/documents-summary',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, 'TENANT_ADMIN', 'MULTI_TENANT_ADMIN');

      const { tenantId: tenantIdParam, dateFrom, dateTo } = TenantIdQuerySchema.parse(request.query);

      const ctx = resolveTenantContext(request, { explicitTenantId: tenantIdParam, write: true });

      if (ctx.mode !== 'single') {
        throw new NotFoundError('tenantId é obrigatório para esta operação');
      }

      const tenantId = ctx.tenantId;
      const sql = app.db;

      // Executa as 4 queries em paralelo
      const [totalsRaw, byDeptRaw, byTypeRaw, byStatusRaw] = await Promise.all([
        // 1. Totais globais com pageCount via LEFT JOIN em document_content
        (async (): Promise<TotalRow[]> => {
          if (dateFrom !== undefined && dateTo !== undefined) {
            return sql<TotalRow[]>`
              SELECT
                COUNT(d.id)::text AS documents,
                COALESCE(SUM(COALESCE((dc.extraction->>'pageCount')::int, 0)), 0)::text AS pages
              FROM documents d
              LEFT JOIN document_content dc ON dc.document_id = d.id AND dc.tenant_id = d.tenant_id
              WHERE d.tenant_id = ${tenantId}
                AND d.deleted = false
                AND d.uploaded_at >= ${dateFrom}
                AND d.uploaded_at <= ${dateTo}
            `;
          } else if (dateFrom !== undefined) {
            return sql<TotalRow[]>`
              SELECT
                COUNT(d.id)::text AS documents,
                COALESCE(SUM(COALESCE((dc.extraction->>'pageCount')::int, 0)), 0)::text AS pages
              FROM documents d
              LEFT JOIN document_content dc ON dc.document_id = d.id AND dc.tenant_id = d.tenant_id
              WHERE d.tenant_id = ${tenantId}
                AND d.deleted = false
                AND d.uploaded_at >= ${dateFrom}
            `;
          } else if (dateTo !== undefined) {
            return sql<TotalRow[]>`
              SELECT
                COUNT(d.id)::text AS documents,
                COALESCE(SUM(COALESCE((dc.extraction->>'pageCount')::int, 0)), 0)::text AS pages
              FROM documents d
              LEFT JOIN document_content dc ON dc.document_id = d.id AND dc.tenant_id = d.tenant_id
              WHERE d.tenant_id = ${tenantId}
                AND d.deleted = false
                AND d.uploaded_at <= ${dateTo}
            `;
          } else {
            return sql<TotalRow[]>`
              SELECT
                COUNT(d.id)::text AS documents,
                COALESCE(SUM(COALESCE((dc.extraction->>'pageCount')::int, 0)), 0)::text AS pages
              FROM documents d
              LEFT JOIN document_content dc ON dc.document_id = d.id AND dc.tenant_id = d.tenant_id
              WHERE d.tenant_id = ${tenantId}
                AND d.deleted = false
            `;
          }
        })(),

        // 2. Por departamento
        (async (): Promise<GroupRow[]> => {
          if (dateFrom !== undefined && dateTo !== undefined) {
            return sql<GroupRow[]>`
              SELECT
                d.department_id AS group_key,
                COUNT(d.id)::text AS documents,
                COALESCE(SUM(COALESCE((dc.extraction->>'pageCount')::int, 0)), 0)::text AS pages
              FROM documents d
              LEFT JOIN document_content dc ON dc.document_id = d.id AND dc.tenant_id = d.tenant_id
              WHERE d.tenant_id = ${tenantId}
                AND d.deleted = false
                AND d.uploaded_at >= ${dateFrom}
                AND d.uploaded_at <= ${dateTo}
              GROUP BY d.department_id
            `;
          } else {
            return sql<GroupRow[]>`
              SELECT
                d.department_id AS group_key,
                COUNT(d.id)::text AS documents,
                COALESCE(SUM(COALESCE((dc.extraction->>'pageCount')::int, 0)), 0)::text AS pages
              FROM documents d
              LEFT JOIN document_content dc ON dc.document_id = d.id AND dc.tenant_id = d.tenant_id
              WHERE d.tenant_id = ${tenantId}
                AND d.deleted = false
              GROUP BY d.department_id
            `;
          }
        })(),

        // 3. Por tipo de documento
        (async (): Promise<GroupRow[]> => {
          if (dateFrom !== undefined && dateTo !== undefined) {
            return sql<GroupRow[]>`
              SELECT
                d.document_type_id AS group_key,
                COUNT(d.id)::text AS documents,
                COALESCE(SUM(COALESCE((dc.extraction->>'pageCount')::int, 0)), 0)::text AS pages
              FROM documents d
              LEFT JOIN document_content dc ON dc.document_id = d.id AND dc.tenant_id = d.tenant_id
              WHERE d.tenant_id = ${tenantId}
                AND d.deleted = false
                AND d.uploaded_at >= ${dateFrom}
                AND d.uploaded_at <= ${dateTo}
              GROUP BY d.document_type_id
            `;
          } else {
            return sql<GroupRow[]>`
              SELECT
                d.document_type_id AS group_key,
                COUNT(d.id)::text AS documents,
                COALESCE(SUM(COALESCE((dc.extraction->>'pageCount')::int, 0)), 0)::text AS pages
              FROM documents d
              LEFT JOIN document_content dc ON dc.document_id = d.id AND dc.tenant_id = d.tenant_id
              WHERE d.tenant_id = ${tenantId}
                AND d.deleted = false
              GROUP BY d.document_type_id
            `;
          }
        })(),

        // 4. Por status (sem JOIN)
        (async (): Promise<StatusRow[]> => {
          if (dateFrom !== undefined && dateTo !== undefined) {
            return sql<StatusRow[]>`
              SELECT status, COUNT(*)::text AS count
              FROM documents
              WHERE tenant_id = ${tenantId}
                AND deleted = false
                AND uploaded_at >= ${dateFrom}
                AND uploaded_at <= ${dateTo}
              GROUP BY status
            `;
          } else {
            return sql<StatusRow[]>`
              SELECT status, COUNT(*)::text AS count
              FROM documents
              WHERE tenant_id = ${tenantId}
                AND deleted = false
              GROUP BY status
            `;
          }
        })(),
      ]);

      const totalDocuments = parseInt(totalsRaw[0]?.documents ?? '0', 10);
      const totalPages = parseInt(totalsRaw[0]?.pages ?? '0', 10);

      // Enriquecer departamentos com nomes
      const departmentIds = byDeptRaw
        .map((r) => r.group_key)
        .filter((id): id is string => id !== null);

      const deptNameMap = new Map<string, string>();
      if (departmentIds.length > 0) {
        const deptDocs = await sql<Array<{ id: string; name: string }>>`
          SELECT id, name FROM departments WHERE id = ANY(${departmentIds}::uuid[]) AND deleted = false
        `;
        for (const d of deptDocs) deptNameMap.set(d.id, d.name);
      }

      const byDepartment = byDeptRaw.map((row) => ({
        departmentId: row.group_key,
        departmentName: row.group_key !== null ? (deptNameMap.get(row.group_key) ?? null) : null,
        documents: parseInt(row.documents, 10),
        pages: parseInt(row.pages, 10),
      }));

      // Enriquecer tipos de documento com nomes
      const documentTypeIds = byTypeRaw
        .map((r) => r.group_key)
        .filter((id): id is string => id !== null);

      const docTypeNameMap = new Map<string, string>();
      if (documentTypeIds.length > 0) {
        const typeDocs = await sql<Array<{ id: string; name: string }>>`
          SELECT id, name FROM document_types WHERE id = ANY(${documentTypeIds}::uuid[]) AND deleted = false
        `;
        for (const d of typeDocs) docTypeNameMap.set(d.id, d.name);
      }

      const byDocumentType = byTypeRaw.map((row) => ({
        documentTypeId: row.group_key,
        documentTypeName: row.group_key !== null ? (docTypeNameMap.get(row.group_key) ?? null) : null,
        documents: parseInt(row.documents, 10),
        pages: parseInt(row.pages, 10),
      }));

      const byStatus = byStatusRaw.reduce<Record<string, number>>((acc, row) => {
        acc[row.status] = parseInt(row.count, 10);
        return acc;
      }, {});

      request.log.info(
        { tenantId, totalDocuments, totalPages, dateFrom, dateTo },
        'relatório de documentos consultado',
      );

      return reply.status(200).send({
        tenantId,
        totals: { documents: totalDocuments, pages: totalPages },
        byDepartment,
        byDocumentType,
        byStatus,
      });
    },
  );

  /**
   * GET /reports/uploads — relatório agregado de uploads da tabela document_events.
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

      if (dateFrom !== undefined && dateTo !== undefined && dateFrom > dateTo) {
        throw new ValidationError('dateFrom não pode ser posterior a dateTo');
      }

      const ctx = resolveTenantContext(request, { explicitTenantId: tenantIdParam, write: true });

      if (ctx.mode !== 'single') {
        throw new NotFoundError('tenantId é obrigatório para esta operação');
      }

      const tenantId = ctx.tenantId;
      const sql = app.db;

      const eventsRepo = new DocumentEventsRepository(sql, { tenantId });

      // Query base com filtros opcionais
      const buildEventsQuery = async <T>(
        groupByClause: string,
        extraSelectFields: string = '',
      ): Promise<T[]> => {
        // Construção dinâmica de WHERE adicional
        const conditions: string[] = [`tenant_id = '${tenantId}'`];
        if (dateFrom !== undefined) conditions.push(`created_at >= '${dateFrom.toISOString()}'`);
        if (dateTo !== undefined) conditions.push(`created_at <= '${dateTo.toISOString()}'`);
        if (userIds.length > 0) {
          const ids = userIds.map((id) => `'${id}'`).join(', ');
          conditions.push(`uploaded_by_id IN (${ids})`);
        }
        if (mimeTypes.length > 0) {
          const mimes = mimeTypes.map((m) => `'${m}'`).join(', ');
          conditions.push(`mime_type IN (${mimes})`);
        }
        if (documentTypeIds.length > 0) {
          const typeIds = documentTypeIds.map((id) => `'${id}'`).join(', ');
          conditions.push(`document_type_id IN (${typeIds})`);
        }

        const where = conditions.join(' AND ');
        const query = `
          SELECT
            ${groupByClause} AS group_key,
            COUNT(*)::text AS files,
            COALESCE(SUM(COALESCE(page_count, 0)), 0)::text AS pages,
            COALESCE(SUM(size_bytes), 0)::text AS size_bytes
            ${extraSelectFields ? `, ${extraSelectFields}` : ''}
          FROM document_events
          WHERE ${where}
          ${groupByClause !== 'NULL' ? `GROUP BY ${groupByClause}` : ''}
          ${groupByClause !== 'NULL' ? 'ORDER BY COALESCE(SUM(size_bytes), 0) DESC' : ''}
        `;
        return sql.unsafe<T[]>(query);
      };

      // Totais globais (sem GROUP BY)
      const totalsRaw = await eventsRepo.usageByMimeType(
        dateFrom ?? new Date(0),
        dateTo ?? new Date('9999-12-31'),
      );

      // Alternativa: usar SQL direto para totais
      const totalRows = await buildEventsQuery<{ group_key: null; files: string; pages: string; size_bytes: string }>('NULL');
      const totals = {
        files: parseInt(totalRows[0]?.files ?? '0', 10),
        pages: parseInt(totalRows[0]?.pages ?? '0', 10),
        sizeBytes: parseInt(totalRows[0]?.size_bytes ?? '0', 10),
      };

      // Por formato (mime_type)
      const byFormatRows = await buildEventsQuery<MimeTypeRow>('mime_type');
      const byFormat = byFormatRows.map((row) => ({
        mimeType: row.group_key,
        files: parseInt(row.files, 10),
        pages: parseInt(row.pages, 10),
        sizeBytes: parseInt(row.size_bytes, 10),
      }));

      // Groups: presente apenas quando groupBy é informado
      let groups: Array<{
        key: string | null;
        label: string | null;
        files: number;
        pages: number;
        sizeBytes: number;
      }> = [];

      if (groupBy === 'format') {
        groups = byFormatRows.map((row) => ({
          key: row.group_key,
          label: row.group_key,
          files: parseInt(row.files, 10),
          pages: parseInt(row.pages, 10),
          sizeBytes: parseInt(row.size_bytes, 10),
        }));
      } else if (groupBy === 'user') {
        const groupUserRows = await buildEventsQuery<UserIdRow>('uploaded_by_id');

        const groupUserIds = groupUserRows
          .map((r) => r.group_key)
          .filter((id): id is string => id !== null);

        // Rótulos respeitam a hierarquia: um usuário de nível ACIMA do ator
        // (ex.: MULTI_TENANT_ADMIN visto por um TENANT_ADMIN) não tem o nome
        // resolvido — o grupo mantém a contagem, mas o label cai para null,
        // não expondo a identidade de contas de nível superior.
        const userNameMap = new Map<string, string>();
        if (groupUserIds.length > 0) {
          const visibleRoles = rolesVisibleTo(request.user!.role);
          const userDocs = await sql<Array<{ id: string; name: string }>>`
            SELECT id, name FROM users
            WHERE id = ANY(${groupUserIds}::uuid[])
              AND deleted = false
              AND role = ANY(${visibleRoles}::text[])
          `;
          for (const u of userDocs) userNameMap.set(u.id, u.name);
        }

        groups = groupUserRows.map((row) => ({
          key: row.group_key,
          label: row.group_key !== null ? (userNameMap.get(row.group_key) ?? null) : null,
          files: parseInt(row.files, 10),
          pages: parseInt(row.pages, 10),
          sizeBytes: parseInt(row.size_bytes, 10),
        }));
      } else if (groupBy === 'documentType') {
        const groupTypeRows = await buildEventsQuery<DocTypeRow>(
          'document_type_id',
          'MAX(document_type_name) AS document_type_name',
        );

        groups = groupTypeRows.map((row) => ({
          key: row.group_key,
          label: row.group_key !== null ? (row.document_type_name ?? null) : null,
          files: parseInt(row.files, 10),
          pages: parseInt(row.pages, 10),
          sizeBytes: parseInt(row.size_bytes, 10),
        }));
      }

      // Silencia warnings de variáveis não usadas de usageByMimeType
      void totalsRaw;

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

  /**
   * GET /reports/uploaders — usuários que possuem ao menos um evento de upload
   * no tenant, usado para popular o filtro "Usuário" do relatório de uploads.
   *
   * Propositalmente NÃO filtra por `users.tenant_id` — a fonte de verdade é
   * `document_events.tenant_id`, o que garante que um MULTI_TENANT_ADMIN
   * (tenant_id = NULL) apareça na lista sempre que tiver feito upload neste
   * tenant, mesmo não "pertencendo" a ele.
   *
   * A inclusão cross-tenant, porém, RESPEITA a hierarquia (regra "inferior ou
   * igual"): só entram na lista uploaders cujo nível de papel seja MENOR OU
   * IGUAL ao do ator. Assim, um TENANT_ADMIN (60) não vê nome/e-mail de um
   * MULTI_TENANT_ADMIN (80) que subiu documento; um MTA e um SUPER_ADMIN seguem
   * vendo todos os níveis ≤ ao seu.
   */
  app.get(
    '/reports/uploaders',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, 'TENANT_ADMIN', 'MULTI_TENANT_ADMIN');

      const { tenantId: tenantIdParam } = UploadersQuerySchema.parse(request.query);

      const ctx = resolveTenantContext(request, { explicitTenantId: tenantIdParam, write: true });

      if (ctx.mode !== 'single') {
        throw new NotFoundError('tenantId é obrigatório para esta operação');
      }

      const tenantId = ctx.tenantId;
      const sql = app.db;
      const visibleRoles = rolesVisibleTo(request.user!.role);

      const uploaders = await sql<UploaderRow[]>`
        SELECT DISTINCT u.id, u.name, u.email
        FROM document_events de
        JOIN users u ON u.id = de.uploaded_by_id
        WHERE de.tenant_id = ${tenantId}
          AND u.role = ANY(${visibleRoles}::text[])
        ORDER BY u.name
      `;

      request.log.info(
        { tenantId, userId: request.user?.sub, count: uploaders.length },
        'lista de uploaders do relatório consultada',
      );

      return reply.status(200).send(uploaders);
    },
  );
};
