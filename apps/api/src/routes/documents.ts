import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { MultipartFile } from '@fastify/multipart';
import {
  TenantRepository,
  DocumentEventsRepository,
  DOCUMENT_EVENTS_COLLECTION,
  newId,
  normalizeLimit,
  resolveAiFeatureFlags,
} from '@dmdoc/db-pg';
import type { TenantDocument } from '@dmdoc/db-pg';
import type { Sql } from '@dmdoc/db-pg';
import type { DocumentProcessingJobData } from '@dmdoc/shared-types';
import { DocumentProcessingJobDataSchema } from '@dmdoc/shared-types';
import type { CreateDocumentEventPgInput } from '@dmdoc/db-pg';
import { createLLMProvider, LLMError } from '@dmdoc/llm-provider';
import { NotFoundError, QuotaExceededError, ValidationError, ForbiddenError, UpstreamServiceError } from '../errors/index.js';
import { requireRole } from '../auth/role-guard.js';
import { AuditLogger } from '../auth/audit.js';
import { resolveTenantContext } from '../auth/resolve-tenant.js';
import { resolveAccessibleDepartmentIds } from '../auth/department-access.js';
import { getConfig, type Config } from '../config.js';
import { validateIndexValues, type IndexFieldRow } from '../lib/index-fields.js';
import { suggestDocumentIndexes } from '../services/index-suggestion.js';
import { SuggestIndexesResponseSchema } from '../prompts/suggest-indexes.js';

// ---------------------------------------------------------------------------
// Tipos locais que mapeiam as tabelas do PostgreSQL (spec §5.3)
// ---------------------------------------------------------------------------

interface TenantRow {
  id: string;
  name: string;
  disk_quota_bytes: bigint;
  user_quota: number;
  active: boolean;
  created_at: Date;
}

interface DocumentTypeRow extends TenantDocument {
  name: string;
  description: string | null;
  is_global: boolean;
  created_at: Date;
}

interface DocumentRow extends TenantDocument {
  tenant_id: string; // postgres.js entrega snake_case; TenantDocument.tenantId é undefined em runtime
  department_id: string;
  document_type_id: string | null;
  filename: string;
  original_filename: string;
  content_hash: string;
  size_bytes: bigint;
  mime_type: string;
  s3_key: string;
  status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';
  failure_reason: string | null;
  tags: string[];
  index_values: Record<string, string | number | null>;
  uploaded_by_id: string;
  uploaded_at: Date;
  processed_at: Date | null;
  cost_usd_cents: number;
}

// ---------------------------------------------------------------------------
// Schemas para novas rotas
// ---------------------------------------------------------------------------

/** Schema dos query params do GET /documents/:id/download. */
const DownloadQuerySchema = z.object({
  open: z.coerce.boolean().optional(),
});

/**
 * Whitelist de colunas ordenáveis do GET /documents.
 *
 * `sortBy` NUNCA é interpolado cru no `sql.unsafe` — sempre mapeado através
 * deste objeto fixo. `nullable: true` exige tratamento especial (NULLS LAST no
 * `ORDER BY` + OR-chain de nulidade no keyset do `WHERE`) — hoje só
 * `documentTypeName` (via `document_type_id`, FK nullable).
 */
const SORT_COLUMNS = {
  filename: { expr: 'd.original_filename', nullable: false },
  status: { expr: 'd.status', nullable: false },
  companyName: { expr: 't.name', nullable: false },
  documentTypeName: { expr: 'dt.name', nullable: true },
  sizeBytes: { expr: 'd.size_bytes', nullable: false },
  uploadedAt: { expr: 'd.uploaded_at', nullable: false },
  departmentName: { expr: 'dept.name', nullable: false },
  uploadedByName: { expr: 'u.name', nullable: false },
} as const satisfies Record<string, { expr: string; nullable: boolean }>;

type SortByKey = keyof typeof SORT_COLUMNS;

const SORT_BY_KEYS = Object.keys(SORT_COLUMNS) as [SortByKey, ...SortByKey[]];

/**
 * Divide uma string CSV em uma lista de itens não vazios, com trim.
 * Mesmo padrão já usado para `tags` nesta rota.
 */
function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** Schema dos query params do GET /documents. */
const ListDocumentsQuerySchema = z.object({
  tenantId: z.string().uuid().optional(), // SUPER_ADMIN apenas — filtrar por tenant específico
  departmentId: z.string().uuid().optional(), // retrocompat — single id
  departmentIds: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? splitCsv(v) : undefined))
    .pipe(z.array(z.string().uuid()).optional()),
  documentTypeId: z.string().uuid().optional(), // retrocompat — single id
  documentTypeIds: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? splitCsv(v) : undefined))
    .pipe(z.array(z.string().uuid()).optional()),
  uploadedById: z.string().uuid().optional(),
  tags: z.string().optional(), // CSV de tags
  status: z.enum(['PENDING', 'PROCESSING', 'READY', 'FAILED']).optional(),
  sortBy: z.enum(SORT_BY_KEYS).default('uploadedAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  cursor: z.string().optional(),
  limit: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? parseInt(v, 10) : 20))
    .pipe(z.number().min(1).max(500)),
});

/** Schema do body do PATCH /documents/:id. */
const PatchDocumentBodySchema = z.object({
  documentTypeId: z.string().uuid().nullable().optional(),
  indexValues: z.record(z.union([z.string(), z.number(), z.null()])).optional(),
  tags: z.array(z.string()).optional(),
});

