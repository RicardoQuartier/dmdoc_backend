import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { DocumentEventsRepository } from '@dmdoc/db-pg';
import { ROLE_LEVEL, type Role } from '@dmdoc/shared-types';
import { requireRole } from '../auth/role-guard.js';
import { resolveTenantContext } from '../auth/resolve-tenant.js';
import { NotFoundError, ValidationError } from '../errors/index.js';
import { escapeLikePattern } from './documents.js';

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

/**
 * Query do relatório de exclusões. `search` reaproveita EXATAMENTE o padrão de
 * `GET /documents` (`escapeLikePattern` + bind seguro via `addParam`, nunca
 * concatenado cru). Paginação por página/tamanho (offset), igual ao restante
 * do produto — diferente das demais rotas deste arquivo, que são agregados
 * sem paginação: este relatório é uma listagem linha a linha.
 */
const DeletionsReportQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  userId: z.string().uuid().optional(),
  search: z.string().optional(),
  page: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? parseInt(v, 10) : 1))
    .pipe(z.number().int().min(1)),
  pageSize: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? parseInt(v, 10) : 20))
    .pipe(z.number().min(1).max(500)),
});

type DeletionRow = {
  document_id: string;
  filename: string | null;
  action: 'document.delete' | 'document.bulk_delete';
  user_id: string | null;
  user_name: string | null;
  user_email: string | null;
  deleted_at: Date;
  restorable: boolean;
};

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

  /**
   * GET /reports/deletions — auditoria de exclusões (TENANT_ADMIN+).
   *
   * Uma linha por ARQUIVO excluído, não por evento de auditoria: uma exclusão
   * em massa grava UM registro em `audit_logs` (`document.bulk_delete`) para N
   * documentos (`metadata.documentIds`); esta rota "achata" cada evento em N
   * linhas, todas com o mesmo usuário/data/hora. `document.delete` individual
   * já é 1 documento = 1 linha (o id vem de `resource`, formato
   * `documents/{id}`).
   *
   * `metadata` pode estar com o defeito histórico de double-encoding
   * (`auth/audit.ts`, corrigido para gravações novas com `sql.json()` — ver
   * changelog do método `record`): registros ANTIGOS de `document.bulk_delete`
   * têm `jsonb_typeof(metadata) = 'string'` em vez de `'object'`, porque o
   * valor foi serializado duas vezes na escrita. A CTE abaixo normaliza os
   * dois formatos (`CASE jsonb_typeof(...) = 'string' THEN unwrap`) para não
   * perder exclusões em massa antigas do relatório.
   */
  app.get(
    '/reports/deletions',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, 'TENANT_ADMIN', 'MULTI_TENANT_ADMIN');

      const {
        tenantId: tenantIdParam,
        dateFrom,
        dateTo,
        userId,
        search,
        page,
        pageSize,
      } = DeletionsReportQuerySchema.parse(request.query);

      if (dateFrom !== undefined && dateTo !== undefined && dateFrom > dateTo) {
        throw new ValidationError('dateFrom não pode ser posterior a dateTo');
      }

      const ctx = resolveTenantContext(request, { explicitTenantId: tenantIdParam, write: true });

      if (ctx.mode !== 'single') {
        throw new NotFoundError('tenantId é obrigatório para esta operação');
      }

      const tenantId = ctx.tenantId;
      const sql = app.db;
      const visibleRoles = rolesVisibleTo(request.user!.role);

      // ------------------------------------------------------------------
      // Query dinâmica parametrizada — mesmo padrão de `GET /documents`
      // (documents.ts): `conditions`/`addParam` monta $1, $2... na ordem em
      // que cada filtro é adicionado, nunca concatenação crua de valor.
      // ------------------------------------------------------------------
      const params: unknown[] = [];
      let paramIdx = 1;
      const addParam = (val: unknown): string => {
        params.push(val);
        return `$${paramIdx++}`;
      };

      // Filtros que reduzem `audit_logs` ANTES da expansão (uma linha por
      // evento, não por documento) — tenant/data/usuário são colunas diretas
      // de `audit_logs`, então entram na CTE para não expandir eventos que já
      // sairiam filtrados.
      const cteConditions: string[] = [`a.tenant_id = ${addParam(tenantId)}`];
      if (dateFrom !== undefined) {
        cteConditions.push(`a.created_at >= ${addParam(dateFrom)}::timestamptz`);
      }
      if (dateTo !== undefined) {
        cteConditions.push(`a.created_at <= ${addParam(dateTo)}::timestamptz`);
      }
      if (userId !== undefined) {
        cteConditions.push(`a.user_id = ${addParam(userId)}`);
      }
      const cteWhere = cteConditions.join(' AND ');

      const baseQuery = `
        WITH document_deletions AS (
          -- document.delete: 1 evento = 1 documento, id extraído de "resource"
          -- (formato "documents/{id}", garantido por quem grava o audit log).
          SELECT
            a.id AS audit_log_id,
            split_part(a.resource, '/', 2) AS document_id,
            a.action,
            a.user_id,
            a.created_at
          FROM audit_logs a
          WHERE ${cteWhere} AND a.action = 'document.delete'

          UNION ALL

          -- document.bulk_delete: 1 evento = N documentos, ids expandidos de
          -- metadata.documentIds. O CASE com jsonb_typeof normaliza o defeito
          -- de double-encoding histórico (ver comentário da rota acima).
          SELECT
            a.id AS audit_log_id,
            elem.value AS document_id,
            a.action,
            a.user_id,
            a.created_at
          FROM audit_logs a
          CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(a.metadata) = 'string' THEN (a.metadata #>> '{}')::jsonb -> 'documentIds'
              ELSE a.metadata -> 'documentIds'
            END
          ) AS elem(value)
          WHERE ${cteWhere} AND a.action = 'document.bulk_delete'
        )
      `;

      // Filtro de busca livre — depende do JOIN com `documents`, então roda na
      // query EXTERNA (fora da CTE), sobre a CTE já expandida (uma linha por
      // documento). EXATAMENTE o padrão de `GET /documents`: termo sanitizado
      // por `escapeLikePattern`, nunca concatenado cru.
      const outerConditions: string[] = [];
      const trimmedSearch = search?.trim();
      if (trimmedSearch !== undefined && trimmedSearch.length > 0) {
        const searchPattern = `%${escapeLikePattern(trimmedSearch)}%`;
        const searchParam = addParam(searchPattern);
        outerConditions.push(
          `(d.original_filename ILIKE ${searchParam} ESCAPE '\\' OR d.title ILIKE ${searchParam} ESCAPE '\\')`
        );
      }
      const outerWhere = outerConditions.length > 0 ? outerConditions.join(' AND ') : 'TRUE';

      // `d.id::text = dd.document_id` (e não o inverso): `document_id` já sai
      // como TEXT da CTE (split_part/jsonb_array_elements_text) — comparar
      // como texto evita um `::uuid` explícito sobre uma string extraída de
      // jsonb, que lançaria erro de sintaxe de tipo se algum dia houvesse um
      // valor corrompido em metadata.documentIds (defesa em profundidade).
      //
      // `countParams` é um SNAPSHOT de `params` NESTE ponto — antes de alocar
      // `visibleRoles`/limit/offset (só usados no `pageQuery`). Reaproveitar o
      // array completo aqui criaria um "buraco": o texto do `countQuery` nunca
      // referencia esses parâmetros extras, e o Postgres rejeita a query com
      // "could not determine data type of parameter $N" para qualquer
      // placeholder que exista no array mas não apareça no texto.
      const countParams = [...params];
      const countQuery = `
        ${baseQuery}
        SELECT COUNT(*) AS count
        FROM document_deletions dd
        LEFT JOIN documents d ON d.id::text = dd.document_id
        WHERE ${outerWhere}
      `;
      const countRows = await sql.unsafe<Array<{ count: string }>>(
        countQuery,
        countParams as Parameters<typeof sql.unsafe>[1]
      );
      const total = parseInt(countRows[0]?.count ?? '0', 10);

      const visibleRolesParam = addParam(visibleRoles);
      const limitPlaceholder = addParam(pageSize);
      const offsetPlaceholder = addParam((page - 1) * pageSize);

      const pageQuery = `
        ${baseQuery}
        SELECT
          dd.document_id,
          COALESCE(d.title, d.original_filename) AS filename,
          dd.action,
          dd.user_id,
          u.name AS user_name,
          u.email AS user_email,
          dd.created_at AS deleted_at,
          (d.id IS NOT NULL AND d.deleted = true) AS restorable
        FROM document_deletions dd
        LEFT JOIN documents d ON d.id::text = dd.document_id
        LEFT JOIN users u ON u.id = dd.user_id AND u.role = ANY(${visibleRolesParam}::text[])
        WHERE ${outerWhere}
        ORDER BY dd.created_at DESC, dd.document_id DESC
        LIMIT ${limitPlaceholder}
        OFFSET ${offsetPlaceholder}
      `;
      const rows = await sql.unsafe<DeletionRow[]>(
        pageQuery,
        params as Parameters<typeof sql.unsafe>[1]
      );

      const items = rows.map((row) => ({
        documentId: row.document_id,
        filename: row.filename,
        action: row.action,
        userId: row.user_id,
        userName: row.user_name,
        userEmail: row.user_email,
        deletedAt: row.deleted_at,
        restorable: row.restorable,
      }));

      const pageCount = Math.ceil(total / pageSize);

      request.log.info(
        {
          tenantId,
          userId: request.user?.sub,
          total,
          returned: items.length,
          page,
          pageSize,
        },
        'relatório de exclusões consultado',
      );

      return reply.status(200).send({ items, page, pageSize, total, pageCount });
    },
  );
};
