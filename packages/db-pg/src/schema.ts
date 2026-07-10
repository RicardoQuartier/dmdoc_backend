/**
 * Schema Drizzle para o DMDoc — PostgreSQL + pgvector.
 *
 * Tabelas (13 no total):
 *   tenants, users, departments, department_permissions,
 *   document_types, document_type_index_fields,
 *   global_type_tenant_depts, documents, document_content,
 *   chunks, document_events, department_templates, audit_logs
 *
 * Regras gerais de mapeamento MongoDB → PostgreSQL:
 *   - string (UUID)          → uuid  (default pgCrypto.gen_random_uuid())
 *   - string (texto)         → text
 *   - number (int)           → integer
 *   - sizeBytes / diskQuota  → bigint  (podem ultrapassar 2^31)
 *   - boolean                → boolean
 *   - Date                   → timestamp with timezone (mode: 'date')
 *   - string[]               → text().array()
 *   - Record<string, any>    → jsonb
 *   - number[] 1536 dims     → vector(1536)  via pgvector
 */

import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  bigint,
  timestamp,
  jsonb,
  primaryKey,
  unique,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customType } from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Custom type: pgvector
// ---------------------------------------------------------------------------

/**
 * Tipo customizado para colunas vector(N) do pgvector.
 * Armazenado como `[f1,f2,...,fN]` no wire; deserializado como number[].
 */
