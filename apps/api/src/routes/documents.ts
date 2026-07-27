import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { MultipartFile } from '@fastify/multipart';
import {
  TenantRepository,
  DocumentEventsRepository,
  DOCUMENT_EVENTS_COLLECTION,
  newId,
  resolveAiFeatureFlags,
  createAiReprocessBatch,
  getAiReprocessBatch,
  getAiReprocessBatchGlobal,
  getAiReprocessBatchInTenants,
  createDocumentReprocessBatch,
  getDocumentReprocessBatch,
  getDocumentReprocessBatchGlobal,
  getDocumentReprocessBatchInTenants,
  deriveDocumentReprocessBatchProgress,
  type AiReprocessBatchRecord,
  type AiReprocessBatchStep,
  type DocumentReprocessBatchRecord,
} from '@dmdoc/db-pg';
import type { TenantDocument } from '@dmdoc/db-pg';
import type { Sql, JSONValue } from '@dmdoc/db-pg';
import type {
  DocumentProcessingJobData,
  ExtractionResult,
  IndexSuggestion,
  TypeSuggestion,
  CostBreakdown,
} from '@dmdoc/shared-types';
import {
  DocumentProcessingJobDataSchema,
  PublicTypeSuggestionSchema,
  PublicIndexSuggestionSchema,
  PublicSuggestedTagsSchema,
  MAX_GENERATED_TAGS,
  MAX_TAG_LENGTH,
  mergeConfirmedTags,
  ADMIN_ROLES,
  ROLE_LEVEL,
  RoleSchema,
  AiReprocessJobDataSchema,
  AI_REPROCESS_STEPS,
  AiReprocessStepSchema,
  type AiReprocessStep,
} from '@dmdoc/shared-types';
import type { CreateDocumentEventPgInput } from '@dmdoc/db-pg';
import {
  createLLMProvider,
  LLMError,
  validateIndexValues,
  mergeSuggestedIndexValues,
  type LLMProvider,
  type IndexFieldRow,
} from '@dmdoc/llm-provider';
import { NotFoundError, QuotaExceededError, ValidationError, ForbiddenError, UpstreamServiceError, ConflictError } from '../errors/index.js';
import { requireRole } from '../auth/role-guard.js';
import { AuditLogger } from '../auth/audit.js';
import { resolveTenantContext } from '../auth/resolve-tenant.js';
import { resolveAccessibleDepartmentIds } from '../auth/department-access.js';
import { getConfig, type Config } from '../config.js';
import { suggestDocumentIndexes } from '../services/index-suggestion.js';
import { classifyDocument } from '../services/classify-document.js';
import { generateDocumentTags } from '../services/tag-generation.js';

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
  title: string | null;
  suggested_title: string | null;
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

/**
 * Linha crua de `document_content` como armazenada no PostgreSQL — usada
 * exclusivamente pelo `GET /documents/:id/debug`.
 *
 * Os campos JSONB (`extraction`, `index_suggestion`, `cost_breakdown`) já
 * chegam desserializados pelo driver `postgres.js`, mas os campos de data
 * embutidos neles (`extractedAt`/`suggestedAt`) chegam como string ISO, e não
 * `Date` (JSON não tem tipo Date nativo) — por isso divergem de
 * `ExtractionResult`/`IndexSuggestion` de `@dmdoc/shared-types` só nesse
 * campo. Convertidos de volta para `Date` ao montar a resposta do debug.
 */
interface DocumentContentRow {
  document_id: string;
  tenant_id: string;
  full_text: string;
  extraction: Omit<ExtractionResult, 'extractedAt'> & { extractedAt: string };
  index_suggestion: (Omit<IndexSuggestion, 'suggestedAt'> & { suggestedAt: string }) | null;
  type_suggestion: (Omit<TypeSuggestion, 'suggestedAt'> & { suggestedAt: string }) | null;
  cost_breakdown: CostBreakdown | null;
}

/**
 * Amostra de `chunks` (até 3, ordenados por `chunk_index`) retornada pelo
 * `GET /documents/:id/debug`. `text` já vem truncado pelo `LEFT(...)` da
 * query — evita puxar o texto completo dos chunks pela rede.
 */
interface ChunkSampleRow {
  chunk_index: number;
  page_number: number | null;
  token_count: number;
  text: string;
}

/** Tamanho máximo (em caracteres) do trecho de texto exibido por chunk na amostra de debug. */
const DEBUG_CHUNK_TEXT_SAMPLE_LENGTH = 300;

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
  // Título EFETIVO — o mesmo texto que a listagem mostra na coluna "Título":
  // título confirmado quando existe, nome do arquivo como fallback (ver wiki
  // "Título de exibição sugerido por IA"). `nullable: false` porque
  // `original_filename` é NOT NULL, então o COALESCE nunca resulta em NULL.
  // `NULLIF(btrim(...))`: título só com espaços (ou vazio) conta como ausente,
  // igual ao `documentDisplayName` do front — senão esses documentos ordenariam
  // todos juntos no topo com a célula em branco.
  title: { expr: "COALESCE(NULLIF(btrim(d.title), ''), d.original_filename)", nullable: false },
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

/**
 * Escapa os caracteres especiais do `ILIKE` (`\`, `%`, `_`) em um termo de
 * busca livre, para que sejam tratados como texto literal — nunca como
 * wildcard involuntário digitado pelo usuário (ex.: buscar por "100%" não
 * deve casar com qualquer coisa começando em "100").
 *
 * O `\` precisa ser escapado PRIMEIRO — senão os backslashes introduzidos ao
 * escapar `%`/`_` seriam escapados de novo. Usado em conjunto com
 * `ESCAPE '\'` na cláusula SQL (padrão de escape do `LIKE`/`ILIKE` do
 * PostgreSQL).
 */