/** Schema dos params de rotas `/documents/:id/*` que exigem um UUID válido. */
const DocumentIdParamsSchema = z.object({
  id: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

/**
 * Lê todos os bytes de um Readable em um único Buffer.
 * Necessário para calcular o sha256 e enviar ao S3.
 */
async function streamToBuffer(readable: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

/**
 * Calcula o hash SHA-256 de um buffer como string hexadecimal (64 chars).
 */
function sha256hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Sanitiza o nome original do arquivo para uso seguro como chave S3.
 * Remove caracteres especiais e preserva a extensão.
 */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

/**
 * Busca um documento pelo seu id sem filtrar por tenantId.
 *
 * Usado exclusivamente para SUPER_ADMIN, que não tem um tenantId no JWT e
 * precisa abrir qualquer documento diretamente. Retorna null se não existir
 * ou estiver soft-deleted.
 */
async function findDocumentGlobally(
  sql: Sql,
  id: string
): Promise<DocumentRow | null> {
  const rows = await sql<DocumentRow[]>`
    SELECT *
    FROM documents
    WHERE id = ${id}
      AND deleted = false
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Busca um documento pelo seu id restrito a uma lista de tenants permitidos.
 *
 * Usado exclusivamente para MULTI_TENANT_ADMIN. Retorna null se o documento
 * não existir, estiver soft-deleted, ou o tenantId não estiver na lista.
 */
async function findDocumentInTenants(
  sql: Sql,
  id: string,
  allowedTenantIds: string[]
): Promise<DocumentRow | null> {
  if (allowedTenantIds.length === 0) return null;
  const rows = await sql<DocumentRow[]>`
    SELECT *
    FROM documents
    WHERE id = ${id}
      AND tenant_id = ANY(${allowedTenantIds}::uuid[])
      AND deleted = false
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Valida se o usuário pode LER um departamento específico.
 *
 * Lança `NotFoundError` se sem permissão (spec §10, invariante 4 — nunca 403).
 */
async function assertCanReadDepartment(
  sql: Sql,
  userId: string,
  tenantId: string | null,
  departmentId: string,
  role: string
): Promise<void> {
  const accessible = await resolveAccessibleDepartmentIds(sql, userId, tenantId, role);
  if (accessible === null) {
    // Admin sem restrição de ACL: aceita qualquer departamento existente.
    // Sem `deleted = false`: departamento soft-deletado ainda dá acesso aos docs preservados.
    let exists: boolean;
    if (tenantId !== null) {
      const rows = await sql<Array<{ id: string }>>`
        SELECT id FROM departments WHERE id = ${departmentId} AND tenant_id = ${tenantId} LIMIT 1
      `;
      exists = rows.length > 0;
    } else {
      const rows = await sql<Array<{ id: string }>>`
        SELECT id FROM departments WHERE id = ${departmentId} LIMIT 1
      `;
      exists = rows.length > 0;
    }
    if (!exists) {
      throw new NotFoundError('Departamento não encontrado');
    }
    return;
  }
  if (!accessible.includes(departmentId)) {
    throw new NotFoundError('Departamento não encontrado ou sem permissão de leitura');
  }
}

/**
 * Valida se o usuário pode ESCREVER em um departamento específico.
 *
 * Lança `NotFoundError` se sem permissão.
 */
async function assertCanWriteDepartment(
  sql: Sql,
  userId: string,
  tenantId: string,
  departmentId: string,
  role: string
): Promise<void> {
  const accessible = await resolveAccessibleDepartmentIds(sql, userId, tenantId, role);
  if (accessible === null) {
    // Admin sem restrição de ACL: verifica apenas que o dept pertence ao tenant.
    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM departments WHERE id = ${departmentId} AND tenant_id = ${tenantId} LIMIT 1
    `;
    if (rows.length === 0) {
      throw new NotFoundError('Departamento não encontrado');
    }
    return;
  }
  if (!accessible.includes(departmentId)) {
    throw new NotFoundError('Departamento não encontrado ou sem permissão de escrita');
  }
}

/**
 * Resolve o `name` de um tipo de documento (tenant OU global) para denormalizar
 * no evento de upload.
 */
async function resolveDocumentTypeName(
  sql: Sql,
  tenantId: string,
  documentTypeId: string | null
): Promise<string | null> {
  if (documentTypeId === null) {
    return null;
  }
  const rows = await sql<Array<{ name: string }>>`
    SELECT name
    FROM document_types
    WHERE id = ${documentTypeId}
      AND (tenant_id = ${tenantId} OR is_global = true)
    LIMIT 1
  `;
  return rows[0]?.name ?? null;
}

/**
 * Mapeia uma linha snake_case do PostgreSQL para o formato camelCase da resposta.
 */
function rowToDocument(r: DocumentRow): Record<string, unknown> {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    departmentId: r.department_id,
    documentTypeId: r.document_type_id,
    filename: r.filename,
    originalFilename: r.original_filename,
    contentHash: r.content_hash,
    sizeBytes: Number(r.size_bytes),
    mimeType: r.mime_type,
    s3Key: r.s3_key,
    status: r.status,
    failureReason: r.failure_reason,
    tags: r.tags,
    indexValues: r.index_values,
    uploadedById: r.uploaded_by_id,
    uploadedAt: r.uploaded_at,
    processedAt: r.processed_at,
    costUsdCents: r.cost_usd_cents,
    deleted: r.deleted,
  };
}

/**
 * Linha de `documents` enriquecida com os LEFT JOINs exclusivos do
 * `GET /documents` (spec da tela de listagem — departamento/enviado
 * por/tipo/empresa). `document_type_name` é nullable porque
 * `document_type_id` é FK nullable; os demais nomes vêm de FKs `NOT NULL`.
 */
interface DocumentListRow extends DocumentRow {
  department_name: string;
  uploaded_by_name: string;
  document_type_name: string | null;
  company_name: string;
}

/**
 * Mapeia uma `DocumentListRow` (com os JOINs de listagem) para o formato
 * camelCase de resposta do `GET /documents`. Estende `rowToDocument` — nunca
 * usar em outros handlers, que fazem `SELECT d.*` puro sem esses JOINs.
 */
function rowToDocumentListItem(r: DocumentListRow): Record<string, unknown> {
  return {
    ...rowToDocument(r),
    departmentName: r.department_name,
    uploadedByName: r.uploaded_by_name,
    documentTypeName: r.document_type_name,
  };
}

// ---------------------------------------------------------------------------
// GET /documents — paginação por cursor composto (keyset)
// ---------------------------------------------------------------------------

/** Valor de ordenação serializado no cursor opaco. */
type SortCursorValue = string | number | null;

/** Payload decodificado de um cursor de listagem de documentos. */
interface ListDocumentsCursor {
  v: SortCursorValue;
  id: string;
}

const ListDocumentsCursorSchema = z.object({
  v: z.union([z.string(), z.number(), z.null()]),
  id: z.string().uuid(),
});

/**
 * Codifica um cursor opaco (base64 de `{v, id}`) a partir do valor da coluna
 * de ordenação e do `id` (tiebreaker) do último item da página.
 *
 * O cursor é opaco do ponto de vista do cliente — apenas o servidor conhece
 * o formato interno.
 */
function encodeListDocumentsCursor(value: SortCursorValue, id: string): string {
  return Buffer.from(JSON.stringify({ v: value, id })).toString('base64');
}

/**
 * Decodifica um cursor opaco de `GET /documents`.
 *
 * Lança `ValidationError` (→ 422) se o cursor estiver malformado — base64
 * inválido, JSON inválido, ou payload fora do formato `{v, id}` esperado.
 */
function decodeListDocumentsCursor(cursor: string): ListDocumentsCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
  } catch {
    throw new ValidationError('cursor inválido');
  }
  const result = ListDocumentsCursorSchema.safeParse(parsed);
  if (!result.success) {
    throw new ValidationError('cursor inválido');
  }
  return result.data;
}

/**
 * Extrai, de uma `DocumentListRow`, o valor bruto da coluna de ordenação
 * corrente — usado tanto para codificar o `nextCursor` quanto (indiretamente)
 * para validar o formato esperado do cursor recebido.
 */
function sortValueForCursor(sortBy: SortByKey, row: DocumentListRow): SortCursorValue {
  switch (sortBy) {
    case 'filename':
      return row.original_filename;
    case 'status':
      return row.status;
    case 'companyName':
      return row.company_name;
    case 'documentTypeName':
      return row.document_type_name;
    case 'sizeBytes':
      return Number(row.size_bytes);
    case 'uploadedAt':
      return row.uploaded_at.toISOString();
    case 'departmentName':
      return row.department_name;
    case 'uploadedByName':
      return row.uploaded_by_name;
  }
}

/**
 * Cast SQL explícito a aplicar ao valor de cursor de cada coluna ordenável,
 * necessário para colunas cujo tipo não é inferido corretamente a partir de
 * um parâmetro solto (datas e bigint) — mesmo padrão de `audit-logs.ts`.
 */
function sqlCastForSortColumn(sortBy: SortByKey): string {
  switch (sortBy) {
    case 'uploadedAt':
      return '::timestamptz';
    case 'sizeBytes':
      return '::bigint';
    default:
      return '';
  }
}

/**
 * Monta a condição SQL de keyset (`WHERE`) para a página seguinte de
 * `GET /documents`, dado o valor/`id` do cursor decodificado.
 *
 * Contrato: `(sortExpr, d.id) > (cursorValue, cursorId)` para ASC,
 * `<` para DESC — `d.id` como tiebreaker determinístico.
 *
 * Para colunas nullable (hoje só `documentTypeName`), nulos são sempre
 * ordenados por último (`NULLS LAST`, em ambas direções) — o keyset precisa
 * de um OR-chain de nulidade equivalente:
 *   - cursor não-nulo: próximas linhas = (nulas) OU (não-nulas "depois" do cursor)
 *   - cursor nulo: já estamos no grupo de nulos — próximas linhas = nulas com
 *     id "depois" do cursor
 */
function buildKeysetCondition(params: {
  expr: string;
  nullable: boolean;
  dirCmp: '>' | '<';
  valuePlaceholder: string;
  idPlaceholder: string;
  isNullCursor: boolean;
}): string {
  const { expr, nullable, dirCmp, valuePlaceholder, idPlaceholder, isNullCursor } = params;

  if (!nullable) {
    return `(${expr} ${dirCmp} ${valuePlaceholder} OR (${expr} = ${valuePlaceholder} AND d.id ${dirCmp} ${idPlaceholder}))`;
  }

  if (isNullCursor) {
    return `(${expr} IS NULL AND d.id ${dirCmp} ${idPlaceholder})`;
  }

  return `(${expr} IS NULL OR ${expr} ${dirCmp} ${valuePlaceholder} OR (${expr} = ${valuePlaceholder} AND d.id ${dirCmp} ${idPlaceholder}))`;
}

/**
 * Emite um evento de upload na tabela append-only `document_events`.
 *
 * Falha de emissão NUNCA derruba a operação de upload.
 */
async function emitUploadEvent(
  sql: Sql,
  log: FastifyBaseLogger,
  tenantId: string,
  input: CreateDocumentEventPgInput
): Promise<void> {
  try {
    const eventsRepo = new DocumentEventsRepository(sql, { tenantId });
    await eventsRepo.insertOne(input);
  } catch (eventError) {
    log.error(
      {
        err: eventError,
        tenantId,
        documentId: input.documentId,
        userId: input.uploadedById,
        deduplicated: input.deduplicated,
      },
      'falha ao emitir evento de upload (document_events)'
    );
  }
}

// ---------------------------------------------------------------------------
// Plugin de rotas
// ---------------------------------------------------------------------------

export interface DocumentsRoutesOptions {
  config: Config;
}

/**
 * Rotas de documentos — PostgreSQL.
 */
export const documentsRoutes: FastifyPluginAsync<DocumentsRoutesOptions> = async (app, options) => {
  const { config } = options;

  // Provider de LLM compartilhado entre as chamadas desta rota (mesmo padrão
  // de `search.ts`) — usado exclusivamente por `POST /documents/:id/suggest-indexes`.
  const llmProvider = createLLMProvider(
    {
      provider: config.LLM_PROVIDER,
      baseURL: config.LLM_BASE_URL,
      apiKey: config.LLM_API_KEY || 'placeholder',
      model: config.LLM_MODEL,
    },
    app.log,
  );
  /**
   * POST /documents — upload multipart de documento.
   */
  app.post('/documents', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN', 'UPLOADER', 'MULTI_TENANT_ADMIN');

    const userId = request.user!.sub;
    const sql = app.db;

    // ------------------------------------------------------------------
    // 1. Parse multipart
    // ------------------------------------------------------------------
    const textFields: Record<string, string> = {};
    let fileData: MultipartFile | null = null;
    let fileBuffer: Buffer | null = null;

    for await (const part of request.parts({ limits: { fileSize: app.uploadMaxBytes } })) {
      if (part.type === 'file') {
        if (fileData === null) {
          fileData = part;
          fileBuffer = await streamToBuffer(part.file);
        } else {
          part.file.resume();
        }
      } else {
        textFields[part.fieldname] = part.value as string;
      }
    }

    // Resolução de tenantId
    let tenantId: string;
    if (request.user!.role === 'MULTI_TENANT_ADMIN') {
      const explicitTenantId = textFields['tenantId'];
      if (!explicitTenantId) {
        throw new NotFoundError('MULTI_TENANT_ADMIN deve informar tenantId no upload');
      }
      if (!(request.user!.allowedTenantIds ?? []).includes(explicitTenantId)) {
        throw new NotFoundError('Empresa não encontrada');
      }
      tenantId = explicitTenantId;
    } else {
      tenantId = request.tenantId as string;
    }

    if (!fileData || !fileBuffer) {
      return reply.status(422).send({
        error: { code: 'VALIDATION_ERROR', message: 'Campo "file" é obrigatório' },
      });
    }

    const data = fileData;
    const departmentIdRaw = textFields['departmentId'];
    const documentTypeIdRaw = textFields['documentTypeId'];
    const indexValuesRaw = textFields['indexValues'];

    const FieldsSchema = z.object({
      departmentId: z.string().uuid('departmentId inválido'),
      documentTypeId: z.string().uuid('documentTypeId inválido').optional(),
      indexValues: z
        .string()
        .optional()
        .transform((v) => {
          if (v === undefined || v === '') return {};
          try {
            return z.record(z.union([z.string(), z.number(), z.null()])).parse(JSON.parse(v));
          } catch {
            throw new Error('indexValues deve ser um JSON válido');
          }
        }),
    });

    const fields_ = FieldsSchema.parse({
      departmentId: departmentIdRaw,
      documentTypeId: documentTypeIdRaw,
      indexValues: indexValuesRaw,
    });

    const { departmentId, documentTypeId, indexValues } = fields_;

    // ------------------------------------------------------------------
    // 2. Verificar permissão de escrita no departamento
    // ------------------------------------------------------------------
    const userRole = request.user!.role;
    await assertCanWriteDepartment(sql, userId, tenantId, departmentId, userRole);

    const activeDeptRows = await sql<Array<{ id: string }>>`
      SELECT id FROM departments
      WHERE id = ${departmentId}
        AND tenant_id = ${tenantId}
        AND deleted = false
      LIMIT 1
    `;
    if (activeDeptRows.length === 0) {
      throw new NotFoundError('Departamento não encontrado');
    }

    // ------------------------------------------------------------------
    // 3. Calcular SHA-256
    // ------------------------------------------------------------------
    const fileSize = fileBuffer.byteLength;
    const contentHash = sha256hex(fileBuffer);
    const originalFilename = data.filename;
    const mimeType = data.mimetype;
    const filename = sanitizeFilename(originalFilename);

    // ------------------------------------------------------------------
    // 4. Verificar cota de disco do tenant
    // ------------------------------------------------------------------
    const tenantRows = await sql<TenantRow[]>`
      SELECT id, disk_quota_bytes FROM tenants WHERE id = ${tenantId} LIMIT 1
    `;
    const tenant = tenantRows[0];
    if (!tenant) {
      throw new NotFoundError('Tenant não encontrado');
    }

    const usageRows = await sql<Array<{ total: string }>>`
      SELECT COALESCE(SUM(size_bytes), 0)::text AS total
      FROM documents
      WHERE tenant_id = ${tenantId}
        AND deleted = false
    `;
    const currentUsageBytes = BigInt(usageRows[0]?.total ?? '0');

    if (currentUsageBytes + BigInt(fileSize) > tenant.disk_quota_bytes) {
      throw new QuotaExceededError(
        `Cota de disco esgotada: uso atual ${currentUsageBytes} bytes, ` +
          `arquivo ${fileSize} bytes, limite ${tenant.disk_quota_bytes} bytes`
      );
    }

    // ------------------------------------------------------------------
    // 5. Deduplicação
    // ------------------------------------------------------------------
    const existingRows = await sql<DocumentRow[]>`
      SELECT *
      FROM documents
      WHERE tenant_id = ${tenantId}
        AND content_hash = ${contentHash}
        AND deleted = false
      LIMIT 1
    `;
    const existingDoc = existingRows[0] ?? null;

    if (existingDoc !== null && existingDoc.status !== 'FAILED') {
      const existingTypeName = await resolveDocumentTypeName(
        sql,
        tenantId,
        existingDoc.document_type_id
      );
      await emitUploadEvent(sql, request.log, tenantId, {
        documentId: existingDoc.id,
        uploadedById: userId,
        eventType: 'upload',
        mimeType,
        documentTypeId: existingDoc.document_type_id,
        documentTypeName: existingTypeName,
        sizeBytes: BigInt(fileSize),
        pageCount: null,
        deduplicated: true,
      });

      request.log.info(
        { tenantId, userId, documentId: existingDoc.id, contentHash },
        'documento deduplicado — retornando existente'
      );
      return reply
        .status(200)
        .header('X-Deduplicated', 'true')
        .send(rowToDocument(existingDoc));
    }

    // ------------------------------------------------------------------
    // 6. Validar documentTypeId (se informado)
    // ------------------------------------------------------------------
    if (documentTypeId !== undefined) {
      const tenantDocTypeRows = await sql<Array<{ id: string }>>`
        SELECT id FROM document_types
        WHERE id = ${documentTypeId}
          AND tenant_id = ${tenantId}
          AND deleted = false
        LIMIT 1
      `;
      if (tenantDocTypeRows.length === 0) {
        const globalDocTypeRows = await sql<Array<{ id: string }>>`
          SELECT id FROM document_types
          WHERE id = ${documentTypeId}
            AND is_global = true
            AND deleted = false
          LIMIT 1
        `;
        if (globalDocTypeRows.length === 0) {
          throw new NotFoundError('Tipo de documento não encontrado');
        }
      }
    }

    // ------------------------------------------------------------------
    // 7. Upload para S3
    // ------------------------------------------------------------------
    const s3Key = `tenants/${tenantId}/documents/${contentHash}/${filename}`;
    await app.s3.uploadFile({ key: s3Key, buffer: fileBuffer, mimeType });

    // ------------------------------------------------------------------
    // 8. Persistir documento no PostgreSQL com status PENDING
    // ------------------------------------------------------------------
    const documentId = newId();
    const repo = new TenantRepository<DocumentRow>(sql, 'documents', { tenantId });

    let document: DocumentRow;
    try {
      document = await repo.insertOne({
        id: documentId,
        department_id: departmentId,
        document_type_id: documentTypeId ?? null,
        filename,
        original_filename: originalFilename,
        content_hash: contentHash,
        size_bytes: BigInt(fileSize),
        mime_type: mimeType,
        s3_key: s3Key,
        status: 'PENDING',
        failure_reason: null,
        tags: [],
        index_values: indexValues as Record<string, string | number | null>,
        uploaded_by_id: userId,
        uploaded_at: new Date(),
        processed_at: null,
        cost_usd_cents: 0,
      } as Omit<DocumentRow, 'id' | 'tenantId' | 'tenant_id' | 'deleted'>);
    } catch (insertError) {
      // Rollback: remove arquivo do S3
      try {
        await app.s3.deleteFile(s3Key);
      } catch (deleteError) {
        request.log.error(
          { err: deleteError, s3Key, tenantId, userId },
          'falha ao remover arquivo do S3 no rollback'
        );
      }
      throw insertError;
    }

    // ------------------------------------------------------------------
    // 9. Enfileirar job BullMQ
    // ------------------------------------------------------------------
    const jobData: DocumentProcessingJobData = DocumentProcessingJobDataSchema.parse({
      tenantId,
      documentId: document.id,
      s3Key,
      mimeType,
    });

    if (app.queue !== null) {
      await app.queue.add('process-document', jobData, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      });
    } else {
      request.log.warn(
        { tenantId, documentId: document.id },
        'queue não configurada — job de processamento não enfileirado'
      );
    }

    // ------------------------------------------------------------------
    // 10. AuditLog
    // ------------------------------------------------------------------
    const auditLogger = new AuditLogger(sql);
    try {
      await auditLogger.record({
        tenantId,
        userId,
        action: 'document.upload',
        resource: `documents/${document.id}`,
        metadata: {
          filename: originalFilename,
          sizeBytes: fileSize,
          contentHash,
          departmentId,
          documentTypeId: documentTypeId ?? null,
        },
      });
    } catch (auditError) {
      request.log.error(
        { err: auditError, tenantId, userId, documentId: document.id },
        'falha ao registrar audit log de upload'
      );
    }

    // ------------------------------------------------------------------
    // 11. Evento de upload
    // ------------------------------------------------------------------
    const documentTypeName = await resolveDocumentTypeName(
      sql,
      tenantId,
      documentTypeId ?? null
    );
    await emitUploadEvent(sql, request.log, tenantId, {
      documentId: document.id,
      uploadedById: userId,
      eventType: 'upload',
      mimeType,
      documentTypeId: documentTypeId ?? null,
      documentTypeName,
      sizeBytes: BigInt(fileSize),
      pageCount: null,
      deduplicated: false,
    });

    request.log.info(
      { tenantId, userId, documentId: document.id, sizeBytes: fileSize, contentHash },
      'documento enviado com sucesso'
    );

    return reply.status(201).send(rowToDocument(document));
  });

  // =========================================================================
  // GET /documents — listagem paginada com filtros
  // =========================================================================
  app.get('/documents', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.user!.sub;
    const role = request.user!.role;
    const sql = app.db;

    const query = ListDocumentsQuerySchema.parse(request.query);

    const tenantContext = resolveTenantContext(request, { explicitTenantId: query.tenantId, write: false });

    const effectiveTenantId: string | null =
      tenantContext.mode === 'single' ? tenantContext.tenantId : null;

    // ------------------------------------------------------------------
    // 1. Resolver departamentos acessíveis
    // ------------------------------------------------------------------
    const readableDepartmentIds = await resolveAccessibleDepartmentIds(
      sql,
      userId,
      effectiveTenantId,
      role
    );

    // `departmentIds` (multi-seleção) tem prioridade; `departmentId` singular
    // é mantido por retrocompatibilidade e tratado como lista de 1 elemento.
    // Cada id é validado individualmente (existência + ACL) — nunca só o
    // primeiro.
    const requestedDepartmentIds: string[] | undefined =
      query.departmentIds ?? (query.departmentId !== undefined ? [query.departmentId] : undefined);

    if (requestedDepartmentIds !== undefined) {
      for (const deptId of requestedDepartmentIds) {
        await assertCanReadDepartment(sql, userId, effectiveTenantId, deptId, role);
      }
    }

    // ------------------------------------------------------------------
    // 2. Montar query SQL parametrizada
    // ------------------------------------------------------------------
    const conditions: string[] = ['d.deleted = false'];
    const params: unknown[] = [];
    let paramIdx = 1;

    const addParam = (val: unknown): string => {
      params.push(val);
      return `$${paramIdx++}`;
    };

    if (tenantContext.mode === 'single') {
      conditions.push(`d.tenant_id = ${addParam(tenantContext.tenantId)}`);
    } else if (tenantContext.mode === 'allowed') {
      conditions.push(`d.tenant_id = ANY(${addParam(tenantContext.tenantIds)}::uuid[])`);
    }
    // mode: 'all' (SUPER_ADMIN sem tenantId) — sem filtro de tenant

    // Restrição de departamentos por role — `requestedDepartmentIds` já foi
    // validado (existência + ACL) acima via `assertCanReadDepartment`.
    if (requestedDepartmentIds !== undefined) {
      conditions.push(`d.department_id = ANY(${addParam(requestedDepartmentIds)}::uuid[])`);
    } else if (readableDepartmentIds !== null) {
      conditions.push(`d.department_id = ANY(${addParam(readableDepartmentIds)}::uuid[])`);
    }

    // `documentTypeIds` (multi-seleção) tem prioridade; `documentTypeId`
    // singular é mantido por retrocompatibilidade e tratado como lista de 1.
    const requestedDocumentTypeIds: string[] | undefined =
      query.documentTypeIds ?? (query.documentTypeId !== undefined ? [query.documentTypeId] : undefined);

    if (requestedDocumentTypeIds !== undefined) {
      conditions.push(`d.document_type_id = ANY(${addParam(requestedDocumentTypeIds)}::uuid[])`);
    }

    if (query.uploadedById !== undefined) {
      conditions.push(`d.uploaded_by_id = ${addParam(query.uploadedById)}`);
    }

    if (query.status !== undefined) {
      conditions.push(`d.status = ${addParam(query.status)}`);
    }

    if (query.tags !== undefined) {
      const tagList = splitCsv(query.tags);
      if (tagList.length > 0) {
        // PostgreSQL: tags @> ARRAY[...] (contém TODOS)
        conditions.push(`d.tags @> ${addParam(tagList)}::text[]`);
      }
    }

    const whereClause = conditions.join(' AND ');
    const limit = normalizeLimit(query.limit);

    // Total (sem cursor, sem JOINs — nenhum filtro depende das tabelas
    // relacionadas, só a ordenação/exibição da página precisa delas).
    const countQuery = `SELECT COUNT(*) AS count FROM documents d WHERE ${whereClause}`;
    const countRows = await sql.unsafe<Array<{ count: string }>>(countQuery, params as Parameters<typeof sql.unsafe>[1]);
    const total = parseInt(countRows[0]?.count ?? '0', 10);

    // ------------------------------------------------------------------
    // 3. Página com paginação por cursor composto (keyset)
    // ------------------------------------------------------------------
    const sortBy = query.sortBy;
    const sortDir = query.sortDir;
    const sortColumn = SORT_COLUMNS[sortBy];
    const dirSql = sortDir === 'asc' ? 'ASC' : 'DESC';
    const dirCmp = sortDir === 'asc' ? '>' : '<';

    const pageConditions = [...conditions];
    const pageParams = [...params];
    let pageParamIdx = paramIdx;

    const addPageParam = (val: unknown): string => {
      pageParams.push(val);
      return `$${pageParamIdx++}`;
    };

    if (query.cursor !== undefined) {
      const decoded = decodeListDocumentsCursor(query.cursor);
      const isNullCursor = decoded.v === null;
      if (isNullCursor && !sortColumn.nullable) {
        // Cursor com valor nulo só é válido para a coluna nullable
        // (`documentTypeName`) — indica cursor de outro `sortBy` reaproveitado
        // incorretamente. Nunca deixa isso virar SQL malformado (valuePlaceholder
        // vazio) — trata como cursor inválido (422).
        throw new ValidationError('cursor inválido para a coluna de ordenação atual');
      }
      const valuePlaceholder = isNullCursor
        ? ''
        : `${addPageParam(decoded.v)}${sqlCastForSortColumn(sortBy)}`;
      const idPlaceholder = addPageParam(decoded.id);
      pageConditions.push(
        buildKeysetCondition({
          expr: sortColumn.expr,
          nullable: sortColumn.nullable,
          dirCmp,
          valuePlaceholder,
          idPlaceholder,
          isNullCursor,
        })
      );
    }
    const limitPlaceholder = addPageParam(limit + 1);

    const orderByClause = sortColumn.nullable
      ? `${sortColumn.expr} ${dirSql} NULLS LAST, d.id ${dirSql}`
      : `${sortColumn.expr} ${dirSql}, d.id ${dirSql}`;

    const pageQuery = `
      SELECT d.*,
        dept.name AS department_name,
        u.name AS uploaded_by_name,
        dt.name AS document_type_name,
        t.name AS company_name
      FROM documents d
      LEFT JOIN departments dept ON dept.id = d.department_id
      LEFT JOIN users u ON u.id = d.uploaded_by_id
      LEFT JOIN document_types dt ON dt.id = d.document_type_id
      LEFT JOIN tenants t ON t.id = d.tenant_id
      WHERE ${pageConditions.join(' AND ')}
      ORDER BY ${orderByClause}
      LIMIT ${limitPlaceholder}
    `;

    const docs = await sql.unsafe<DocumentListRow[]>(pageQuery, pageParams as Parameters<typeof sql.unsafe>[1]);

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;
    const last = page.at(-1);
    const nextCursor =
      hasMore && last ? encodeListDocumentsCursor(sortValueForCursor(sortBy, last), last.id) : null;

    request.log.info(
      { tenantId: effectiveTenantId, userId, total, returned: page.length, sortBy, sortDir },
      'listagem de documentos'
    );

    return reply.status(200).send({ items: page.map(rowToDocumentListItem), nextCursor, total });
  });

  // =========================================================================
  // GET /documents/:id — detalhe de documento
  // =========================================================================
  app.get('/documents/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.user!.sub;
    const role = request.user!.role;
    const sql = app.db;

    const { id } = request.params as { id: string };

    let doc: DocumentRow | null;

    if (role === 'SUPER_ADMIN') {
      doc = await findDocumentGlobally(sql, id);
    } else if (role === 'MULTI_TENANT_ADMIN') {
      doc = await findDocumentInTenants(sql, id, request.user?.allowedTenantIds ?? []);
    } else {
      const tenantId = request.tenantId as string;
      const repo = new TenantRepository<DocumentRow>(sql, 'documents', { tenantId });
      doc = await repo.findById(id);
    }

    if (!doc) {
      throw new NotFoundError('Documento não encontrado');
    }

    await assertCanReadDepartment(sql, userId, doc.tenant_id, doc.department_id, role);

    // Enriquece com pageCount de document_content
    const contentRows = await sql<Array<{ extraction: { pageCount?: number } | null }>>`
      SELECT extraction
      FROM document_content
      WHERE document_id = ${doc.id}
        AND tenant_id = ${doc.tenant_id}
      LIMIT 1
    `;
    const pageCount =
      typeof contentRows[0]?.extraction?.pageCount === 'number'
        ? contentRows[0].extraction.pageCount
        : null;

    request.log.info(
      { tenantId: doc.tenant_id, userId, documentId: doc.id },
      'detalhe de documento recuperado'
    );

    return reply.status(200).send({ ...rowToDocument(doc), pageCount });
  });

  // =========================================================================
  // GET /documents/:id/download — URL assinada S3
  // =========================================================================
  app.get('/documents/:id/download', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.user!.sub;
    const role = request.user!.role;
    const sql = app.db;

    const { id } = request.params as { id: string };

    let doc: DocumentRow | null;

    if (role === 'SUPER_ADMIN') {
      doc = await findDocumentGlobally(sql, id);
    } else if (role === 'MULTI_TENANT_ADMIN') {
      doc = await findDocumentInTenants(sql, id, request.user?.allowedTenantIds ?? []);
    } else {
      const tenantId = request.tenantId as string;
      const repo = new TenantRepository<DocumentRow>(sql, 'documents', { tenantId });
      doc = await repo.findById(id);
    }

    if (!doc) {
      throw new NotFoundError('Documento não encontrado');
    }

    await assertCanReadDepartment(sql, userId, doc.tenant_id, doc.department_id, role);

    const { open } = DownloadQuerySchema.parse(request.query);
    const expiresInSeconds = 300;
    const contentDisposition =
      open === true
        ? `attachment; filename="${encodeURIComponent(doc.original_filename)}"`
        : undefined;
    const url = await app.s3.getSignedDownloadUrl(doc.s3_key, expiresInSeconds, contentDisposition);
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

    const auditLogger = new AuditLogger(sql);
    try {
      await auditLogger.record({
        tenantId: doc.tenant_id,
        userId,
        action: 'document.download',
        resource: `documents/${doc.id}`,
        metadata: { filename: doc.original_filename, s3Key: doc.s3_key },
      });
    } catch (auditError) {
      request.log.error(
        { err: auditError, tenantId: doc.tenant_id, userId, documentId: doc.id },
        'falha ao registrar audit log de download'
      );
    }

    request.log.info(
      { tenantId: doc.tenant_id, userId, documentId: doc.id },
      'URL de download gerada'
    );

    return reply.status(200).send({ url, expiresAt });
  });

  // =========================================================================
  // GET /documents/:id/preview — converte Office→PDF via extractor e devolve PDF
  // =========================================================================
  app.get('/documents/:id/preview', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.user!.sub;
    const role = request.user!.role;
    const sql = app.db;

    const { id } = request.params as { id: string };

    let doc: DocumentRow | null;

    if (role === 'SUPER_ADMIN') {
      doc = await findDocumentGlobally(sql, id);
    } else if (role === 'MULTI_TENANT_ADMIN') {
      doc = await findDocumentInTenants(sql, id, request.user?.allowedTenantIds ?? []);
    } else {
      const tenantId = request.tenantId as string;
      const repo = new TenantRepository<DocumentRow>(sql, 'documents', { tenantId });
      doc = await repo.findById(id);
    }

    if (!doc) {
      throw new NotFoundError('Documento não encontrado');
    }

    await assertCanReadDepartment(sql, userId, doc.tenant_id, doc.department_id, role);

    const CONVERTIBLE_MIMES = new Set([
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/vnd.oasis.opendocument.presentation',
      'application/vnd.oasis.opendocument.text',
    ]);

    if (!CONVERTIBLE_MIMES.has(doc.mime_type)) {
      return reply.status(422).send({ error: `mime type não suportado para preview: ${doc.mime_type}` });
    }

    const fileBuffer = await app.s3.downloadFile(doc.s3_key);

    const { EXTRACTOR_URL } = getConfig();
    const extractorBaseUrl = EXTRACTOR_URL.replace(/\/extract$/, '');
    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer], { type: doc.mime_type }), doc.original_filename);
    formData.append('content_type', doc.mime_type);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 70_000);

    let pdfBuffer: Buffer;
    try {
      const extractorResponse = await fetch(`${extractorBaseUrl}/convert/pdf`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      if (!extractorResponse.ok) {
        const errText = await extractorResponse.text().catch(() => '');
        request.log.error(
          { tenantId: doc.tenant_id, userId, documentId: doc.id, status: extractorResponse.status, body: errText },
          'extractor retornou erro na conversão'
        );
        return reply.status(502).send({ error: 'falha na conversão do documento' });
      }

      pdfBuffer = Buffer.from(await extractorResponse.arrayBuffer());
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError') {
        return reply.status(504).send({ error: 'timeout na conversão do documento' });
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    const auditLogger = new AuditLogger(sql);
    try {
      await auditLogger.record({
        tenantId: doc.tenant_id,
        userId,
        action: 'document.preview',
        resource: `documents/${doc.id}`,
        metadata: { filename: doc.original_filename, mimeType: doc.mime_type },
      });
    } catch (auditError) {
      request.log.error(
        { err: auditError, tenantId: doc.tenant_id, userId, documentId: doc.id },
        'falha ao registrar audit log de preview'
      );
    }

    request.log.info(
      { tenantId: doc.tenant_id, userId, documentId: doc.id, mimeType: doc.mime_type },
      'preview PDF gerado via extractor'
    );

    return reply
      .status(200)
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename="${doc.id}.pdf"`)
      .send(pdfBuffer);
  });

  // =========================================================================
  // PATCH /documents/:id — edição manual de tipo, índices e tags
  // =========================================================================
  app.patch('/documents/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.user!.sub;
    const role = request.user!.role;
    const sql = app.db;

    const { id } = request.params as { id: string };

    const body = PatchDocumentBodySchema.parse(request.body);

    let doc: DocumentRow | null;

    if (role === 'SUPER_ADMIN') {
      doc = await findDocumentGlobally(sql, id);
    } else if (role === 'MULTI_TENANT_ADMIN') {
      doc = await findDocumentInTenants(sql, id, request.user?.allowedTenantIds ?? []);
    } else {
      const tenantId = request.tenantId as string;
      const repo = new TenantRepository<DocumentRow>(sql, 'documents', { tenantId });
      doc = await repo.findById(id);
    }

    if (!doc) {
      throw new NotFoundError('Documento não encontrado');
    }

    const tenantId = doc.tenant_id;
    const repo = new TenantRepository<DocumentRow>(sql, 'documents', { tenantId });

    await assertCanWriteDepartment(sql, userId, tenantId, doc.department_id, role);

    // Determina o documentTypeId efetivo após o patch
    const effectiveDocumentTypeId: string | null =
      'documentTypeId' in body
        ? (body.documentTypeId ?? null)
        : (doc.document_type_id ?? null);

    if (body.documentTypeId !== undefined && body.documentTypeId !== null) {
      const tenantDocTypeRows = await sql<Array<{ id: string }>>`
        SELECT id FROM document_types
        WHERE id = ${body.documentTypeId}
          AND tenant_id = ${tenantId}
          AND deleted = false
        LIMIT 1
      `;
      if (tenantDocTypeRows.length === 0) {
        const globalDocTypeRows = await sql<Array<{ id: string }>>`
          SELECT id FROM document_types
          WHERE id = ${body.documentTypeId}
            AND is_global = true
            AND deleted = false
          LIMIT 1
        `;
        if (globalDocTypeRows.length === 0) {
          throw new NotFoundError('Tipo de documento não encontrado');
        }
      }
    }

    // Validar indexValues contra indexFields do tipo efetivo
    if (body.indexValues !== undefined && effectiveDocumentTypeId !== null) {
      const indexFieldRows = await sql<IndexFieldRow[]>`
        SELECT dtif.*
        FROM document_type_index_fields dtif
        WHERE dtif.document_type_id = ${effectiveDocumentTypeId}
      `;

      const validationErrors = validateIndexValues(
        body.indexValues as Record<string, string | number | null>,
        indexFieldRows
      );
      if (validationErrors.length > 0) {
        return reply.status(422).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Valores de índice inválidos',
            details: validationErrors,
          },
        });
      }
    }

    // Montar update parcial (snake_case para TenantRepository)
    const updateData: Partial<Omit<DocumentRow, 'id' | 'tenantId' | 'deleted'>> = {};

    if ('documentTypeId' in body) {
      updateData.document_type_id = body.documentTypeId ?? null;
    }
    if (body.indexValues !== undefined) {
      updateData.index_values = body.indexValues as Record<string, string | number | null>;
    }
    if (body.tags !== undefined) {
      updateData.tags = body.tags;
    }

    if (Object.keys(updateData).length === 0) {
      return reply.status(200).send(rowToDocument(doc));
    }

    const updated = await repo.updateById(id, updateData);

    if (!updated) {
      throw new NotFoundError('Documento não encontrado');
    }

    if (body.documentTypeId !== undefined) {
      const newDocTypeName = await resolveDocumentTypeName(sql, tenantId, body.documentTypeId ?? null);
      const eventsRepo = new DocumentEventsRepository(sql, { tenantId });
      try {
        await eventsRepo.syncDocumentType(id, body.documentTypeId ?? null, newDocTypeName);
      } catch (syncError) {
        request.log.error(
          { err: syncError, tenantId, userId, documentId: id },
          'falha ao sincronizar document_events após atualização de tipo'
        );
      }
    }

    const auditLogger = new AuditLogger(sql);
    try {
      await auditLogger.record({
        tenantId,
        userId,
        action: 'document.update',
        resource: `documents/${doc.id}`,
        metadata: { changedFields: Object.keys(body) },
      });
    } catch (auditError) {
      request.log.error(
        { err: auditError, tenantId, userId, documentId: doc.id },
        'falha ao registrar audit log de atualização de documento'
      );
    }

    request.log.info(
      { tenantId, userId, documentId: doc.id, changedFields: Object.keys(body) },
      'documento atualizado'
    );

    return reply.status(200).send(rowToDocument(updated as DocumentRow));
  });

  // =========================================================================
  // DELETE /documents/:id — exclusão lógica + limpeza de chunks/S3
  // =========================================================================
  app.delete('/documents/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.user!.sub;
    const role = request.user!.role;
    const sql = app.db;

    const { id } = request.params as { id: string };

    let doc: DocumentRow | null;

    if (role === 'SUPER_ADMIN') {
      doc = await findDocumentGlobally(sql, id);
    } else if (role === 'MULTI_TENANT_ADMIN') {
      doc = await findDocumentInTenants(sql, id, request.user?.allowedTenantIds ?? []);
    } else {
      const tenantId = request.tenantId as string;
      const repo = new TenantRepository<DocumentRow>(sql, 'documents', { tenantId });
      doc = await repo.findById(id);
    }

    if (!doc) {
      throw new NotFoundError('Documento não encontrado');
    }

    const tenantId = doc.tenant_id;
    const repo = new TenantRepository<DocumentRow>(sql, 'documents', { tenantId });

    await assertCanWriteDepartment(sql, userId, tenantId, doc.department_id, role);

    await repo.softDelete(id);

    // Remove chunks e document_content
    await Promise.all([
      sql`DELETE FROM chunks WHERE document_id = ${id} AND tenant_id = ${tenantId}`,
      sql`DELETE FROM document_content WHERE document_id = ${id} AND tenant_id = ${tenantId}`,
    ]);

    // Remove o arquivo do S3
    await app.s3.deleteFile(doc.s3_key).catch((s3Err: unknown) => {
      request.log.error({ err: s3Err, s3Key: doc.s3_key }, 'falha ao remover arquivo do S3');
    });

    const auditLogger = new AuditLogger(sql);
    try {
      await auditLogger.record({
        tenantId,
        userId,
        action: 'document.delete',
        resource: `documents/${doc.id}`,
        metadata: { filename: doc.filename, s3Key: doc.s3_key },
      });
    } catch (auditError) {
      request.log.error(
        { err: auditError, tenantId, userId, documentId: doc.id },
        'falha ao registrar audit log de exclusão'
      );
    }

    request.log.info({ tenantId, userId, documentId: doc.id }, 'documento excluído');

    return reply.status(204).send();
  });

  // =========================================================================
  // POST /documents/:id/reprocess — reenfileira job para documento FAILED
  // =========================================================================
  app.post('/documents/:id/reprocess', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.user!.sub;
    const role = request.user!.role;
    const sql = app.db;

    const { id } = request.params as { id: string };

    let doc: DocumentRow | null;

    if (role === 'SUPER_ADMIN') {
      doc = await findDocumentGlobally(sql, id);
    } else if (role === 'MULTI_TENANT_ADMIN') {
      doc = await findDocumentInTenants(sql, id, request.user?.allowedTenantIds ?? []);
    } else {
      const tenantId = request.tenantId as string;
      const repo = new TenantRepository<DocumentRow>(sql, 'documents', { tenantId });
      doc = await repo.findById(id);
    }

    if (!doc) {
      throw new NotFoundError('Documento não encontrado');
    }

    if (doc.status === 'PROCESSING' || doc.status === 'PENDING') {
      return reply.status(409).send({
        error: 'Conflict',
        message: `Reprocessamento não pode ser iniciado enquanto o documento está ${doc.status}.`,
      });
    }

    const tenantId = doc.tenant_id;
    const repo = new TenantRepository<DocumentRow>(sql, 'documents', { tenantId });

    await assertCanWriteDepartment(sql, userId, tenantId, doc.department_id, role);

    // Limpa conteúdo anterior
    await sql`DELETE FROM document_content WHERE document_id = ${id} AND tenant_id = ${tenantId}`;
    await sql`DELETE FROM chunks WHERE document_id = ${id} AND tenant_id = ${tenantId}`;

    const updated = await repo.updateById(id, {
      status: 'PENDING',
      failure_reason: null,
    } as Partial<Omit<DocumentRow, 'id' | 'tenantId' | 'deleted'>>);

    if (!updated) {
      throw new NotFoundError('Documento não encontrado');
    }

    const jobData: DocumentProcessingJobData = DocumentProcessingJobDataSchema.parse({
      tenantId,
      documentId: doc.id,
      s3Key: doc.s3_key,
      mimeType: doc.mime_type,
    });

    if (app.queue !== null) {
      await app.queue.add('process-document', jobData, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      });
    } else {
      request.log.warn(
        { tenantId, documentId: doc.id },
        'queue não configurada — job de reprocessamento não enfileirado'
      );
    }

    const auditLogger = new AuditLogger(sql);
    try {
      await auditLogger.record({
        tenantId,
        userId,
        action: 'document.reprocess',
        resource: `documents/${doc.id}`,
        metadata: { previousFailureReason: doc.failure_reason },
      });
    } catch (auditError) {
      request.log.error(
        { err: auditError, tenantId, userId, documentId: doc.id },
        'falha ao registrar audit log de reprocessamento'
      );
    }

    request.log.info(
      { tenantId, userId, documentId: doc.id },
      'documento reenfileirado para reprocessamento'
    );

    return reply.status(202).send(rowToDocument(updated as DocumentRow));
  });

  // =========================================================================
  // GET /documents/:id/status-stream — SSE de status de processamento
  // =========================================================================
  app.get('/documents/:id/status-stream', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.user!.sub;
    const role = request.user!.role;
    const sql = app.db;

    const { id } = request.params as { id: string };

    let doc: DocumentRow | null;

    if (role === 'SUPER_ADMIN') {
      doc = await findDocumentGlobally(sql, id);
    } else if (role === 'MULTI_TENANT_ADMIN') {
      doc = await findDocumentInTenants(sql, id, request.user?.allowedTenantIds ?? []);
    } else {
      const tenantId = request.tenantId as string;
      const repo = new TenantRepository<DocumentRow>(sql, 'documents', { tenantId });
      doc = await repo.findById(id);
    }

    if (!doc) {
      throw new NotFoundError('Documento não encontrado');
    }

    await assertCanReadDepartment(sql, userId, doc.tenant_id, doc.department_id, role);

    const tenantId = doc.tenant_id;

    reply.hijack();

    const origin = (request.headers['origin'] as string | undefined) ?? '*';
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
    });

    const TERMINAL = new Set(['READY', 'FAILED']);

    const formatSSE = (data: unknown): string =>
      `event: status\ndata: ${JSON.stringify(data)}\n\n`;

    const sendStatus = async (): Promise<boolean> => {
      const rows = await sql<Array<{ status: string; failure_reason: string | null }>>`
        SELECT status, failure_reason
        FROM documents
        WHERE id = ${id}
          AND tenant_id = ${tenantId}
        LIMIT 1
      `;
      const current = rows[0];
      if (!current) return true;
      reply.raw.write(formatSSE({ status: current.status, failureReason: current.failure_reason ?? null }));
      return TERMINAL.has(current.status);
    };

    const alreadyDone = await sendStatus();
    if (alreadyDone) {
      reply.raw.end();
      return;
    }

    const interval = setInterval(() => {
      void sendStatus().then((done) => {
        if (done) {
          clearInterval(interval);
          reply.raw.end();
        }
      });
    }, 2000);

    reply.raw.on('close', () => {
      clearInterval(interval);
    });
  });

  // =========================================================================
  // POST /documents/:id/suggest-indexes — sugestão de valores de índice por IA
  // (Fase 7, entregável #55). Sob demanda — nunca roda automaticamente no
  // worker. Requer `documentTypeId` já definido (checado pelo próprio service
  // `suggestDocumentIndexes`, que lança `ValidationError` caso contrário).
  // =========================================================================
  app.post('/documents/:id/suggest-indexes', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.user!.sub;
    const role = request.user!.role;
    const sql = app.db;

    const { id } = DocumentIdParamsSchema.parse(request.params);

    // ------------------------------------------------------------------
    // 1. Resolve o documento respeitando o escopo do role (mesmo padrão de
    //    GET/PATCH/DELETE) — documento de outro tenant sempre vira 404, nunca
    //    403 (spec §10, invariante 4).
    // ------------------------------------------------------------------
    let doc: DocumentRow | null;
    if (role === 'SUPER_ADMIN') {
      doc = await findDocumentGlobally(sql, id);
    } else if (role === 'MULTI_TENANT_ADMIN') {
      doc = await findDocumentInTenants(sql, id, request.user?.allowedTenantIds ?? []);
    } else {
      const tenantId = request.tenantId as string;
      const repo = new TenantRepository<DocumentRow>(sql, 'documents', { tenantId });
      doc = await repo.findById(id);
    }

    if (!doc) {
      throw new NotFoundError('Documento não encontrado');
    }

    const tenantId = doc.tenant_id;

    // Sugestão de índices é uma escrita (persiste `document_content.index_suggestion`
    // e incrementa custo) — exige a mesma permissão de escrita no departamento
    // usada em PATCH/DELETE.
    await assertCanWriteDepartment(sql, userId, tenantId, doc.department_id, role);

    const log = request.log.child({ tenantId, documentId: id, userId, traceId: request.id });

    // ------------------------------------------------------------------
    // 2. Feature flag de IA (Fase 6.9, entregável #71) — checa o valor
    //    efetivo (plataforma AND empresa) ANTES de chamar o LLM.
    // ------------------------------------------------------------------
    const aiFlags = await resolveAiFeatureFlags(sql, tenantId);
    if (!aiFlags.indexSuggestionEnabled) {
      log.info({}, 'sugestão de índices por IA desabilitada para esta empresa — LLM não chamado');
      throw new ForbiddenError('Sugestão de índices por IA está desabilitada para esta empresa');
    }

    // ------------------------------------------------------------------
    // 3. Chama o service (que também valida `documentTypeId` e o `content`
    //    processado — NotFoundError/ValidationError propagam para o error
    //    handler central, mapeando para 404/422 automaticamente). Falha do
    //    provedor de LLM (chave inválida/ausente, provedor fora do ar) vira
    //    502 com mensagem clara — não é um bug do DMDoc, é upstream.
    // ------------------------------------------------------------------
    let result: Awaited<ReturnType<typeof suggestDocumentIndexes>>;
    try {
      result = await suggestDocumentIndexes(
        { tenantId, documentId: id },
        { sql, llmProvider, logger: log }
      );
    } catch (err) {
      if (err instanceof LLMError) {
        log.error({ err }, 'sugestão de índices falhou por erro do provedor de LLM');
        throw new UpstreamServiceError(
          'Não foi possível gerar a sugestão agora — falha ao chamar o provedor de IA. Tente novamente em instantes.'
        );
      }
      throw err;
    }

    // ------------------------------------------------------------------
    // 4. Monta a resposta HTTP `{ fields: [{ name, value, confidence }] }`
    //    (spec §7) combinando a confiança bruta devolvida pelo LLM
    //    (`rawResponse`, no formato validado por `SuggestIndexesResponseSchema`)
    //    com o valor JÁ normalizado/validado (`indexSuggestion.values`) — nunca
    //    expõe o valor cru quando ele foi descartado na normalização/validação
    //    (campo sem sugestão válida sempre aparece com `value: null`).
    // ------------------------------------------------------------------
    const rawParsed = SuggestIndexesResponseSchema.safeParse(result.indexSuggestion.rawResponse);
    const fields = rawParsed.success
      ? rawParsed.data.fields.map((f) => ({
          name: f.name,
          value: result.indexSuggestion.values[f.name] ?? null,
          confidence: f.confidence,
        }))
      : [];

    log.info(
      {
        fieldsRequested: fields.length,
        fieldsSuggested: fields.filter((f) => f.value !== null).length,
        costUsd: result.costUsd,
      },
      'sugestão de índices retornada'
    );

    return reply.status(200).send({
      fields,
      model: result.indexSuggestion.model,
      promptVersion: result.indexSuggestion.promptVersion,
      suggestedAt: result.indexSuggestion.suggestedAt,
      costUsd: result.costUsd,
    });
  });
};