const vector = (name: string, dimensions: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dimensions})`;
    },
    toDriver(value: number[]): string {
      return `[${value.join(',')}]`;
    },
    fromDriver(value: string): number[] {
      return value
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map(Number);
    },
  })(name);

// ---------------------------------------------------------------------------
// tenants
// ---------------------------------------------------------------------------

/**
 * Empresa (tenant). Raiz do isolamento multi-tenant.
 * `active = false` desativa a empresa; `deleted = true` marca exclusão lógica
 * (purga total dos dados, registro preservado para integridade referencial).
 */
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  diskQuotaBytes: bigint('disk_quota_bytes', { mode: 'bigint' }).notNull(),
  userQuota: integer('user_quota').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
  deleted: boolean('deleted').notNull().default(false),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  // Toggles por empresa das features de IA de sugestão (Fases 7/8/8.1) — plus
  // comercial por empresa, geridos EXCLUSIVAMENTE pelo SUPER_ADMIN via
  // PATCH /admin/tenants/:id (mesmo fluxo de edição de cotas). O TENANT_ADMIN
  // não tem acesso de leitura nem escrita a estas flags. Valor efetivo de
  // cada feature = platformSettings.<feature> AND tenants.<feature>.
  aiClassificationEnabled: boolean('ai_classification_enabled').notNull().default(true),
  aiTitleSuggestionEnabled: boolean('ai_title_suggestion_enabled').notNull().default(true),
  aiIndexSuggestionEnabled: boolean('ai_index_suggestion_enabled').notNull().default(true),
});

// ---------------------------------------------------------------------------
// platform_settings
// ---------------------------------------------------------------------------

/**
 * Configuração global de plataforma — registro SINGLETON (linha única, sem
 * tenantId), gerido exclusivamente pelo SUPER_ADMIN via
 * `PATCH /admin/platform-settings`. Kill switch das mesmas 3 features de IA
 * de sugestão presentes em `tenants`: quando desligada aqui, nenhum tenant
 * consegue usá-la, independente da própria configuração (ver migration
 * 0004_ai_feature_flags.sql — índice único parcial garante singleton).
 */
export const platformSettings = pgTable('platform_settings', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  aiClassificationEnabled: boolean('ai_classification_enabled').notNull().default(true),
  aiTitleSuggestionEnabled: boolean('ai_title_suggestion_enabled').notNull().default(true),
  aiIndexSuggestionEnabled: boolean('ai_index_suggestion_enabled').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
});

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

/**
 * Usuário de uma empresa (ou global para SUPER_ADMIN / MULTI_TENANT_ADMIN).
 * Unique: (tenantId, email) — mas tenantId pode ser NULL para papéis globais.
 * `allowedTenantIds` é relevante apenas para MULTI_TENANT_ADMIN.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    role: text('role').notNull(), // 'SUPER_ADMIN' | 'MULTI_TENANT_ADMIN' | 'TENANT_ADMIN' | 'UPLOADER' | 'USER'
    active: boolean('active').notNull().default(true),
    allowedTenantIds: text('allowed_tenant_ids').array(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    deleted: boolean('deleted').notNull().default(false),
  },
  (t) => [
    unique('uniq_users_tenant_email').on(t.tenantId, t.email),
    index('users_by_tenant').on(t.tenantId),
  ],
);

// ---------------------------------------------------------------------------
// departments
// ---------------------------------------------------------------------------

/**
 * Departamento de uma empresa. Organizado em árvore (parentId → self).
 */
export const departments = pgTable(
  'departments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    level: integer('level').notNull().default(0),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    deleted: boolean('deleted').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('departments_by_tenant').on(t.tenantId),
    index('departments_by_tenant_parent').on(t.tenantId, t.parentId),
  ],
);

// ---------------------------------------------------------------------------
// department_permissions
// ---------------------------------------------------------------------------

/**
 * Permissão de acesso de um usuário a um departamento.
 * Unique: (userId, departmentId).
 */
export const departmentPermissions = pgTable(
  'department_permissions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id),
    canRead: boolean('can_read').notNull().default(false),
    canWrite: boolean('can_write').notNull().default(false),
    deleted: boolean('deleted').notNull().default(false),
  },
  (t) => [
    unique('uniq_dept_perm_user_dept').on(t.userId, t.departmentId),
    index('dept_perm_by_user_tenant').on(t.userId, t.tenantId),
    index('dept_perm_by_department').on(t.departmentId),
  ],
);

// ---------------------------------------------------------------------------
// document_types
// ---------------------------------------------------------------------------

/**
 * Tipo de documento. Tipos globais têm tenantId NULL e isGlobal TRUE.
 * indexFields são armazenados em tabela separada (document_type_index_fields).
 * Unique: (tenantId, name).
 */
export const documentTypes = pgTable(
  'document_types',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    name: text('name').notNull(),
    description: text('description'),
    isGlobal: boolean('is_global').notNull().default(false),
    deleted: boolean('deleted').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique('uniq_doc_type_tenant_name').on(t.tenantId, t.name),
    index('doc_types_by_tenant').on(t.tenantId),
  ],
);

// ---------------------------------------------------------------------------
// document_type_index_fields
// ---------------------------------------------------------------------------

/**
 * Campo de índice de um tipo de documento.
 * Campo `order` renomeado para `sort_order` (palavra reservada em SQL).
 */
export const documentTypeIndexFields = pgTable(
  'document_type_index_fields',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    documentTypeId: uuid('document_type_id')
      .notNull()
      .references(() => documentTypes.id),
    name: text('name').notNull(),
    fieldType: text('field_type').notNull(), // 'TEXT' | 'DATE' | 'NUMBER'
    required: boolean('required').notNull().default(false),
    aiExtractionHint: text('ai_extraction_hint'),
    sortOrder: integer('sort_order').notNull().default(0),
    showOnSearch: boolean('show_on_search').notNull().default(true),
    deleted: boolean('deleted').notNull().default(false),
  },
  (t) => [index('idx_fields_by_doc_type').on(t.documentTypeId)],
);

// ---------------------------------------------------------------------------
// global_type_tenant_depts
// ---------------------------------------------------------------------------

/**
 * Configuração de departamentos visíveis para um tipo global em um tenant.
 * Unique: (globalTypeId, tenantId).
 */
export const globalTypeTenantDepts = pgTable(
  'global_type_tenant_depts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    globalTypeId: uuid('global_type_id')
      .notNull()
      .references(() => documentTypes.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    departmentIds: uuid('department_ids').array().notNull().default(sql`'{}'::uuid[]`),
    deleted: boolean('deleted').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique('uniq_global_type_tenant').on(t.globalTypeId, t.tenantId),
    index('global_type_depts_by_tenant').on(t.tenantId),
    index('global_type_depts_by_global_type').on(t.globalTypeId),
  ],
);

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------

/**
 * Documento. Entidade central do sistema.
 * Unique: (tenantId, contentHash) — deduplicação por SHA-256.
 * `indexValues` é mapa aberto: chaves = nomes dos campos do DocumentType.
 */
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id),
    documentTypeId: uuid('document_type_id').references(() => documentTypes.id),
    filename: text('filename').notNull(),
    originalFilename: text('original_filename').notNull(),
    contentHash: text('content_hash').notNull(), // SHA-256 hex, 64 chars
    sizeBytes: bigint('size_bytes', { mode: 'bigint' }).notNull(),
    mimeType: text('mime_type').notNull(),
    s3Key: text('s3_key').notNull(),
    status: text('status').notNull().default('PENDING'), // 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED'
    failureReason: text('failure_reason'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    indexValues: jsonb('index_values').notNull().default(sql`'{}'::jsonb`),
    uploadedById: uuid('uploaded_by_id')
      .notNull()
      .references(() => users.id),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    costUsdCents: integer('cost_usd_cents').notNull().default(0),
    deleted: boolean('deleted').notNull().default(false),
  },
  (t) => [
    uniqueIndex('uniq_doc_tenant_content_hash')
      .on(t.tenantId, t.contentHash)
      .where(sql`deleted = false`),
    index('docs_by_tenant_status').on(t.tenantId, t.status),
    index('docs_by_tenant_department').on(t.tenantId, t.departmentId),
    index('docs_by_tenant_deleted').on(t.tenantId, t.deleted),
  ],
);

// ---------------------------------------------------------------------------
// document_content
// ---------------------------------------------------------------------------

/**
 * Conteúdo extraído de um documento. Relação 1:1 com documents.
 * PK = documentId (sem coluna id separada).
 */
export const documentContent = pgTable('document_content', {
  documentId: uuid('document_id')
    .primaryKey()
    .references(() => documents.id),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  fullText: text('full_text').notNull(),
  extraction: jsonb('extraction').notNull(),
  indexSuggestion: jsonb('index_suggestion'),
  costBreakdown: jsonb('cost_breakdown'),
});

// ---------------------------------------------------------------------------
// chunks
// ---------------------------------------------------------------------------

/**
 * Chunk de texto de um documento com embedding vetorial (1536 dims).
 * Unique: (documentId, chunkIndex) — necessário para ON CONFLICT no worker.
 *
 * Coluna gerada text_search_pt (TSVECTOR) não pode ser modelada via Drizzle
 * schema — é criada via SQL raw na migration 0001_initial.sql.
 */
export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id),
    documentTypeName: text('document_type_name'),
    pageNumber: integer('page_number'),
    chunkIndex: integer('chunk_index').notNull(),
    text: text('text').notNull(),
    embedding: vector('embedding', 1536).notNull(),
    tokenCount: integer('token_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique('uniq_chunk_doc_index').on(t.documentId, t.chunkIndex),
    index('chunks_by_document').on(t.documentId),
    index('chunks_by_tenant').on(t.tenantId),
    index('chunks_by_tenant_department').on(t.tenantId, t.departmentId),
  ],
);

// ---------------------------------------------------------------------------
// document_events
// ---------------------------------------------------------------------------

/**
 * Evento de upload — registro IMUTÁVEL e APPEND-ONLY.
 * SEM coluna `deleted` — eventos nunca são soft-deletados.
 * pageCount nasce NULL e recebe backfill quando o worker conclui a extração.
 */
export const documentEvents = pgTable(
  'document_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    documentId: uuid('document_id').references(() => documents.id),
    // Nullable: ao purgar uma empresa excluída, o usuário é removido mas o
    // evento (append-only) é preservado com uploaded_by_id anulado.
    uploadedById: uuid('uploaded_by_id').references(() => users.id),
    eventType: text('event_type').notNull().default('upload'), // 'upload'
    mimeType: text('mime_type').notNull(),
    documentTypeId: uuid('document_type_id').references(() => documentTypes.id),
    documentTypeName: text('document_type_name'),
    sizeBytes: bigint('size_bytes', { mode: 'bigint' }).notNull(),
    pageCount: integer('page_count'),
    deduplicated: boolean('deduplicated').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('doc_events_by_tenant_created_at').on(t.tenantId, t.createdAt),
    index('doc_events_by_tenant_uploader_created_at').on(t.tenantId, t.uploadedById, t.createdAt),
    index('doc_events_by_document').on(t.documentId),
  ],
);

// ---------------------------------------------------------------------------
// department_templates
// ---------------------------------------------------------------------------

/**
 * Template de departamentos pré-definido. Unique: (name).
 * nodes é um array JSONB de TemplateNode (refId, parentRefId, name, tags).
 */
export const departmentTemplates = pgTable(
  'department_templates',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    description: text('description'),
    nodes: jsonb('nodes').notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [unique('uniq_dept_template_name').on(t.name)],
);

// ---------------------------------------------------------------------------
// audit_logs
// ---------------------------------------------------------------------------

/**
 * Registro de auditoria — append-only, imutável.
 * tenantId e userId podem ser NULL (ex.: login de SUPER_ADMIN).
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    userId: uuid('user_id').references(() => users.id),
    action: text('action').notNull(),
    resource: text('resource'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('audit_logs_by_tenant_created_at').on(t.tenantId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Re-exports para conveniência
// ---------------------------------------------------------------------------

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;

export type PlatformSettings = typeof platformSettings.$inferSelect;
export type NewPlatformSettings = typeof platformSettings.$inferInsert;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Department = typeof departments.$inferSelect;
export type NewDepartment = typeof departments.$inferInsert;

export type DepartmentPermission = typeof departmentPermissions.$inferSelect;
export type NewDepartmentPermission = typeof departmentPermissions.$inferInsert;

export type DocumentType = typeof documentTypes.$inferSelect;
export type NewDocumentType = typeof documentTypes.$inferInsert;

export type DocumentTypeIndexField = typeof documentTypeIndexFields.$inferSelect;
export type NewDocumentTypeIndexField = typeof documentTypeIndexFields.$inferInsert;

export type GlobalTypeTenantDept = typeof globalTypeTenantDepts.$inferSelect;
export type NewGlobalTypeTenantDept = typeof globalTypeTenantDepts.$inferInsert;

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;

export type DocumentContent = typeof documentContent.$inferSelect;
export type NewDocumentContent = typeof documentContent.$inferInsert;

export type Chunk = typeof chunks.$inferSelect;
export type NewChunk = typeof chunks.$inferInsert;

export type DocumentEvent = typeof documentEvents.$inferSelect;
export type NewDocumentEvent = typeof documentEvents.$inferInsert;

export type DepartmentTemplate = typeof departmentTemplates.$inferSelect;
export type NewDepartmentTemplate = typeof departmentTemplates.$inferInsert;

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