function escapeLikePattern(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
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
  // Busca textual livre — casa contra `original_filename` OU `title` (ILIKE,
  // case-insensitive). Termo sanitizado via `escapeLikePattern` antes de virar
  // padrão `%termo%` — nunca concatenado cru na query (sempre bind param).
  search: z.string().optional(),
  // Período de upload — filtra `uploaded_at`, inclusivo nos DOIS extremos.
  // Os dois lados são independentes: passar só `dateFrom` (ou só `dateTo`)
  // vale como range aberto do outro lado. Nomes convergem com `GET /reports/*`
  // e `GET /audit-logs`, que já filtram por data com o mesmo contrato.
  // O front envia dias inteiros já convertidos para instante (início do dia em
  // `dateFrom`, fim do dia em `dateTo`) no fuso do navegador — o backend não
  // arredonda nada, só compara os instantes recebidos.
  dateFrom: z.string().datetime({ offset: true }).optional(),
  dateTo: z.string().datetime({ offset: true }).optional(),
  sortBy: z.enum(SORT_BY_KEYS).default('uploadedAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  // Paginação por número de página (OFFSET) — substitui o cursor/keyset
  // anterior. Decisão de arquitetura (T-21/GH#31): paginação numerada exige
  // acesso aleatório, incompatível com cursor sequencial; o COUNT(*) completo
  // já rodava em todo request, então o custo que o OFFSET adiciona já era
  // pago; o volume por tenant não chega à escala em que OFFSET profundo é um
  // problema real.
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

/** Schema do body do PATCH /documents/:id. */
const PatchDocumentBodySchema = z.object({
  documentTypeId: z.string().uuid().nullable().optional(),
  // Título de exibição confirmado/editado pelo usuário (Fase 8.1).
  // string = confirma/edita o título; `null` explícito = limpa o título
  // confirmado (volta ao fallback `originalFilename`); ausente = não mexe.
  title: z.string().min(1).max(500).nullable().optional(),
  indexValues: z.record(z.union([z.string(), z.number(), z.null()])).optional(),
  // Tags CONFIRMADAS pelo usuário (manuais + sugeridas por IA que ele aceitou).
  // Teto coerente: até 60 tags por documento (30 da IA + folga para manuais),
  // cada tag não-vazia e limitada em tamanho — barra abuso sem atrapalhar o uso
  // real. As tags SUGERIDAS pela IA vivem em `document_content.suggested_tags`
  // (consultivas) e nunca entram aqui automaticamente — só por confirmação.
  tags: z
    .array(z.string().trim().min(1).max(MAX_TAG_LENGTH))
    .max(MAX_GENERATED_TAGS * 2)
    .optional(),
});

/** Schema dos params de rotas `/documents/:id/*` que exigem um UUID válido. */
const DocumentIdParamsSchema = z.object({
  id: z.string().uuid(),
});

/**
 * Schema do body do POST /documents/bulk-reassign-uploader.
 *
 * `documentIds` usa o mesmo teto de 500 do `limit` de `GET /documents`
 * (`ListDocumentsQuerySchema.limit`).
 */
const BulkReassignUploaderBodySchema = z.object({
  documentIds: z.array(z.string().uuid()).min(1).max(500),
  toUserId: z.string().uuid(),
});

/**
 * Teto de documentos por disparo de reprocessamento de IA em massa (épico E-4).
 * Mesmo teto do bulk-reassign e do `pageSize` máximo de `GET /documents` (500) —
 * o front resolve "selecionar todos os resultados do filtro" enviando os ids da
 * página (até 500), então o teto casa naturalmente com o volume máximo de uma
 * seleção. Barra o disparo acidental da empresa inteira num clique (aviso de
 * custo — ver regra "Rastreamento de custo de IA por empresa").
 */
const BULK_REPROCESS_AI_MAX = 500;

/**
 * Schema do body do POST /documents/bulk-reprocess-ai.
 *
 * `documentIds`: lista EXPLÍCITA de documentos a reprocessar (1..500). A UX de
 * "selecionar todos do filtro" é resolvida no front expandindo o filtro em ids
 * (limitado ao mesmo teto), mantendo o backend simples e o escopo/ACL validado
 * por documento.
 *
 * `steps`: subconjunto NÃO-vazio de {title, indexes, tags}. Ausente ⇒ todas as
 * etapas. O backend ainda INTERSECTA com as feature flags efetivas do tenant —
 * só enfileira as etapas realmente habilitadas.
 */
const BulkReprocessAiBodySchema = z.object({
  documentIds: z.array(z.string().uuid()).min(1).max(BULK_REPROCESS_AI_MAX),
  steps: z.array(AiReprocessStepSchema).min(1).optional(),
});

/**
 * Teto de documentos por disparo de reprocessamento COMPLETO em massa (E-7).
 * Mesmo teto do lote de IA (500) e do `pageSize` máximo de `GET /documents` —
 * o front resolve "selecionar todos do filtro" enviando os ids da página. Aqui
 * o teto pesa ainda mais: cada documento elegível roda o pipeline INTEGRAL
 * (extração + OCR + embeddings + as 3 etapas de IA), ou seja, equivale a 500
 * uploads completos concorrendo com a fila de uploads da empresa.
 */
const BULK_REPROCESS_MAX = 500;

/**
 * Schema do body do POST /documents/bulk-reprocess.
 *
 * `documentIds`: lista EXPLÍCITA de documentos (1..500). SEM `steps` — ao
 * contrário do lote de IA (E-4), aqui o pipeline é integral por definição:
 * não existe subconjunto de etapas a escolher.
 */
const BulkReprocessBodySchema = z.object({
  documentIds: z.array(z.string().uuid()).min(1).max(BULK_REPROCESS_MAX),
});

/**
 * Teto de documentos por disparo de exclusão em massa (E-8).
 * Mesmo teto das demais operações em lote (500) e do `pageSize` máximo de
 * `GET /documents` — o front resolve "selecionar todos do filtro" enviando os
 * ids da página. Aqui o teto é uma trava de segurança, não de custo: a operação
 * é IRREVERSÍVEL (apaga chunks, texto extraído e o objeto no S3).
 */
const BULK_DELETE_MAX = 500;

/**
 * Schema do body do POST /documents/bulk-delete.
 *
 * `documentIds`: lista EXPLÍCITA de documentos (1..500). SEM filtro por status —
 * documento em qualquer status é elegível (o `DELETE /documents/:id` individual
 * também não tem guarda de status).
 */
const BulkDeleteBodySchema = z.object({
  documentIds: z.array(z.string().uuid()).min(1).max(BULK_DELETE_MAX),
});

/**
 * Escopo do POST /documents/:id/classify (T-53).
 *
 * Tipo e título nascem da MESMA chamada de LLM, mas cada um tem seu próprio
 * botão na tela (card "Tipo e Tags" × card de título). Sem escopo, clicar em
 * "Reclassificar com IA" sobrescrevia o título do documento — inclusive um
 * título digitado à mão —, que é justamente o defeito relatado na issue #46.
 *
 * Ausente ⇒ {type, title}: preserva o comportamento histórico da rota para
 * qualquer chamador que não envie body.
 */
const ClassifyScopeSchema = z.enum(['type', 'title']);
type ClassifyScope = z.infer<typeof ClassifyScopeSchema>;

const ClassifyBodySchema = z.object({
  scope: z.array(ClassifyScopeSchema).min(1).max(2).optional(),
});

const CLASSIFY_SCOPE_ALL: readonly ClassifyScope[] = ['type', 'title'];

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
 * Duas camadas de controle, nesta ordem:
 *   1. GATE POR PAPEL — a CAPACIDADE de escrita exige nível >= UPLOADER (40).
 *      USER (20) é somente leitura por definição (wiki "Papéis de acesso
 *      (roles)"): mesmo com uma raiz concedida ativa (que lhe dá leitura da
 *      subárvore), NUNCA pode escrever. Papel desconhecido/inválido cai como
 *      SEM escrita (fail-closed). Cobre uniformemente PATCH/DELETE/reprocess/
 *      suggest-indexes — todos passam por este choke point.
 *   2. ACL POR DEPARTAMENTO — para papéis com capacidade de escrita, o
 *      departamento precisa estar no conjunto acessível (subárvore concedida)
 *      ou o papel ser admin (sem restrição de ACL).
 *
 * Lança `NotFoundError` (nunca 403 — spec §10, invariante 4) se sem permissão,
 * com a mesma mensagem em ambas as camadas para não vazar a existência do
 * recurso a quem não pode escrever nele.
 */
async function assertCanWriteDepartment(
  sql: Sql,
  userId: string,
  tenantId: string,
  departmentId: string,
  role: string
): Promise<void> {
  // Camada 1: gate por nível de papel (fail-closed).
  // O role vem do JWT já validado, mas mantemos a checagem type-safe: um papel
  // não reconhecido resolve para nível 0 e é negado, nunca liberado.
  const parsedRole = RoleSchema.safeParse(role);
  const roleLevel = parsedRole.success ? ROLE_LEVEL[parsedRole.data] : 0;
  if (roleLevel < ROLE_LEVEL.UPLOADER) {
    throw new NotFoundError('Departamento não encontrado ou sem permissão de escrita');
  }

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
    title: r.title,
    suggestedTitle: r.suggested_title,
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
// GET /documents — paginação por número de página (OFFSET)
// ---------------------------------------------------------------------------

/** Número total de tentativas de `emitUploadEvent` (1 original + 1 retry). */
const EMIT_UPLOAD_EVENT_MAX_ATTEMPTS = 2;

/**
 * Emite um evento de upload na tabela append-only `document_events`.
 *
 * Tenta até `EMIT_UPLOAD_EVENT_MAX_ATTEMPTS` vezes (1 tentativa original + 1
 * retry síncrono, sem backoff) antes de desistir — absorve falhas transitórias
 * de pool/conexão sem adicionar complexidade de fila/backoff assíncrono.
 *
 * Falha de emissão (mesmo após o retry) NUNCA derruba a operação de upload.
 */
async function emitUploadEvent(
  sql: Sql,
  log: FastifyBaseLogger,
  tenantId: string,
  input: CreateDocumentEventPgInput
): Promise<void> {
  const eventsRepo = new DocumentEventsRepository(sql, { tenantId });
  let lastError: unknown;

  for (let attempt = 1; attempt <= EMIT_UPLOAD_EVENT_MAX_ATTEMPTS; attempt++) {
    try {
      await eventsRepo.insertOne(input);
      return;
    } catch (eventError) {
      lastError = eventError;
    }
  }

  log.error(
    {
      err: lastError,
      tenantId,
      documentId: input.documentId,
      userId: input.uploadedById,
      deduplicated: input.deduplicated,
    },
    'falha ao emitir evento de upload (document_events)'
  );
}

// ---------------------------------------------------------------------------
// Plugin de rotas
// ---------------------------------------------------------------------------

export interface DocumentsRoutesOptions {
  config: Config;
  /**
   * Permite injetar um provider de LLM alternativo (útil em testes, para
   * exercitar as rotas de IA sem chamar o provedor real). Quando ausente, é
   * criado a partir da config.
   */
  llmProvider?: LLMProvider;
}

/**
 * Rotas de documentos — PostgreSQL.
 */
export const documentsRoutes: FastifyPluginAsync<DocumentsRoutesOptions> = async (app, options) => {
  const { config } = options;

  // Provider de LLM compartilhado entre as chamadas desta rota (mesmo padrão
  // de `search.ts`) — usado por `POST /documents/:id/suggest-indexes` e
  // `POST /documents/:id/classify`. Injetável em testes via options.
  const llmProvider =
    options.llmProvider ??
    createLLMProvider(
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

    // Exceção FAILED da deduplicação (regra "Deduplicação de documentos por
    // conteúdo"): se já existe um documento com o mesmo `contentHash` neste
    // tenant mas em status FAILED, a dedup NÃO se aplica — criamos um NOVO
    // documento e reenfileiramos. O índice único parcial
    // `uniq_doc_tenant_content_hash (tenant_id, content_hash) WHERE deleted = false`
    // impede duas linhas não-deletadas com o mesmo hash; por isso, ao reenviar
    // um conteúdo FAILED, soft-deletamos o registro FAILED (liberando o índice)
    // e inserimos o novo NA MESMA TRANSAÇÃO — antes disso o insert colidia
    // (23505) e vazava como 500 (bug UPLOAD-14).
    const reuploadOfFailed = existingDoc !== null && existingDoc.status === 'FAILED';

    const insertPayload = {
      id: documentId,
      department_id: departmentId,
      document_type_id: documentTypeId ?? null,
      filename,
      original_filename: originalFilename,
      title: null,
      suggested_title: null,
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
    } as Omit<DocumentRow, 'id' | 'tenantId' | 'tenant_id' | 'deleted'>;

    let document: DocumentRow;
    try {
      if (reuploadOfFailed) {
        document = await sql.begin(async (tx) => {
          await tx`
            UPDATE documents
            SET deleted = true
            WHERE tenant_id = ${tenantId}
              AND content_hash = ${contentHash}
              AND status = 'FAILED'
              AND deleted = false
          `;
          const txRepo = new TenantRepository<DocumentRow>(tx as unknown as typeof sql, 'documents', { tenantId });
          return txRepo.insertOne(insertPayload);
        });
      } else {
        document = await repo.insertOne(insertPayload);
      }
    } catch (insertError) {
      // Corrida de deduplicação (UPLOAD-16): dois uploads do MESMO conteúdo novo
      // passam pela checagem de dedup antes de qualquer um persistir; o índice
      // único parcial `uniq_doc_tenant_content_hash (tenant_id, content_hash)
      // WHERE deleted = false` garante que só um vença — o perdedor recebe 23505.
      // Regra "Deduplicação de documentos por conteúdo" (caso de borda "upload
      // concorrente do mesmo arquivo"): o perdedor é tratado como 409 Conflict
      // (nunca 500). A integridade é preservada — apenas um documento persiste.
      if ((insertError as { code?: string }).code === '23505') {
        // NÃO remover o objeto do S3 aqui: a chave é derivada de
        // (contentHash, filename) e, quando o vencedor subiu o mesmo arquivo
        // com o mesmo nome, é a MESMA chave — apagá-la corromperia o documento
        // vencedor. O conteúdo já está no S3 (upload idempotente). Um eventual
        // objeto órfão (nomes de arquivo diferentes) é custo aceitável nesta
        // corrida rara, preferível a arriscar apagar o arquivo do vencedor.
        request.log.info(
          { tenantId, userId, contentHash },
          'colisão de deduplicação por corrida — perdedor tratado como 409'
        );
        throw new ConflictError('Conteúdo já existe nesta empresa (conflito de deduplicação por corrida)');
      }

      // Rollback: remove arquivo do S3 (erro de insert não relacionado à corrida).
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

    // Período de upload: comparar como instante, não como string — dois ISO
    // com offsets diferentes ordenam errado lexicograficamente.
    const uploadedFrom = query.dateFrom !== undefined ? new Date(query.dateFrom) : undefined;
    const uploadedTo = query.dateTo !== undefined ? new Date(query.dateTo) : undefined;
    if (uploadedFrom !== undefined && uploadedTo !== undefined && uploadedFrom > uploadedTo) {
      throw new ValidationError('dateFrom não pode ser posterior a dateTo');
    }

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

    // Busca textual livre: nome do arquivo OU título confirmado (ILIKE,
    // case-insensitive). Entra no MESMO array de condições (AND com tenant/
    // ACL/demais filtros, nunca OR) — combinado corretamente com o isolamento
    // multi-tenant já resolvido acima. Termo sanitizado via
    // `escapeLikePattern` (nunca concatenado cru) para que `%`/`_`/`\`
    // digitados pelo usuário sejam tratados como texto literal, não wildcard.
    const trimmedSearch = query.search?.trim();
    if (trimmedSearch !== undefined && trimmedSearch.length > 0) {
      const searchPattern = `%${escapeLikePattern(trimmedSearch)}%`;
      const searchParam = addParam(searchPattern);
      conditions.push(
        `(d.original_filename ILIKE ${searchParam} ESCAPE '\\' OR d.title ILIKE ${searchParam} ESCAPE '\\')`
      );
    }

    // Período de upload — entra no mesmo array de condições (AND), então o
    // COUNT abaixo já sai filtrado por ele. Sempre bind param (`addParam`),
    // nunca a data interpolada na string.
    if (uploadedFrom !== undefined) {
      conditions.push(`d.uploaded_at >= ${addParam(uploadedFrom)}::timestamptz`);
    }
    if (uploadedTo !== undefined) {
      conditions.push(`d.uploaded_at <= ${addParam(uploadedTo)}::timestamptz`);
    }

    const whereClause = conditions.join(' AND ');

    // Total (mesmo whereClause — inclui busca/filtros — sem JOINs, pois
    // nenhuma condição depende das tabelas relacionadas; só a ordenação/
    // exibição da página precisa delas).
    const countQuery = `SELECT COUNT(*) AS count FROM documents d WHERE ${whereClause}`;
    const countRows = await sql.unsafe<Array<{ count: string }>>(countQuery, params as Parameters<typeof sql.unsafe>[1]);
    const total = parseInt(countRows[0]?.count ?? '0', 10);

    // ------------------------------------------------------------------
    // 3. Página com paginação por número de página (OFFSET)
    // ------------------------------------------------------------------
    const sortBy = query.sortBy;
    const sortDir = query.sortDir;
    const sortColumn = SORT_COLUMNS[sortBy];
    const dirSql = sortDir === 'asc' ? 'ASC' : 'DESC';

    const page = query.page;
    const pageSize = query.pageSize;
    const offset = (page - 1) * pageSize;

    const orderByClause = sortColumn.nullable
      ? `${sortColumn.expr} ${dirSql} NULLS LAST, d.id ${dirSql}`
      : `${sortColumn.expr} ${dirSql}, d.id ${dirSql}`;

    // `whereClause`/`params` já resolvidos acima (mesmos usados no COUNT) —
    // só acrescentamos LIMIT/OFFSET como parâmetros adicionais.
    const limitPlaceholder = addParam(pageSize);
    const offsetPlaceholder = addParam(offset);

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
      WHERE ${whereClause}
      ORDER BY ${orderByClause}
      LIMIT ${limitPlaceholder}
      OFFSET ${offsetPlaceholder}
    `;

    const docs = await sql.unsafe<DocumentListRow[]>(pageQuery, params as Parameters<typeof sql.unsafe>[1]);

    const pageCount = Math.ceil(total / pageSize);

    request.log.info(
      { tenantId: effectiveTenantId, userId, total, returned: docs.length, sortBy, sortDir, page, pageSize },
      'listagem de documentos'
    );

    return reply.status(200).send({
      items: docs.map(rowToDocumentListItem),
      page,
      pageSize,
      total,
      pageCount,
    });
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

    // Enriquece com pageCount e a sugestão de tipo por IA (Fase 8) de
    // document_content. A sugestão só aparece para quem já passou pelo
    // controle de acesso acima (assertCanReadDepartment) — nunca vaza para
    // fora do escopo do documento.
    const contentRows = await sql<
      Array<{
        extraction: { pageCount?: number } | null;
        type_suggestion: unknown;
        index_suggestion: unknown;
        suggested_tags: unknown;
        full_text: string | null;
      }>
    >`
      SELECT extraction, type_suggestion, index_suggestion, suggested_tags, full_text
      FROM document_content
      WHERE document_id = ${doc.id}
        AND tenant_id = ${doc.tenant_id}
      LIMIT 1
    `;
    const pageCount =
      typeof contentRows[0]?.extraction?.pageCount === 'number'
        ? contentRows[0].extraction.pageCount
        : null;

    // Nome do tipo de documento atribuído (tenant OU global). `resolveDocumentTypeName`
    // cobre ambos os escopos: tipos da empresa (`tenant_id = doc.tenant_id`) e tipos
    // globais (`is_global = true`, `tenant_id NULL`). Sem isso, o detalhe não expõe o
    // nome do tipo e a UI mostra "Sem tipo" mesmo com `document_type_id` preenchido.
    const documentTypeName = await resolveDocumentTypeName(
      sql,
      doc.tenant_id,
      doc.document_type_id
    );

    // Subconjunto SEGURO da sugestão: só documentTypeId/documentTypeName/
    // confidence. O `parse` do PublicTypeSuggestionSchema descarta model,
    // promptVersion, suggestedAt e rawResponse — esses ficam só no /debug.
    // Null enquanto o worker de classificação ainda não rodou (coluna nula).
    const rawTypeSuggestion = contentRows[0]?.type_suggestion ?? null;
    const typeSuggestion =
      rawTypeSuggestion !== null ? PublicTypeSuggestionSchema.parse(rawTypeSuggestion) : null;

    // Subconjunto SEGURO da sugestão automática de valores de índice (T-16,
    // gatilho 1 do worker no upload). Só `values` + `suggestedAt`; o `parse`
    // do PublicIndexSuggestionSchema descarta model, promptVersion e
    // rawResponse — esses ficam só no /debug. É o que a UI usa para
    // pré-preencher os campos de índice sem o usuário pedir. Null enquanto o
    // worker ainda não gerou sugestão (coluna nula).
    const rawIndexSuggestion = contentRows[0]?.index_suggestion ?? null;
    const indexSuggestion =
      rawIndexSuggestion !== null ? PublicIndexSuggestionSchema.parse(rawIndexSuggestion) : null;

    // Subconjunto SEGURO da sugestão de TAGS por IA (Fase 9 / E-3). Só `tags` +
    // `generatedAt`; o `parse` do PublicSuggestedTagsSchema descarta model,
    // promptVersion e rawResponse — esses ficam só no /debug. É o que o card de
    // sugestão da tela de detalhe usa. Null enquanto o worker ainda não gerou
    // (coluna nula). NUNCA se confunde com `documents.tags` (as confirmadas,
    // que já vão em `rowToDocument`).
    const rawSuggestedTags = contentRows[0]?.suggested_tags ?? null;
    const suggestedTags =
      rawSuggestedTags !== null ? PublicSuggestedTagsSchema.parse(rawSuggestedTags) : null;

    // Texto completo extraído (nativo ou OCR) usado para busca/embeddings (T-23).
    // Exposto no próprio detalhe reusando EXATAMENTE o mesmo controle de acesso
    // acima (assertCanReadDepartment) — sem novo nível de acesso. É `null` quando
    // não há linha em document_content (documento ainda processando, PENDING/
    // PROCESSING, ou processamento falhou sem gerar texto). O card de leitura na
    // tela de detalhe trata esse `null` como estado vazio, nunca como erro.
    const fullText = contentRows[0]?.full_text ?? null;

    // Valor EFETIVO (plataforma AND empresa) da feature de título sugerido por
    // IA (T-18) — o frontend usa isso para decidir se mostra o indicador de
    // sugestão pendente na tela de detalhes, sem precisar "descobrir"
    // reativamente via 403 ao tentar reclassificar/regerar. Só o booleano
    // final é exposto — nunca a configuração de plataforma/empresa em
    // separado, então não vaza a decisão comercial que o TENANT_ADMIN não tem
    // acesso (mesma lógica já usada em `suggest-indexes`/`classify`).
    const aiFlags = await resolveAiFeatureFlags(sql, doc.tenant_id);

    request.log.info(
      { tenantId: doc.tenant_id, userId, documentId: doc.id },
      'detalhe de documento recuperado'
    );

    return reply.status(200).send({
      ...rowToDocument(doc),
      documentTypeName,
      pageCount,
      typeSuggestion,
      indexSuggestion,
      suggestedTags,
      fullText,
      titleSuggestionEnabled: aiFlags.titleSuggestionEnabled,
      tagGenerationEnabled: aiFlags.tagGenerationEnabled,
    });
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
  // GET /documents/:id/debug — dados de extração/processamento (SUPER_ADMIN)
  // =========================================================================
  /**
   * Ferramenta de operação da plataforma: expõe texto extraído, metadados de
   * extração, sugestão de índices e custo de um documento sem precisar
   * consultar o banco diretamente. Exclusiva do SUPER_ADMIN — nem
   * TENANT_ADMIN nem MULTI_TENANT_ADMIN têm acesso (intencional: não é
   * ferramenta de gestão de empresa, é de suporte/depuração da plataforma).
   *
   * O SUPER_ADMIN já tem acesso cross-tenant nativo (`findDocumentGlobally`)
   * — não há filtro por tenant, só verificação de existência.
   */
  app.get('/documents/:id/debug', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'SUPER_ADMIN');

    const userId = request.user!.sub;
    const sql = app.db;

    const { id } = request.params as { id: string };

    const doc = await findDocumentGlobally(sql, id);
    if (!doc) {
      throw new NotFoundError('Documento não encontrado');
    }

    // document_content pode não existir ainda (PENDING/PROCESSING/FAILED
    // antes da extração terminar) — estado válido, não é erro.
    const [contentRows, chunkCountRows, chunkSampleRows] = await Promise.all([
      sql<DocumentContentRow[]>`
        SELECT document_id, tenant_id, full_text, extraction, index_suggestion, type_suggestion, cost_breakdown
        FROM document_content
        WHERE document_id = ${doc.id}
          AND tenant_id = ${doc.tenant_id}
        LIMIT 1
      `,
      sql<Array<{ count: string }>>`
        SELECT COUNT(*) AS count
        FROM chunks
        WHERE document_id = ${doc.id}
      `,
      sql<ChunkSampleRow[]>`
        SELECT chunk_index, page_number, token_count,
          LEFT(text, ${DEBUG_CHUNK_TEXT_SAMPLE_LENGTH}) AS text
        FROM chunks
        WHERE document_id = ${doc.id}
        ORDER BY chunk_index ASC
        LIMIT 3
      `,
    ]);

    const content = contentRows[0] ?? null;

    const extraction: ExtractionResult | null =
      content !== null
        ? { ...content.extraction, extractedAt: new Date(content.extraction.extractedAt) }
        : null;

    const indexSuggestion: IndexSuggestion | null =
      content?.index_suggestion != null
        ? { ...content.index_suggestion, suggestedAt: new Date(content.index_suggestion.suggestedAt) }
        : null;

    // Sugestão de tipo COMPLETA (Fase 8), incl. campos de auditoria/operação
    // (model, promptVersion, rawResponse) — exclusiva do /debug do SUPER_ADMIN.
    const typeSuggestion: TypeSuggestion | null =
      content?.type_suggestion != null
        ? { ...content.type_suggestion, suggestedAt: new Date(content.type_suggestion.suggestedAt) }
        : null;

    request.log.info(
      { tenantId: doc.tenant_id, userId, documentId: doc.id },
      'debug de documento consultado por SUPER_ADMIN'
    );

    return reply.status(200).send({
      documentId: doc.id,
      status: doc.status,
      failureReason: doc.failure_reason,
      extraction,
      fullText: content?.full_text ?? null,
      fullTextLength: content?.full_text.length ?? 0,
      indexSuggestion,
      typeSuggestion,
      costBreakdown: content?.cost_breakdown ?? null,
      costUsdCents: doc.cost_usd_cents,
      chunkCount: parseInt(chunkCountRows[0]?.count ?? '0', 10),
      chunkSample: chunkSampleRows.map((c) => ({
        chunkIndex: c.chunk_index,
        pageNumber: c.page_number,
        tokenCount: c.token_count,
        text: c.text,
      })),
    });
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
    if ('title' in body) {
      updateData.title = body.title ?? null;
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

    // -----------------------------------------------------------------------
    // GATILHO 2 (Fase 7): quando o PATCH DEFINE/TROCA o tipo do documento para
    // um valor não-nulo (mudança efetiva), dispara a sugestão de índices sobre
    // o NOVO tipo — aguardando (o usuário verá os valores pré-preenchidos na
    // resposta). Best-effort: respeita `indexSuggestionEnabled`, grava
    // `document_content.index_suggestion`; com `aiIndexAutoApplyEnabled`
    // ligada, também mescla em `documents.index_values` COM SOBRESCRITA (campo
    // a campo, substitui valor já confirmado quando a sugestão vier preenchida
    // — aqui o tipo já é sempre o CONFIRMADO, sem o problema do "tipo órfão" do
    // gatilho automático de upload). NUNCA quebra o PATCH — falha de IA ⇒ 200
    // com o tipo salvo, sem sugestão.
    // -----------------------------------------------------------------------
    const typeChangedToNonNull =
      'documentTypeId' in body &&
      effectiveDocumentTypeId !== null &&
      effectiveDocumentTypeId !== (doc.document_type_id ?? null);

    let suggestedIndexFields: Awaited<
      ReturnType<typeof suggestDocumentIndexes>
    >['fields'] | undefined;
    let appliedIndexValues: Record<string, string | number | null> | undefined;

    if (typeChangedToNonNull) {
      const log = request.log.child({ tenantId, documentId: doc.id, userId, traceId: request.id });
      try {
        const aiFlags = await resolveAiFeatureFlags(sql, tenantId);
        if (aiFlags.indexSuggestionEnabled) {
          const suggestion = await suggestDocumentIndexes(
            { tenantId, documentId: id, documentTypeId: effectiveDocumentTypeId as string },
            { sql, llmProvider, logger: log }
          );
          suggestedIndexFields = suggestion.fields;
          log.info(
            {
              fieldsRequested: suggestion.fields.length,
              fieldsSuggested: suggestion.fields.filter((f) => f.value !== null).length,
              costUsd: suggestion.costUsd,
            },
            'sugestão de índices gerada após definição de tipo no PATCH'
          );

          if (aiFlags.indexAutoApplyEnabled) {
            const indexFieldRows = await sql<IndexFieldRow[]>`
              SELECT id, name, field_type, required, ai_extraction_hint, sort_order, show_on_search, deleted
              FROM document_type_index_fields
              WHERE document_type_id = ${effectiveDocumentTypeId}
                AND deleted = false
            `;
            const suggestedRaw = Object.fromEntries(
              suggestion.fields.filter((f) => f.value !== null).map((f) => [f.name, f.value as string])
            );
            const currentIndexValues = (updated as DocumentRow).index_values ?? {};
            const { merged, appliedCount } = mergeSuggestedIndexValues(currentIndexValues, suggestedRaw, indexFieldRows);
            if (appliedCount > 0) {
              await sql`
                UPDATE documents
                SET index_values = ${sql.json(merged as unknown as JSONValue)}
                WHERE id = ${id}
                  AND tenant_id = ${tenantId}
              `;
              appliedIndexValues = merged;
              (updated as DocumentRow).index_values = merged;
            }
          }
        } else {
          log.info({}, 'sugestão de índices no PATCH pulada: feature desabilitada para a empresa');
        }
      } catch (err) {
        // Best-effort: o PATCH sempre retorna 200 com o tipo salvo, mesmo sem sugestão.
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'sugestão de índices após PATCH falhou — retornando sem sugestão (best-effort)'
        );
      }
    }

    return reply.status(200).send({
      ...rowToDocument(updated as DocumentRow),
      ...(suggestedIndexFields !== undefined ? { suggestedIndexFields } : {}),
      ...(appliedIndexValues !== undefined ? { appliedIndexValues } : {}),
    });
  });

  // =========================================================================
  // POST /documents/bulk-reassign-uploader — reatribuição em massa de
  // "quem fez upload" (SUPER_ADMIN)
  // =========================================================================
  /**
   * Reatribui em massa `uploaded_by_id` de um lote de documentos para outro
   * usuário da mesma empresa — atualiza tanto `documents` (estado atual)
   * quanto `document_events` (histórico usado pelos relatórios), numa única
   * transação atômica.
   *
   * Diferente do precedente fire-and-forget de `syncDocumentType` (metadado
   * secundário), aqui a consistência entre as duas tabelas é o requisito
   * central da feature: falha em qualquer uma das duas reverte a operação
   * inteira (erro 500 propagado, não silenciado).
   *
   * Exclusivo de SUPER_ADMIN. Todos os documentos selecionados precisam
   * pertencer à mesma empresa — isso é validação de uso da API (o SUPER_ADMIN
   * já tem acesso cross-tenant nativo), não vazamento entre empresas, então a
   * semântica "404-nunca-403" do resto do arquivo não se aplica a essa
   * validação específica (usa `ValidationError` → 422).
   */
  app.post(
    '/documents/bulk-reassign-uploader',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, 'SUPER_ADMIN');

      const userId = request.user!.sub;
      const sql = app.db;

      const { documentIds, toUserId } = BulkReassignUploaderBodySchema.parse(request.body);

      // ------------------------------------------------------------------
      // 1. Busca os documentos selecionados (sem filtro de tenant — SUPER_ADMIN)
      // ------------------------------------------------------------------
      const foundDocs = await sql<Array<{ id: string; tenant_id: string; uploaded_by_id: string | null }>>`
        SELECT id, tenant_id, uploaded_by_id
        FROM documents
        WHERE id = ANY(${documentIds}::uuid[])
          AND deleted = false
      `;

      if (foundDocs.length !== documentIds.length) {
        // Nunca revela qual id falhou — mesmo padrão 404-genérico do resto do arquivo.
        throw new NotFoundError('Documento não encontrado');
      }

      // ------------------------------------------------------------------
      // 2. Todos os documentos precisam pertencer à mesma empresa
      // ------------------------------------------------------------------
      const distinctTenantIds = [...new Set(foundDocs.map((d) => d.tenant_id))];
      if (distinctTenantIds.length > 1) {
        throw new ValidationError('Todos os documentos devem pertencer à mesma empresa');
      }
      const tenantId = distinctTenantIds[0]!;

      // ------------------------------------------------------------------
      // 3. Valida usuário destino: existe, não deletado, mesmo tenant
      // ------------------------------------------------------------------
      const toUserRows = await sql<Array<{ id: string }>>`
        SELECT id FROM users
        WHERE id = ${toUserId}
          AND tenant_id = ${tenantId}
          AND deleted = false
        LIMIT 1
      `;
      if (toUserRows.length === 0) {
        throw new NotFoundError('Usuário destino não encontrado');
      }

      // ------------------------------------------------------------------
      // 4. Transação atômica: documents + document_events
      // ------------------------------------------------------------------
      const { updatedDocuments, updatedEvents } = await sql.begin(async (tx) => {
        const docsResult = await tx`
          UPDATE documents
          SET uploaded_by_id = ${toUserId}
          WHERE id = ANY(${documentIds}::uuid[])
            AND tenant_id = ${tenantId}
        `;
        const eventsResult = await tx`
          UPDATE document_events
          SET uploaded_by_id = ${toUserId}
          WHERE document_id = ANY(${documentIds}::uuid[])
            AND tenant_id = ${tenantId}
        `;
        return { updatedDocuments: docsResult.count, updatedEvents: eventsResult.count };
      });

      // ------------------------------------------------------------------
      // 5. AuditLog (não-bloqueante)
      // ------------------------------------------------------------------
      const fromUserIds = [...new Set(foundDocs.map((d) => d.uploaded_by_id).filter((id): id is string => id !== null))];
      const auditLogger = new AuditLogger(sql);
      try {
        await auditLogger.record({
          tenantId,
          userId,
          action: 'document.bulk_reassign_uploader',
          resource: 'documents/bulk-reassign',
          metadata: {
            documentIds,
            fromUserIds,
            toUserId,
            count: documentIds.length,
          },
        });
      } catch (auditError) {
        request.log.error(
          { err: auditError, tenantId, userId, toUserId, count: documentIds.length },
          'falha ao registrar audit log de reatribuição em massa de uploader'
        );
      }

      request.log.info(
        { tenantId, userId, count: documentIds.length, toUserId, traceId: request.id },
        'uploader reatribuído em massa'
      );

      return reply.status(200).send({ updatedDocuments, updatedEvents });
    }
  );

  // =========================================================================
  // POST /documents/bulk-reprocess-ai — reprocessamento de IA em massa (E-4)
  // =========================================================================
  /**
   * Dispara o reprocessamento de IA (título/tipo, índices, tags) de um LOTE de
   * documentos: cria o registro de lote (`ai_reprocess_batch`) e enfileira UM
   * job na fila dedicada `ai-reprocess` por documento (assíncrono — nunca
   * bloqueia num lote grande). Retorna o `batchId` para o front acompanhar o
   * progresso via `GET /documents/bulk-reprocess-ai/:batchId`.
   *
   * PERMISSÃO — DUAS CAMADAS:
   *   1. GATE DE PAPEL (403): exclusivo de SUPER_ADMIN, MULTI_TENANT_ADMIN e
   *      TENANT_ADMIN. UPLOADER e USER NÃO disparam lote — diferente do
   *      reprocess individual (`POST /documents/:id/reprocess`), que continua
   *      UPLOADER+ com ACL. O motivo é o impacto administrativo: um lote de até
   *      500 documentos ACUMULA custo de LLM na empresa e a auto-aplicação
   *      SOBRESCREVE tipo/título/índices já qualificados. O gate roda ANTES de
   *      resolver qualquer id, então o 403 não revela existência de documento.
   *   2. ESCOPO + ACL (404): dentro do gate, só entram documentos que o ator
   *      pode ESCREVER — `assertCanWriteDepartment` por documento. Documento
   *      fora de escopo (outro tenant, sem ACL) resolve para 404, nunca 403 —
   *      não vaza existência. O lote é escopado por UM tenant.
   *
   * FEATURE FLAGS: só enfileira as etapas efetivamente habilitadas para a
   * empresa (`resolveAiFeatureFlags`, plataforma AND empresa). Nenhuma ligada
   * dentre as pedidas ⇒ 422 (nada a fazer).
   */
  app.post(
    '/documents/bulk-reprocess-ai',
    { preHandler: app.authenticate },
    async (request, reply) => {
      // Gate de papel: operação administrativa (custo de IA + sobrescrita em
      // massa). UPLOADER/USER → 403 antes de qualquer leitura de documento.
      requireRole(request, ...ADMIN_ROLES);

      const userId = request.user!.sub;
      const role = request.user!.role;
      const sql = app.db;

      const { documentIds, steps: requestedStepsRaw } = BulkReprocessAiBodySchema.parse(request.body);

      // ------------------------------------------------------------------
      // 1. Resolve os documentos DENTRO do escopo do ator (multi-tenant).
      //    Documento fora do escopo → 404 genérico (nunca revela qual id).
      // ------------------------------------------------------------------
      interface ScopedDocRow { id: string; tenant_id: string; department_id: string }
      let foundDocs: ScopedDocRow[];

      if (role === 'SUPER_ADMIN') {
        foundDocs = await sql<ScopedDocRow[]>`
          SELECT id, tenant_id, department_id
          FROM documents
          WHERE id = ANY(${documentIds}::uuid[])
            AND deleted = false
        `;
      } else if (role === 'MULTI_TENANT_ADMIN') {
        const allowed = request.user?.allowedTenantIds ?? [];
        foundDocs = allowed.length === 0
          ? []
          : await sql<ScopedDocRow[]>`
              SELECT id, tenant_id, department_id
              FROM documents
              WHERE id = ANY(${documentIds}::uuid[])
                AND tenant_id = ANY(${allowed}::uuid[])
                AND deleted = false
            `;
      } else {
        const scopedTenantId = request.tenantId as string;
        foundDocs = await sql<ScopedDocRow[]>`
          SELECT id, tenant_id, department_id
          FROM documents
          WHERE id = ANY(${documentIds}::uuid[])
            AND tenant_id = ${scopedTenantId}
            AND deleted = false
        `;
      }

      if (foundDocs.length !== documentIds.length) {
        // Algum id não existe ou está fora do escopo do ator → 404 genérico.
        throw new NotFoundError('Documento não encontrado');
      }

      // ------------------------------------------------------------------
      // 2. Todos os documentos precisam pertencer à MESMA empresa (o lote é
      //    escopado por tenant). Para SUPER_ADMIN/MTA, seleção cross-tenant
      //    é uso inválido da API (não vazamento) → 422.
      // ------------------------------------------------------------------
      const distinctTenantIds = [...new Set(foundDocs.map((d) => d.tenant_id))];
      if (distinctTenantIds.length > 1) {
        throw new ValidationError('Todos os documentos devem pertencer à mesma empresa');
      }
      const tenantId = distinctTenantIds[0]!;

      // ------------------------------------------------------------------
      // 3. ACL por documento — mesmo choke point do reprocess individual.
      //    USER (nível < UPLOADER) ou sem ACL do departamento → 404.
      // ------------------------------------------------------------------
      for (const doc of foundDocs) {
        await assertCanWriteDepartment(sql, userId, tenantId, doc.department_id, role);
      }

      // ------------------------------------------------------------------
      // 4. Feature flags efetivas → etapas realmente habilitadas.
      // ------------------------------------------------------------------
      const flags = await resolveAiFeatureFlags(sql, tenantId);
      const requestedSteps: AiReprocessStep[] = requestedStepsRaw ?? [...AI_REPROCESS_STEPS];
      const enabledSteps = requestedSteps.filter((step) => {
        if (step === 'title') return flags.classificationEnabled || flags.titleSuggestionEnabled;
        if (step === 'indexes') return flags.indexSuggestionEnabled;
        return flags.tagGenerationEnabled; // 'tags'
      });

      if (enabledSteps.length === 0) {
        throw new ValidationError(
          'Nenhuma etapa de IA está habilitada para a empresa — nada a reprocessar'
        );
      }

      // ------------------------------------------------------------------
      // 5. Cria o lote e enfileira 1 job por documento (assíncrono).
      // ------------------------------------------------------------------
      const batch = await createAiReprocessBatch(sql, {
        tenantId,
        createdBy: userId,
        total: foundDocs.length,
        steps: enabledSteps as AiReprocessBatchStep[],
      });

      if (app.aiReprocessQueue !== null) {
        await app.aiReprocessQueue.addBulk(
          foundDocs.map((doc) => ({
            name: 'reprocess-ai',
            data: AiReprocessJobDataSchema.parse({
              tenantId,
              documentId: doc.id,
              batchId: batch.id,
              steps: enabledSteps,
            }),
          }))
        );
      } else {
        request.log.warn(
          { tenantId, batchId: batch.id, count: foundDocs.length },
          'fila ai-reprocess não configurada — lote criado sem enfileirar jobs'
        );
      }

      // ------------------------------------------------------------------
      // 6. AuditLog (não-bloqueante).
      // ------------------------------------------------------------------
      const auditLogger = new AuditLogger(sql);
      try {
        await auditLogger.record({
          tenantId,
          userId,
          action: 'document.bulk_reprocess_ai',
          resource: `documents/bulk-reprocess-ai/${batch.id}`,
          metadata: {
            batchId: batch.id,
            documentIds,
            count: foundDocs.length,
            steps: enabledSteps,
          },
        });
      } catch (auditError) {
        request.log.error(
          { err: auditError, tenantId, userId, batchId: batch.id, count: foundDocs.length },
          'falha ao registrar audit log de reprocessamento de IA em massa'
        );
      }

      request.log.info(
        { tenantId, userId, batchId: batch.id, count: foundDocs.length, steps: enabledSteps, traceId: request.id },
        'lote de reprocessamento de IA enfileirado'
      );

      return reply.status(202).send({
        batchId: batch.id,
        total: batch.total,
        steps: enabledSteps,
      });
    }
  );

  // =========================================================================
  // GET /documents/bulk-reprocess-ai/:batchId — status do lote (polling, E-4)
  // =========================================================================
  /**
   * Retorna o progresso de um lote de reprocessamento de IA (`total/done/failed/
   * status/steps`) para o polling do front.
   *
   * PERMISSÃO: mesmo gate de papel do disparo — só SUPER_ADMIN,
   * MULTI_TENANT_ADMIN e TENANT_ADMIN (UPLOADER/USER → 403), já que só eles
   * podem criar um lote. ESCOPADO ao tenant do ator: lote de outra empresa →
   * 404 (nunca revela existência).
   */
  app.get(
    '/documents/bulk-reprocess-ai/:batchId',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, ...ADMIN_ROLES);

      const role = request.user!.role;
      const sql = app.db;

      const { batchId } = z.object({ batchId: z.string().uuid() }).parse(request.params);

      let batch: AiReprocessBatchRecord | null;
      if (role === 'SUPER_ADMIN') {
        batch = await getAiReprocessBatchGlobal(sql, batchId);
      } else if (role === 'MULTI_TENANT_ADMIN') {
        batch = await getAiReprocessBatchInTenants(sql, request.user?.allowedTenantIds ?? [], batchId);
      } else {
        batch = await getAiReprocessBatch(sql, request.tenantId as string, batchId);
      }

      if (batch === null) {
        throw new NotFoundError('Lote de reprocessamento não encontrado');
      }

      return reply.status(200).send({
        batchId: batch.id,
        total: batch.total,
        done: batch.done,
        failed: batch.failed,
        status: batch.status,
        steps: batch.steps,
      });
    }
  );

  // =========================================================================
  // POST /documents/bulk-reprocess — reprocessamento COMPLETO em massa (E-7)
  // =========================================================================
  /**
   * Dispara o pipeline INTEGRAL (extração → chunking → embeddings → IA) para um
   * LOTE de documentos em falha: apaga o conteúdo anterior dos elegíveis, volta
   * cada um para `PENDING`, registra o lote (`document_reprocess_batch`) e
   * enfileira um job `process-document` por documento na fila padrão de upload.
   * O progresso é acompanhado por `GET /documents/bulk-reprocess/:batchId`.
   *
   * NÃO CONFUNDIR com `POST /documents/bulk-reprocess-ai` (E-4), que roda SÓ as
   * etapas de IA sobre texto JÁ extraído e por isso não serve para documento
   * `FAILED` (sem texto extraído) — foi essa lacuna que originou esta rota.
   *
   * ELEGIBILIDADE: só documentos em `FAILED`. `READY`/`PENDING`/`PROCESSING` da
   * seleção são PULADOS EM SILÊNCIO (contados em `skipped`/`skippedByStatus`) e
   * NADA neles é tocado. A AUSÊNCIA DE 409 É INTENCIONAL — o reprocess
   * individual devolve 409 para `PENDING`/`PROCESSING`, mas em lote a decisão de
   * produto é pular e explicar na resposta, não recusar a seleção inteira.
   * Não "conserte" isso adicionando 409.
   *
   * PERMISSÃO — DUAS CAMADAS (mesmas do lote de IA):
   *   1. GATE DE PAPEL (403): exclusivo de SUPER_ADMIN, MULTI_TENANT_ADMIN e
   *      TENANT_ADMIN. O individual continua UPLOADER+ACL; aqui não, porque o
   *      lote equivale a até 500 uploads completos (OCR + embeddings + 3 etapas
   *      de IA) e, com FIFO na fila compartilhada, atrasa os uploads de toda a
   *      empresa. O gate roda ANTES de qualquer leitura de documento — o 403 não
   *      revela existência de nada.
   *   2. ESCOPO + ACL (404): `assertCanWriteDepartment` por documento. Documento
   *      de outra empresa ou sem ACL resolve para 404, nunca 403.
   *
   * FILA: `opts` idênticas ao reprocess individual (`attempts: 3`, backoff
   * exponencial 2s) e SEM `priority` — decisão de produto: FIFO, o lote compete
   * de igual para igual com os uploads.
   */
  app.post(
    '/documents/bulk-reprocess',
    { preHandler: app.authenticate },
    async (request, reply) => {
      // Gate de papel: operação administrativa (pipeline integral em massa).
      // UPLOADER/USER → 403 antes de qualquer leitura de documento.
      requireRole(request, ...ADMIN_ROLES);

      const userId = request.user!.sub;
      const role = request.user!.role;
      const sql = app.db;

      const { documentIds } = BulkReprocessBodySchema.parse(request.body);

      // Ids repetidos na seleção contariam duas vezes em `requested`/`total` e
      // gerariam job duplicado — deduplica antes de qualquer coisa.
      const dedupedIds = [...new Set(documentIds)];

      // ------------------------------------------------------------------
      // 1. Resolve os documentos DENTRO do escopo do ator (multi-tenant).
      //    Documento fora do escopo → 404 genérico (nunca revela qual id).
      // ------------------------------------------------------------------
      interface ScopedDocRow {
        id: string;
        tenant_id: string;
        department_id: string;
        status: DocumentRow['status'];
        s3_key: string;
        mime_type: string;
      }
      let foundDocs: ScopedDocRow[];

      if (role === 'SUPER_ADMIN') {
        foundDocs = await sql<ScopedDocRow[]>`
          SELECT id, tenant_id, department_id, status, s3_key, mime_type
          FROM documents
          WHERE id = ANY(${dedupedIds}::uuid[])
            AND deleted = false
        `;
      } else if (role === 'MULTI_TENANT_ADMIN') {
        const allowed = request.user?.allowedTenantIds ?? [];
        foundDocs = allowed.length === 0
          ? []
          : await sql<ScopedDocRow[]>`
              SELECT id, tenant_id, department_id, status, s3_key, mime_type
              FROM documents
              WHERE id = ANY(${dedupedIds}::uuid[])
                AND tenant_id = ANY(${allowed}::uuid[])
                AND deleted = false
            `;
      } else {
        const scopedTenantId = request.tenantId as string;
        foundDocs = await sql<ScopedDocRow[]>`
          SELECT id, tenant_id, department_id, status, s3_key, mime_type
          FROM documents
          WHERE id = ANY(${dedupedIds}::uuid[])
            AND tenant_id = ${scopedTenantId}
            AND deleted = false
        `;
      }

      if (foundDocs.length !== dedupedIds.length) {
        // Algum id não existe ou está fora do escopo do ator → 404 genérico,
        // ANTES de qualquer escrita (nada é reprocessado numa seleção inválida).
        throw new NotFoundError('Documento não encontrado');
      }

      // ------------------------------------------------------------------
      // 2. Todos os documentos precisam pertencer à MESMA empresa (o lote é
      //    escopado por tenant). Para SUPER_ADMIN/MTA, seleção cross-tenant
      //    é uso inválido da API (não vazamento) → 422.
      // ------------------------------------------------------------------
      const distinctTenantIds = [...new Set(foundDocs.map((d) => d.tenant_id))];
      if (distinctTenantIds.length > 1) {
        throw new ValidationError('Todos os documentos devem pertencer à mesma empresa');
      }
      const tenantId = distinctTenantIds[0]!;

      // ------------------------------------------------------------------
      // 3. ACL por documento — mesmo choke point do reprocess individual.
      //    USER (nível < UPLOADER) ou sem ACL do departamento → 404.
      // ------------------------------------------------------------------
      for (const doc of foundDocs) {
        await assertCanWriteDepartment(sql, userId, tenantId, doc.department_id, role);
      }

      // ------------------------------------------------------------------
      // 4. Elegíveis = só os FAILED. Os demais são pulados em silêncio e
      //    explicados na resposta (é o que responde "selecionei 412, por que
      //    o lote diz 400").
      // ------------------------------------------------------------------
      const eligible = foundDocs.filter((doc) => doc.status === 'FAILED');
      const skippedByStatus: Record<string, number> = {};
      for (const doc of foundDocs) {
        if (doc.status === 'FAILED') continue;
        skippedByStatus[doc.status] = (skippedByStatus[doc.status] ?? 0) + 1;
      }
      const skipped = foundDocs.length - eligible.length;

      if (eligible.length === 0) {
        throw new ValidationError(
          'Nenhum documento selecionado está em falha (FAILED) — nada a reprocessar'
        );
      }

      // ------------------------------------------------------------------
      // 5. Transação: limpa o conteúdo dos ELEGÍVEIS e os devolve a PENDING.
      //
      //    ATENÇÃO: os DELETEs e o UPDATE valem SOMENTE sobre `eligibleIds`,
      //    NUNCA sobre `dedupedIds`. Aplicá-los à seleção inteira destruiria
      //    `document_content`/`chunks` de documentos READY que o usuário
      //    selecionou junto — o pior bug possível desta rota.
      //
      //    Um statement com `= ANY` por operação (3 round-trips para 500
      //    documentos, não 1500). `::uuid[]` explícito: postgres.js serializa
      //    `string[]` como `text[]` e o Postgres não converte implicitamente.
      //
      //    Diferente do reprocess individual (que faz os DELETEs e o UPDATE
      //    soltos), aqui o risco é 500× maior e a transação custa uma chamada.
      // ------------------------------------------------------------------
      const eligibleIds = eligible.map((doc) => doc.id);

      const { batch, requeued } = await sql.begin(async (tx) => {
        await tx`
          DELETE FROM chunks
          WHERE tenant_id = ${tenantId}
            AND document_id = ANY(${eligibleIds}::uuid[])
        `;
        await tx`
          DELETE FROM document_content
          WHERE tenant_id = ${tenantId}
            AND document_id = ANY(${eligibleIds}::uuid[])
        `;

        // `AND status = 'FAILED'` é o guarda de corrida: se alguém disparou o
        // reprocess individual entre a leitura (passo 1) e este UPDATE, o
        // documento já não está FAILED, não é tocado, não vira job duplicado e
        // não entra no `document_ids` do lote. O RETURNING — e não
        // `eligible.length` — é a fonte de verdade do `total`.
        const requeuedRows = await tx<Array<{ id: string; s3_key: string; mime_type: string }>>`
          UPDATE documents
          SET status = 'PENDING',
              failure_reason = NULL
          WHERE tenant_id = ${tenantId}
            AND id = ANY(${eligibleIds}::uuid[])
            AND status = 'FAILED'
          RETURNING id, s3_key, mime_type
        `;

        if (requeuedRows.length === 0) {
          // Corrida perdida por completo: nada mais estava FAILED. Lançar aqui
          // faz o ROLLBACK dos DELETEs (postgres.js) — nada é destruído.
          throw new ValidationError(
            'Nenhum documento selecionado está em falha (FAILED) — nada a reprocessar'
          );
        }

        const created = await createDocumentReprocessBatch(tx as unknown as Sql, {
          tenantId,
          createdBy: userId,
          documentIds: requeuedRows.map((row) => row.id),
          total: requeuedRows.length,
          skipped,
        });

        return {
          batch: created,
          requeued: requeuedRows.map((row) => ({
            id: row.id,
            s3Key: row.s3_key,
            mimeType: row.mime_type,
          })),
        };
      });

      // ------------------------------------------------------------------
      // 6. Enfileiramento DEPOIS do commit, nunca dentro: dentro, um commit
      //    falho deixaria jobs fantasmas sobre documentos ainda FAILED. Depois,
      //    o pior caso é "PENDING sem job" — visível na listagem e recuperável.
      //
      //    Se o `addBulk` falhar (Redis fora do ar), COMPENSA: devolve os
      //    documentos a FAILED e responde 502. Sem isso, uma queda do Redis no
      //    disparo prenderia 500 documentos em PENDING sem nada que os tirasse
      //    de lá.
      // ------------------------------------------------------------------
      const requeuedIds = requeued.map((doc) => doc.id);

      if (app.queue !== null) {
        try {
          await app.queue.addBulk(
            requeued.map((doc) => ({
              name: 'process-document',
              data: DocumentProcessingJobDataSchema.parse({
                tenantId,
                documentId: doc.id,
                s3Key: doc.s3Key,
                mimeType: doc.mimeType,
              }),
              // Mesmas opts do reprocess individual. SEM `priority`: FIFO por
              // decisão de produto — o lote não fura a fila dos uploads.
              opts: {
                attempts: 3,
                backoff: { type: 'exponential' as const, delay: 2000 },
              },
            }))
          );
        } catch (queueError) {
          try {
            await sql`
              UPDATE documents
              SET status = 'FAILED',
                  failure_reason = ${'Falha ao enfileirar reprocessamento em lote'}
              WHERE tenant_id = ${tenantId}
                AND id = ANY(${requeuedIds}::uuid[])
                AND status = 'PENDING'
            `;
          } catch (compensationError) {
            request.log.error(
              { err: compensationError, tenantId, userId, batchId: batch.id, count: requeuedIds.length },
              'falha ao compensar documentos após erro de enfileiramento em lote'
            );
          }

          request.log.error(
            { err: queueError, tenantId, userId, batchId: batch.id, count: requeuedIds.length },
            'falha ao enfileirar lote de reprocessamento completo'
          );

          throw new UpstreamServiceError(
            'Falha ao enfileirar o reprocessamento em lote. Nenhum documento foi reprocessado.'
          );
        }
      } else {
        request.log.warn(
          { tenantId, batchId: batch.id, count: requeuedIds.length },
          'fila de documentos não configurada — lote criado sem enfileirar jobs'
        );
      }

      // ------------------------------------------------------------------
      // 7. AuditLog (não-bloqueante).
      // ------------------------------------------------------------------
      const auditLogger = new AuditLogger(sql);
      try {
        await auditLogger.record({
          tenantId,
          userId,
          action: 'document.bulk_reprocess',
          resource: `documents/bulk-reprocess/${batch.id}`,
          metadata: {
            batchId: batch.id,
            requested: dedupedIds.length,
            total: batch.total,
            skipped,
          },
        });
      } catch (auditError) {
        request.log.error(
          { err: auditError, tenantId, userId, batchId: batch.id, count: batch.total },
          'falha ao registrar audit log de reprocessamento completo em massa'
        );
      }

      request.log.info(
        {
          tenantId,
          userId,
          batchId: batch.id,
          requested: dedupedIds.length,
          total: batch.total,
          skipped,
          traceId: request.id,
        },
        'lote de reprocessamento completo enfileirado'
      );

      return reply.status(202).send({
        batchId: batch.id,
        requested: dedupedIds.length,
        total: batch.total,
        skipped,
        skippedByStatus,
      });
    }
  );

  // =========================================================================
  // GET /documents/bulk-reprocess/:batchId — progresso DERIVADO do lote (E-7)
  // =========================================================================
  /**
   * Retorna o progresso de um lote de reprocessamento completo para o polling
   * do front. Os contadores NÃO são persistidos: são derivados de
   * `documents.status` sobre a lista imutável de ids do lote
   * (`deriveDocumentReprocessBatchProgress`) — ver o cabeçalho de
   * `packages/db-pg/src/document-reprocess-batch.ts` para o porquê.
   *
   * PERMISSÃO: mesmo gate de papel do disparo (UPLOADER/USER → 403) e mesmo
   * dispatch por papel do E-4. Lote de outra empresa → 404 (nunca 403: não
   * vaza a existência de lote alheio).
   */
  app.get(
    '/documents/bulk-reprocess/:batchId',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, ...ADMIN_ROLES);

      const role = request.user!.role;
      const sql = app.db;

      const { batchId } = z.object({ batchId: z.string().uuid() }).parse(request.params);

      let batch: DocumentReprocessBatchRecord | null;
      if (role === 'SUPER_ADMIN') {
        batch = await getDocumentReprocessBatchGlobal(sql, batchId);
      } else if (role === 'MULTI_TENANT_ADMIN') {
        batch = await getDocumentReprocessBatchInTenants(
          sql,
          request.user?.allowedTenantIds ?? [],
          batchId
        );
      } else {
        batch = await getDocumentReprocessBatch(sql, request.tenantId as string, batchId);
      }

      if (batch === null) {
        throw new NotFoundError('Lote de reprocessamento não encontrado');
      }

      const progress = await deriveDocumentReprocessBatchProgress(sql, batch);

      return reply.status(200).send({
        batchId: batch.id,
        total: progress.total,
        done: progress.done,
        failed: progress.failed,
        pending: progress.pending,
        skipped: batch.skipped,
        status: progress.status,
        stalled: progress.stalled,
        createdAt: batch.createdAt.toISOString(),
      });
    }
  );

  // =========================================================================
  // POST /documents/bulk-delete — exclusão em massa (E-8)
  // =========================================================================
  /**
   * Aplica a MESMA exclusão do `DELETE /documents/:id` a até 500 documentos numa
   * chamada: soft delete do documento (`deleted = true`), remoção FÍSICA de
   * `chunks` e `document_content` e remoção do objeto no S3.
   *
   * SÍNCRONA, sem lote/fila/polling — ao contrário dos reprocessamentos em massa
   * (E-4/E-7), aqui não há trabalho a acompanhar: são 3 statements por `= ANY`
   * que fecham em milissegundos mesmo para 500 documentos. Responde 200 com a
   * contagem do que foi efetivamente excluído.
   *
   * SEM ELEGIBILIDADE POR STATUS: documento em qualquer status pode ser
   * excluído (deletar é deletar; o individual também não tem guarda), logo não
   * existe `skipped`/`skippedByStatus` aqui.
   *
   * PERMISSÃO — DUAS CAMADAS:
   *   1. GATE DE PAPEL (403): exclusivo de SUPER_ADMIN, MULTI_TENANT_ADMIN e
   *      TENANT_ADMIN. ASSIMETRIA DELIBERADA em relação ao `DELETE
   *      /documents/:id`, que continua permitido a UPLOADER com ACL — o estrago
   *      de um clique é proporcional à seleção. O gate roda ANTES de qualquer
   *      leitura de documento, então o 403 não revela existência de nada.
   *   2. ESCOPO + ACL (404): `assertCanWriteDepartment` por documento. Documento
   *      de outra empresa ou sem ACL resolve para 404, nunca 403.
   *
   * `document_events` NÃO é tocado: o histórico de uso/cobrança preserva o
   * upload que aconteceu, mesmo que o documento não exista mais.
   */
  app.post('/documents/bulk-delete', { preHandler: app.authenticate }, async (request, reply) => {
    // Gate de papel: operação administrativa e IRREVERSÍVEL.
    // UPLOADER/USER → 403 antes de qualquer leitura de documento.
    requireRole(request, ...ADMIN_ROLES);

    const userId = request.user!.sub;
    const role = request.user!.role;
    const sql = app.db;

    const { documentIds } = BulkDeleteBodySchema.parse(request.body);

    // Ids repetidos contariam duas vezes em `requested` e gerariam uma segunda
    // tentativa de remoção do mesmo objeto no S3 — deduplica antes de tudo.
    const dedupedIds = [...new Set(documentIds)];

    // ------------------------------------------------------------------
    // 1. Resolve os documentos DENTRO do escopo do ator (multi-tenant).
    //    Documento fora do escopo → 404 genérico (nunca revela qual id).
    // ------------------------------------------------------------------
    interface ScopedDocRow {
      id: string;
      tenant_id: string;
      department_id: string;
      s3_key: string;
    }
    let foundDocs: ScopedDocRow[];

    if (role === 'SUPER_ADMIN') {
      foundDocs = await sql<ScopedDocRow[]>`
        SELECT id, tenant_id, department_id, s3_key
        FROM documents
        WHERE id = ANY(${dedupedIds}::uuid[])
          AND deleted = false
      `;
    } else if (role === 'MULTI_TENANT_ADMIN') {
      const allowed = request.user?.allowedTenantIds ?? [];
      foundDocs = allowed.length === 0
        ? []
        : await sql<ScopedDocRow[]>`
            SELECT id, tenant_id, department_id, s3_key
            FROM documents
            WHERE id = ANY(${dedupedIds}::uuid[])
              AND tenant_id = ANY(${allowed}::uuid[])
              AND deleted = false
          `;
    } else {
      const scopedTenantId = request.tenantId as string;
      foundDocs = await sql<ScopedDocRow[]>`
        SELECT id, tenant_id, department_id, s3_key
        FROM documents
        WHERE id = ANY(${dedupedIds}::uuid[])
          AND tenant_id = ${scopedTenantId}
          AND deleted = false
      `;
    }

    if (foundDocs.length !== dedupedIds.length) {
      // Algum id não existe, já foi excluído ou está fora do escopo do ator →
      // 404 genérico, ANTES de qualquer escrita. Uma seleção inválida não
      // exclui NADA — nem os ids válidos que vieram junto.
      throw new NotFoundError('Documento não encontrado');
    }

    // ------------------------------------------------------------------
    // 2. Todos os documentos precisam pertencer à MESMA empresa (a operação é
    //    escopada por tenant). Para SUPER_ADMIN/MTA, seleção cross-tenant é
    //    uso inválido da API (não vazamento) → 422.
    // ------------------------------------------------------------------
    const distinctTenantIds = [...new Set(foundDocs.map((d) => d.tenant_id))];
    if (distinctTenantIds.length > 1) {
      throw new ValidationError('Todos os documentos devem pertencer à mesma empresa');
    }
    const tenantId = distinctTenantIds[0]!;

    // ------------------------------------------------------------------
    // 3. ACL por documento — mesmo choke point do delete individual.
    //    Sem permissão de ESCRITA no departamento → 404.
    // ------------------------------------------------------------------
    for (const doc of foundDocs) {
      await assertCanWriteDepartment(sql, userId, tenantId, doc.department_id, role);
    }

    // ------------------------------------------------------------------
    // 4. Transação: soft delete + remoção física de chunks e texto extraído.
    //
    //    Um statement com `= ANY` por operação (3 round-trips para 500
    //    documentos, não 1500). `::uuid[]` explícito: postgres.js serializa
    //    `string[]` como `text[]` e o Postgres não converte implicitamente.
    //
    //    `AND deleted = false` no UPDATE + `RETURNING` é o guarda de corrida:
    //    se outra sessão excluiu um documento entre o passo 1 e este UPDATE,
    //    ele não é recontado. O RETURNING — e NUNCA `foundDocs.length` — é a
    //    fonte de verdade da contagem e da lista de chaves S3 a remover.
    //
    //    Os DELETEs valem sobre `targetIds` (e não sobre as linhas do
    //    RETURNING) de propósito: um documento que perdeu a corrida já foi
    //    excluído por quem venceu, e apagar chunks/conteúdo dele é idempotente.
    // ------------------------------------------------------------------
    const targetIds = foundDocs.map((doc) => doc.id);

    const deletedDocs = await sql.begin(async (tx) => {
      const rows = await tx<Array<{ id: string; s3_key: string }>>`
        UPDATE documents
        SET deleted = true
        WHERE tenant_id = ${tenantId}
          AND id = ANY(${targetIds}::uuid[])
          AND deleted = false
        RETURNING id, s3_key
      `;

      await tx`
        DELETE FROM chunks
        WHERE tenant_id = ${tenantId}
          AND document_id = ANY(${targetIds}::uuid[])
      `;
      await tx`
        DELETE FROM document_content
        WHERE tenant_id = ${tenantId}
          AND document_id = ANY(${targetIds}::uuid[])
      `;

      // Materializa em objetos simples: o resultado de postgres.js carrega
      // metadados que não sobrevivem ao unwrap do `begin`.
      return rows.map((row) => ({ id: row.id, s3Key: row.s3_key }));
    });

    const deletedCount = deletedDocs.length;

    // ------------------------------------------------------------------
    // 5. S3 DEPOIS do commit, nunca dentro: apagar antes arriscaria destruir o
    //    arquivo de uma transação que não commitou.
    //
    //    Best-effort com `Promise.allSettled` — 500 deleções não podem virar
    //    500 rejeições não tratadas. Falha só loga e NÃO desfaz a exclusão,
    //    exatamente como no delete individual: o documento excluído continua
    //    excluído (o pior caso é um objeto órfão no bucket).
    // ------------------------------------------------------------------
    const s3Results = await Promise.allSettled(
      deletedDocs.map((doc) => app.s3.deleteFile(doc.s3Key))
    );
    s3Results.forEach((result, i) => {
      if (result.status === 'rejected') {
        request.log.error(
          {
            err: result.reason,
            tenantId,
            userId,
            documentId: deletedDocs[i]!.id,
            s3Key: deletedDocs[i]!.s3Key,
            traceId: request.id,
          },
          'falha ao remover arquivo do S3 em exclusão em massa'
        );
      }
    });

    // ------------------------------------------------------------------
    // 6. AuditLog (não-bloqueante).
    // ------------------------------------------------------------------
    const auditLogger = new AuditLogger(sql);
    try {
      await auditLogger.record({
        tenantId,
        userId,
        action: 'document.bulk_delete',
        resource: 'documents/bulk-delete',
        metadata: {
          documentIds: deletedDocs.map((doc) => doc.id),
          count: deletedCount,
        },
      });
    } catch (auditError) {
      request.log.error(
        { err: auditError, tenantId, userId, count: deletedCount },
        'falha ao registrar audit log de exclusão em massa'
      );
    }

    request.log.info(
      {
        tenantId,
        userId,
        requested: dedupedIds.length,
        deleted: deletedCount,
        traceId: request.id,
      },
      'documentos excluídos em massa'
    );

    return reply.status(200).send({ deleted: deletedCount });
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
  // `suggestDocumentIndexes`, que lança `ValidationError` caso contrário). Com
  // `aiIndexAutoApplyEnabled` ligada, mescla os valores sugeridos em
  // `documents.index_values` COM SOBRESCRITA (campo a campo, substitui um
  // valor já confirmado quando a sugestão desta rodada vier preenchida).
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
    // 4. Resposta HTTP `{ fields: [{ name, value, confidence }] }` (spec §7).
    //    O array já vem do service montado a partir dos campos REAIS do tipo
    //    (`indexFieldRows`), com valor normalizado/validado e confiança casada
    //    por campo. Nomes de campo alucinados pelo LLM foram descartados no
    //    service — nunca chegam aqui nem vazam na resposta.
    // ------------------------------------------------------------------
    const fields = result.fields;

    log.info(
      {
        fieldsRequested: fields.length,
        fieldsSuggested: fields.filter((f) => f.value !== null).length,
        costUsd: result.costUsd,
      },
      'sugestão de índices retornada'
    );

    // ------------------------------------------------------------------
    // 3.1 Aplicação automática (gate: aiIndexAutoApplyEnabled) — o tipo aqui já
    //     é sempre o CONFIRMADO (pré-condição do próprio service), então não há
    //     o problema do "tipo órfão" do gatilho automático de upload. Mescla os
    //     valores sugeridos em `documents.index_values`, campo a campo, COM
    //     SOBRESCRITA — substitui um valor já confirmado quando a sugestão
    //     desta rodada vier preenchida; só preserva o valor atual quando a IA
    //     não sugerir nada de novo para aquele campo. Busca `index_values`
    //     FRESCO (não o `doc` resolvido no passo 1, que pode estar
    //     desatualizado após a chamada ao LLM) para minimizar a janela de
    //     corrida com um PATCH concorrente.
    // ------------------------------------------------------------------
    let appliedIndexValues: Record<string, string | number | null> | undefined;
    if (aiFlags.indexAutoApplyEnabled) {
      const freshRows = await sql<Array<{ index_values: Record<string, string | number | null> }>>`
        SELECT index_values FROM documents WHERE id = ${id} AND tenant_id = ${tenantId} LIMIT 1
      `;
      const currentIndexValues = freshRows[0]?.index_values ?? {};
      const indexFieldRows = await sql<IndexFieldRow[]>`
        SELECT id, name, field_type, required, ai_extraction_hint, sort_order, show_on_search, deleted
        FROM document_type_index_fields
        WHERE document_type_id = ${doc.document_type_id}
          AND deleted = false
      `;
      const suggestedRaw = Object.fromEntries(
        fields.filter((f) => f.value !== null).map((f) => [f.name, f.value as string])
      );
      const { merged, appliedCount } = mergeSuggestedIndexValues(currentIndexValues, suggestedRaw, indexFieldRows);
      if (appliedCount > 0) {
        await sql`
          UPDATE documents
          SET index_values = ${sql.json(merged as unknown as JSONValue)}
          WHERE id = ${id}
            AND tenant_id = ${tenantId}
        `;
        appliedIndexValues = merged;
      }
    }

    return reply.status(200).send({
      fields,
      model: result.indexSuggestion.model,
      promptVersion: result.indexSuggestion.promptVersion,
      suggestedAt: result.indexSuggestion.suggestedAt,
      costUsd: result.costUsd,
      ...(appliedIndexValues !== undefined ? { appliedIndexValues } : {}),
    });
  });

  // =========================================================================
  // POST /documents/:id/classify — classificação automática de tipo por IA
  // (Fase 8, entregável #61). Sob demanda — re-sugere o tipo de um documento já
  // processado. Persiste `document_content.type_suggestion` (e o
  // `documents.suggested_title`, quando a feature de título está ligada); com
  // `aiClassificationAutoApplyEnabled`/`aiTitleAutoApplyEnabled` ligadas,
  // SUBSTITUI `document_type_id`/`title` pela sugestão desta rodada mesmo já
  // havendo uma escolha confirmada — só preserva o valor atual quando a
  // sugestão desta rodada vier vazia/nula ou (tipo) com confiança insuficiente.
  // Espelha o guard/escopo de `POST /documents/:id/suggest-indexes`.
  //
  // Body OPCIONAL `{ scope }` (T-53) delimita a QUE campo a rodada se aplica —
  // cada botão da tela manda o seu, para nenhum deles mexer no campo do outro.
  // Ausente ⇒ ambos, como sempre foi.
  // =========================================================================
  app.post('/documents/:id/classify', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.user!.sub;
    const role = request.user!.role;
    const sql = app.db;

    const { id } = DocumentIdParamsSchema.parse(request.params);
    // Parse ANTES de resolver o documento/chamar o LLM: body inválido custa 422,
    // nunca tokens. Fastify entrega `undefined` quando não há corpo.
    const { scope } = ClassifyBodySchema.parse(request.body ?? {});
    const classifyScope = scope ?? CLASSIFY_SCOPE_ALL;
    const scopeHasType = classifyScope.includes('type');
    const scopeHasTitle = classifyScope.includes('title');

    // ------------------------------------------------------------------
    // 1. Resolve o documento respeitando o escopo do role (mesmo padrão de
    //    GET/PATCH/DELETE/suggest-indexes) — documento de outro tenant sempre
    //    vira 404, nunca 403 (spec §10, invariante 4).
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

    // Classificação sob demanda é uma ESCRITA (persiste `type_suggestion`,
    // `suggested_title` e incrementa custo) — exige a mesma permissão de escrita
    // no departamento usada em PATCH/DELETE/suggest-indexes.
    await assertCanWriteDepartment(sql, userId, tenantId, doc.department_id, role);

    const log = request.log.child({ tenantId, documentId: id, userId, traceId: request.id });

    // ------------------------------------------------------------------
    // 2. Feature flags de IA (Fase 6.9) — valor EFETIVO (plataforma AND empresa),
    //    ainda restringido pelo `scope` desta chamada. O escopo só DESLIGA: nunca
    //    liga o que a empresa desabilitou. Classificação de tipo e título sugerido
    //    nascem da MESMA chamada de LLM, então basta UMA das duas continuar de pé
    //    para a chamada valer a pena; com AMBAS fora ⇒ 403 ANTES de qualquer custo.
    //
    //    Fora do escopo, `titleSuggestionEnabled: false` faz o núcleo devolver
    //    `suggestedTitle: null` (applyFlagMask) e o service NÃO tocar em
    //    `documents.suggested_title` — é assim que "reclassificar o tipo" deixa o
    //    título inteiramente em paz, sugestão inclusive.
    // ------------------------------------------------------------------
    const aiFlags = await resolveAiFeatureFlags(sql, tenantId);
    const titleSuggestionInScope = aiFlags.titleSuggestionEnabled && scopeHasTitle;
    const classificationInScope = aiFlags.classificationEnabled && scopeHasType;
    if (!classificationInScope && !titleSuggestionInScope) {
      log.info(
        { scope: classifyScope },
        'classificação por IA desabilitada para esta empresa ou fora do escopo — LLM não chamado'
      );
      throw new ForbiddenError('Classificação por IA está desabilitada para esta empresa');
    }

    // ------------------------------------------------------------------
    // 3. Chama o service (valida a pré-condição de documento processado —
    //    NotFoundError/ValidationError propagam para o error handler central,
    //    mapeando para 404/422). Falha do provedor de LLM (chave inválida/ausente,
    //    provedor fora do ar) vira 502 — não é bug do DMDoc, é upstream.
    // ------------------------------------------------------------------
    let result: Awaited<ReturnType<typeof classifyDocument>>;
    try {
      result = await classifyDocument(
        {
          tenantId,
          documentId: id,
          flags: {
            // `classificationEnabled` NÃO é restringido pelo escopo de propósito:
            // ao contrário de `suggested_title`, a `type_suggestion` é gravada
            // incondicionalmente pelo service, então mascarar aqui a sobrescreveria
            // com nulos — apagando a sugestão da rodada anterior. Para o escopo
            // sem 'type' basta não AUTO-APLICAR o tipo (passo 3.1 abaixo).
            classificationEnabled: aiFlags.classificationEnabled,
            titleSuggestionEnabled: titleSuggestionInScope,
          },
        },
        { sql, llmProvider, chatModel: config.LLM_MODEL, logger: log }
      );
    } catch (err) {
      if (err instanceof LLMError) {
        log.error({ err }, 'classificação falhou por erro do provedor de LLM');
        throw new UpstreamServiceError(
          'Não foi possível classificar o documento agora — falha ao chamar o provedor de IA. Tente novamente em instantes.'
        );
      }
      throw err;
    }

    log.info(
      {
        documentTypeId: result.typeSuggestion.documentTypeId,
        confidence: result.typeSuggestion.confidence,
        hasSuggestedTitle: result.suggestedTitle !== null,
        catalogSize: result.catalogSize,
        scope: classifyScope,
        costUsd: result.costUsd,
      },
      'classificação sob demanda retornada'
    );

    // ------------------------------------------------------------------
    // 3.1 Aplicação automática de TIPO e TÍTULO (aiClassificationAutoApplyEnabled
    //     / aiTitleAutoApplyEnabled), COM SOBRESCRITA (decisão do Owner,
    //     2026-07-22): substitui document_type_id/title pela sugestão desta
    //     rodada mesmo já havendo um valor confirmado. Só preserva o valor
    //     atual quando a sugestão desta rodada vier vazia/nula ou (no caso do
    //     tipo) com confiança abaixo do limiar — o gate abaixo garante isso.
    //
    //     O `scope` da chamada é a primeira condição de cada gate: fora dele o
    //     campo não é sequer candidato a mudar (T-53). Para o título isso é
    //     redundante — `suggestedTitle` já vem null —, mas explicitar mantém a
    //     regra legível dos dois lados.
    // ------------------------------------------------------------------
    let appliedType: { documentTypeId: string; documentTypeName: string | null } | undefined;
    if (
      scopeHasType &&
      aiFlags.classificationAutoApplyEnabled &&
      result.typeSuggestion.documentTypeId !== null &&
      result.typeSuggestion.confidence >= config.DMDOC_INDEX_SUGGESTION_MIN_CONFIDENCE
    ) {
      const applied = await sql`
        UPDATE documents
        SET document_type_id = ${result.typeSuggestion.documentTypeId}
        WHERE id = ${id}
          AND tenant_id = ${tenantId}
      `;
      if (applied.count > 0) {
        appliedType = {
          documentTypeId: result.typeSuggestion.documentTypeId,
          documentTypeName: result.typeSuggestion.documentTypeName,
        };
      }
    }

    let appliedTitle: string | undefined;
    if (scopeHasTitle && aiFlags.titleAutoApplyEnabled && result.suggestedTitle !== null) {
      const applied = await sql`
        UPDATE documents
        SET title = ${result.suggestedTitle}
        WHERE id = ${id}
          AND tenant_id = ${tenantId}
      `;
      if (applied.count > 0) {
        appliedTitle = result.suggestedTitle;
      }
    }

    // ------------------------------------------------------------------
    // 4. Resposta 200 — subconjunto do TypeSuggestion (sem rawResponse) +
    //    título sugerido + custo desta chamada. `appliedType`/`appliedTitle`
    //    só aparecem quando a auto-aplicação efetivamente mudou algo.
    //    `catalogSize` sempre presente: é o que permite à tela explicar POR QUE
    //    a IA não achou tipo (0 ⇒ nenhum tipo associado ao departamento).
    // ------------------------------------------------------------------
    return reply.status(200).send({
      typeSuggestion: {
        documentTypeId: result.typeSuggestion.documentTypeId,
        documentTypeName: result.typeSuggestion.documentTypeName,
        confidence: result.typeSuggestion.confidence,
        model: result.typeSuggestion.model,
        promptVersion: result.typeSuggestion.promptVersion,
        suggestedAt: result.typeSuggestion.suggestedAt,
      },
      suggestedTitle: result.suggestedTitle,
      catalogSize: result.catalogSize,
      costUsd: result.costUsd,
      ...(appliedType !== undefined ? { appliedType } : {}),
      ...(appliedTitle !== undefined ? { appliedTitle } : {}),
    });
  });

  // =========================================================================
  // POST /documents/:id/generate-tags — geração de tags por IA sob demanda
  // (Fase 9 / E-3 / GH #36). Investiga o texto do documento já processado e
  // gera até 30 tags. Persiste `document_content.suggested_tags` (e acumula
  // custo); com a 5ª feature de IA (`aiTagAutoApplyEnabled`) ligada, também
  // mescla automaticamente em `documents.tags` (as confirmadas) — sem exigir
  // clique manual, nunca removendo tags já confirmadas.
  // Espelha o guard/escopo de `POST /documents/:id/suggest-indexes`.
  // =========================================================================
  app.post('/documents/:id/generate-tags', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.user!.sub;
    const role = request.user!.role;
    const sql = app.db;

    const { id } = DocumentIdParamsSchema.parse(request.params);

    // ------------------------------------------------------------------
    // 1. Resolve o documento respeitando o escopo do role (mesmo padrão de
    //    GET/PATCH/DELETE/suggest-indexes) — documento de outro tenant sempre
    //    vira 404, nunca 403 (spec §10, invariante 4).
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

    // Geração de tags é uma ESCRITA (persiste `suggested_tags` e incrementa
    // custo) — exige a mesma permissão de escrita no departamento usada em
    // PATCH/DELETE/suggest-indexes/classify.
    await assertCanWriteDepartment(sql, userId, tenantId, doc.department_id, role);

    const log = request.log.child({ tenantId, documentId: id, userId, traceId: request.id });

    // ------------------------------------------------------------------
    // 2. Feature flag de IA (Fase 9) — valor EFETIVO (plataforma AND empresa)
    //    checado ANTES de qualquer custo de LLM. Desligada ⇒ 403.
    // ------------------------------------------------------------------
    const aiFlags = await resolveAiFeatureFlags(sql, tenantId);
    if (!aiFlags.tagGenerationEnabled) {
      log.info({}, 'geração de tags por IA desabilitada para esta empresa — LLM não chamado');
      throw new ForbiddenError('Geração de tags por IA está desabilitada para esta empresa');
    }

    // ------------------------------------------------------------------
    // 3. Chama o service (valida a pré-condição de documento processado —
    //    NotFoundError propaga para o error handler central, mapeando para 404).
    //    Falha do provedor de LLM (chave inválida/ausente, provedor fora do ar)
    //    vira 502 — não é bug do DMDoc, é upstream.
    // ------------------------------------------------------------------
    let result: Awaited<ReturnType<typeof generateDocumentTags>>;
    try {
      result = await generateDocumentTags({ tenantId, documentId: id }, { sql, llmProvider, logger: log });
    } catch (err) {
      if (err instanceof LLMError) {
        log.error({ err }, 'geração de tags falhou por erro do provedor de LLM');
        throw new UpstreamServiceError(
          'Não foi possível gerar as tags agora — falha ao chamar o provedor de IA. Tente novamente em instantes.'
        );
      }
      throw err;
    }

    log.info(
      { tagsGenerated: result.tags.length, costUsd: result.costUsd },
      'geração de tags sob demanda retornada'
    );

    // ------------------------------------------------------------------
    // 3.1. Aplicação automática (5ª feature de IA, `aiTagAutoApplyEnabled`) —
    //      quando ligada, mescla as tags recém-sugeridas em `documents.tags`
    //      (dedupe case-insensitive, teto de 60), sem exigir o clique manual
    //      do usuário no card "Tags sugeridas pela IA". Nunca remove tags já
    //      confirmadas. Mesma lógica do gatilho automático do worker.
    // ------------------------------------------------------------------
    let appliedTags: string[] | undefined;
    if (aiFlags.tagAutoApplyEnabled && result.tags.length > 0) {
      const docRows = await sql<Array<{ tags: string[] }>>`
        SELECT tags FROM documents WHERE id = ${id} AND tenant_id = ${tenantId} LIMIT 1
      `;
      const currentTags = docRows[0]?.tags ?? [];
      const merged = mergeConfirmedTags(currentTags, result.tags);
      if (merged.length !== currentTags.length) {
        await sql`UPDATE documents SET tags = ${merged} WHERE id = ${id} AND tenant_id = ${tenantId}`;
        appliedTags = merged;
        log.info(
          { tagsBefore: currentTags.length, tagsAfter: merged.length },
          'tags sugeridas aplicadas automaticamente (aiTagAutoApplyEnabled)'
        );
      }
    }

    // ------------------------------------------------------------------
    // 4. Resposta 200 — subconjunto público (tags + generatedAt) + custo desta
    //    chamada. Campos de auditoria (model/promptVersion/rawResponse) não vazam.
    //    `appliedTags` só aparece quando a aplicação automática efetivamente
    //    mudou `documents.tags` (undefined nos demais casos).
    // ------------------------------------------------------------------
    return reply.status(200).send({
      suggestedTags: {
        tags: result.tags,
        generatedAt: result.generatedAt,
      },
      costUsd: result.costUsd,
      ...(appliedTags !== undefined ? { appliedTags } : {}),
    });
  });
};
