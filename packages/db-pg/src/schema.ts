/**
 * Schema Drizzle para o DMDoc — PostgreSQL + pgvector.
 *
 * Tabelas (18 no total):
 *   tenants, platform_settings, users, departments, department_permissions,
 *   document_types, document_type_index_fields,
 *   global_type_tenant_depts, documents, document_content,
 *   chunks, document_events, department_templates,
 *   ai_reprocess_batch, document_reprocess_batch,
 *   tenant_storage_configs, storage_migrations, audit_logs
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
  unique,
  uniqueIndex,
  index,
  check,
  foreignKey,
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
  // 4ª feature de IA (Fase 9 / E-3): geração automática de tags por documento.
  // Mesmo esquema de dois níveis das anteriores — efetivo = plataforma AND empresa.
  aiTagGenerationEnabled: boolean('ai_tag_generation_enabled').notNull().default(true),
  // 5ª feature de IA: aplica automaticamente as tags sugeridas em `documents.tags`
  // (merge com dedupe case-insensitive, respeitando o teto de 60), sem exigir
  // confirmação manual do usuário. Mesmo esquema de dois níveis — efetivo =
  // plataforma AND empresa. Default ligado (decisão de produto).
  aiTagAutoApplyEnabled: boolean('ai_tag_auto_apply_enabled').notNull().default(true),
  // 6ª/7ª/8ª features de IA: aplicam automaticamente as sugestões de tipo,
  // título e índices em documents.document_type_id/title/index_values, sem
  // exigir confirmação manual do usuário. Mesmo esquema de dois níveis da
  // aiTagAutoApplyEnabled — efetivo = plataforma AND empresa. Default ligado.
  aiClassificationAutoApplyEnabled: boolean('ai_classification_auto_apply_enabled').notNull().default(true),
  aiTitleAutoApplyEnabled: boolean('ai_title_auto_apply_enabled').notNull().default(true),
  aiIndexAutoApplyEnabled: boolean('ai_index_auto_apply_enabled').notNull().default(true),
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
  // Kill switch global da 4ª feature de IA (Fase 9 / E-3): geração de tags.
  aiTagGenerationEnabled: boolean('ai_tag_generation_enabled').notNull().default(true),
  // Kill switch global da 5ª feature de IA: aplicação automática de tags sugeridas.
  aiTagAutoApplyEnabled: boolean('ai_tag_auto_apply_enabled').notNull().default(true),
  // Kill switch global da 6ª/7ª/8ª features de IA: aplicação automática de
  // tipo, título e índices sugeridos.
  aiClassificationAutoApplyEnabled: boolean('ai_classification_auto_apply_enabled').notNull().default(true),
  aiTitleAutoApplyEnabled: boolean('ai_title_auto_apply_enabled').notNull().default(true),
  aiIndexAutoApplyEnabled: boolean('ai_index_auto_apply_enabled').notNull().default(true),
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
 * Unique PARCIAL: (userId, departmentId) apenas para linhas ativas
 * (`deleted = false`) — soft-deletadas não competem pela unicidade,
 * permitindo o padrão soft-delete + reinserção sem colisão (ver migration
 * 0006_partial_unique_dept_perm).
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
    uniqueIndex('uniq_dept_perm_user_dept')
      .on(t.userId, t.departmentId)
      .where(sql`deleted = false`),
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
    // Sinais estruturados de reconhecimento por tipo (Fase 8, epic E-1) — usados
    // pelo prompt classify-document-type para desambiguar tipos parecidos
    // (ex.: Boleto × Fatura × Recibo). CONSULTIVOS: só reforçam a classificação.
    recognitionKeywords: text('recognition_keywords')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    recognitionRules: text('recognition_rules'),
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
 * `label` (T-15): rótulo amigável opcional digitado pelo admin — quando NULL,
 * o rótulo exibido é derivado do `name` (ver `deriveIndexFieldLabel` em
 * `apps/api/src/lib/index-fields.ts`).
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
    label: text('label'),
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
    // Path relativo do arquivo dentro da pasta enviada, capturado do
    // `webkitRelativePath` do browser no front (só existe quando o upload
    // veio de uma seleção/arrasto de PASTA, nunca em upload de arquivo
    // avulso). Nullable: upload avulso permanece null, nunca inventamos
    // valor. Consultivo/informativo — não participa de dedupe nem de
    // storageKey.
    originalPath: text('original_path'),
    // Título de exibição confirmado/editado pelo usuário (Fase 8.1). Nulo até a
    // confirmação; enquanto nulo, o fallback de exibição é `originalFilename`.
    title: text('title'),
    // Sugestão bruta de título gerada pela IA (Fase 8.1). Consultiva: nunca é
    // exibida como título oficial. Reprocessar sobrescreve; nunca toca `title`.
    suggestedTitle: text('suggested_title'),
    contentHash: text('content_hash').notNull(), // SHA-256 hex, 64 chars
    sizeBytes: bigint('size_bytes', { mode: 'bigint' }).notNull(),
    mimeType: text('mime_type').notNull(),
    // Chave/identificador do arquivo binário no destino de armazenamento
    // (épico E-11 — migration 0017). O nome antigo era específico de S3 e
    // passava a mentir assim que existisse um documento no SharePoint.
    // O formato da chave depende do provider.
    storageKey: text('storage_key').notNull(),
    // TIPO do destino onde o arquivo DESTA linha está: 's3' | 'sharepoint'. É
    // por documento, não por empresa, porque durante (e depois de) uma migração
    // de acervo a empresa tem documentos em destinos diferentes — o download
    // escolhe o driver por documento. Default 's3' cobre todo o acervo anterior
    // ao E-11. DENORMALIZAÇÃO de `storageConfigId`, mantida por ser barata em
    // `SELECT DISTINCT` e em tela; NUNCA é o critério de "precisa migrar":
    // dois destinos distintos do mesmo provider têm o mesmo valor aqui.
    storageProvider: text('storage_provider').notNull().default('s3'),
    // De QUAL configuração de armazenamento este arquivo depende para ser lido
    // (épico E-11 / ADR-1). É a AUTORIDADE; `storageProvider` é o rótulo.
    //
    // NULL ≡ S3 da plataforma, credenciais do .env — todo o acervo anterior ao
    // E-11 fica assim, sem backfill nenhum.
    //
    // ⚠️ Comparar esta coluna com uma configuração de destino é sempre
    // `IS DISTINCT FROM`, nunca `<>`: com NULL de um dos lados o `<>` devolve
    // NULL, o WHERE descarta a linha e a seleção da migração volta vazia.
    //
    // A FK real é COMPOSTA — (storage_config_id, tenant_id) →
    // tenant_storage_configs (id, tenant_id), criada na migration 0017 — para
    // que nenhum documento consiga apontar para a configuração de outra
    // empresa. Drizzle a declara em `foreignKey(...)` logo abaixo; não trocar
    // por `.references()` simples, que perderia a amarra de tenant.
    storageConfigId: uuid('storage_config_id'),
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
    // Ordenação default da listagem (`uploaded_at DESC`) e filtro por período
    // de upload (T-74) — ver migration 0015.
    index('docs_by_tenant_uploaded_at').on(t.tenantId, t.uploadedAt.desc()),
    // FK COMPOSTA (E-11 / ADR-1, migration 0017): o documento só pode apontar
    // para uma configuração de armazenamento DA PRÓPRIA empresa. Com FK simples
    // em `id`, um documento do tenant A poderia referenciar a config do tenant
    // B — e resolver esse driver seria ler o bucket de outra empresa com as
    // credenciais dela. MATCH SIMPLE (default): linha com `storageConfigId`
    // nulo (acervo na plataforma) não é verificada.
    foreignKey({
      name: 'documents_storage_config_fk',
      columns: [t.storageConfigId, t.tenantId],
      foreignColumns: [tenantStorageConfigs.id, tenantStorageConfigs.tenantId],
    }),
    // Coerência entre autoridade e denormalização: destino de plataforma
    // (`storageConfigId` nulo) é sempre S3.
    check(
      'documents_platform_storage_is_s3',
      sql`${t.storageConfigId} IS NOT NULL OR ${t.storageProvider} = 's3'`,
    ),
    // Seleção da migração de acervo (T-141) e varredura de destinos da purga
    // (T-142). `tenantId` na frente: toda consulta do sistema filtra tenant.
    index('docs_by_storage_config').on(t.tenantId, t.storageConfigId),
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
  typeSuggestion: jsonb('type_suggestion'),
  // Sugestão CONSULTIVA de tags por IA (Fase 9 / E-3). Nula até o pipeline de
  // geração rodar. { tags, model, promptVersion, generatedAt, rawResponse }.
  // NUNCA se confunde com `documents.tags` (tags confirmadas pelo usuário).
  suggestedTags: jsonb('suggested_tags'),
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
// ai_reprocess_batch
// ---------------------------------------------------------------------------

/**
 * Registro de um LOTE de reprocessamento de IA em massa (épico E-4 / T-24).
 *
 * Criado pela API (`POST /documents/bulk-reprocess-ai`) que enfileira UM job
 * de IA por documento; os contadores `done`/`failed` são incrementados
 * atomicamente pelo worker à medida que cada documento conclui. O lote é
 * escopado por `tenant_id` (isolamento multi-tenant — o status de um lote de
 * outra empresa nunca é legível).
 *
 * `status`: 'running' enquanto `done + failed < total`; 'completed' quando
 * `done + failed = total` (transição feita no mesmo UPDATE atômico do contador).
 * `steps`: as etapas de IA efetivamente enfileiradas (já filtradas pelas
 * feature flags do tenant na API).
 */
export const aiReprocessBatches = pgTable(
  'ai_reprocess_batch',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Ator que disparou o lote. Nullable para sobreviver à purga de usuário
    // (mesmo princípio append-only de document_events.uploaded_by_id).
    createdBy: uuid('created_by').references(() => users.id),
    total: integer('total').notNull(),
    done: integer('done').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    status: text('status').notNull().default('running'), // 'running' | 'completed'
    steps: text('steps').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('ai_reprocess_batch_by_tenant').on(t.tenantId)],
);

// ---------------------------------------------------------------------------
// document_reprocess_batch
// ---------------------------------------------------------------------------

/**
 * Registro de um LOTE de reprocessamento COMPLETO em massa (épico E-7) — o
 * pipeline integral (extração → embeddings → IA), não só as etapas de IA.
 *
 * NÃO TEM `done`/`failed`/`status`/`updated_at` DE PROPÓSITO — não adicione.
 * O progresso é DERIVADO em tempo de leitura agregando `documents.status` dos
 * ids em `documentIds` (ver `deriveDocumentReprocessBatchProgress` em
 * `document-reprocess-batch.ts`). O worker nunca escreve aqui: o payload de
 * `document-processing` é validado por um `z.object` que strippa chaves
 * desconhecidas (o `batchId` não sobreviveria), e a fila roda `attempts: 3`
 * com o pipeline re-lançando o erro — um contador contaria a mesma falha 3×.
 * O lote de IA (`aiReprocessBatches`) usa push apenas porque tem fila
 * dedicada com `attempts: 1`.
 *
 * `documentIds`: lista imutável dos ELEGÍVEIS enfileirados.
 * `total`: denominador estável (as linhas que sumirem de `documents` viram
 * `gone` na derivação e contam como falha, deixando o lote FECHAR).
 * `skipped`: selecionados pelo usuário que não eram elegíveis (não estavam em
 * FAILED) — informativo, fora da conta do progresso.
 */
export const documentReprocessBatches = pgTable(
  'document_reprocess_batch',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Ator que disparou o lote. Nullable para sobreviver à purga de usuário.
    createdBy: uuid('created_by').references(() => users.id),
    documentIds: uuid('document_ids').array().notNull(),
    total: integer('total').notNull(),
    skipped: integer('skipped').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('document_reprocess_batch_by_tenant').on(t.tenantId)],
);

// ---------------------------------------------------------------------------
// tenant_storage_configs
// ---------------------------------------------------------------------------

/**
 * Histórico VERSIONADO dos destinos de armazenamento de cada empresa
 * (épico E-11 / ADR-1, migration 0017).
 *
 * UMA LINHA POR CONFIGURAÇÃO, não por empresa. No máximo uma `active` por
 * tenant (índice único parcial `uniq_tenant_storage_active`); as demais são o
 * histórico e continuam sendo usadas para LER os documentos que ainda apontam
 * para elas. Sobrescrever a linha na troca de destino tornaria o acervo antigo
 * inalcançável no instante da troca — foi o que a ADR-1 corrigiu.
 *
 * `documents.storageConfigId IS NULL` ≡ ('s3', 'platform') — é essa
 * equivalência que faz todas as empresas existentes continuarem no bucket da
 * plataforma sem backfill nenhum. Nunca escreva uma linha aqui só para
 * "materializar o default".
 *
 * ⚠️ ESCRITA (T-140): linhas são IMUTÁVEIS nos campos de configuração. Trocar
 * o destino é INSERT da linha nova + `UPDATE ... SET active = false,
 * retiredAt = now()` na anterior — nunca UPDATE de `provider`/`config`/
 * `encryptedSecret`. `active` e `retiredAt` são as únicas colunas que mudam
 * depois do INSERT.
 *
 * `config` guarda a parte NÃO sensível (bucket, região, endpoint, siteId,
 * driveId...); o segredo vai cifrado em `encryptedSecret`. Ao gravar `config`
 * use `sql.json(...)` — `JSON.stringify` grava string double-encoded no
 * postgres.js e a leitura volta string.
 *
 * O CHECK `storage_platform_creds_only_s3` proíbe ('sharepoint', 'platform'):
 * não existe SharePoint da plataforma, o DMDoc não tem tenant Azure global.
 * Vale para toda linha, ativa ou aposentada.
 */
export const tenantStorageConfigs = pgTable(
  'tenant_storage_configs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    provider: text('provider').notNull(), // 's3' | 'sharepoint'
    // 'platform' = credenciais do .env da plataforma; 'tenant' = credenciais
    // da própria empresa. Default 'tenant' porque quem insere aqui está
    // justamente saindo do padrão — o caso 'platform' é o de documento sem
    // `storageConfigId`, que não tem linha nenhuma.
    credentialsSource: text('credentials_source').notNull().default('tenant'),
    config: jsonb('config').notNull().default(sql`'{}'::jsonb`),
    encryptedSecret: text('encrypted_secret'),
    // Destino CORRENTE da empresa (para onde vão os uploads novos).
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    // Quando esta configuração deixou de receber uploads. NULL na ativa.
    // Informativo (alimenta a lista de destinos anteriores da tela): nenhuma
    // decisão de leitura ou de purga depende dele.
    retiredAt: timestamp('retired_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    check(
      'storage_platform_creds_only_s3',
      sql`${t.credentialsSource} = 'tenant' OR ${t.provider} = 's3'`,
    ),
    // Alvo da FK COMPOSTA de `documents`: redundante como unicidade (`id` já é
    // PK), indispensável como referência — é o que permite amarrar o tenant
    // dentro da própria FK.
    unique('uniq_storage_config_id_tenant').on(t.id, t.tenantId),
    // No máximo UMA configuração ativa por empresa; as aposentadas ficam fora
    // do índice e convivem sem limite (mesmo padrão parcial de
    // `uniq_doc_tenant_content_hash` e `uniq_storage_migration_running`).
    uniqueIndex('uniq_tenant_storage_active').on(t.tenantId).where(sql`active`),
  ],
);

// ---------------------------------------------------------------------------
// storage_migrations
// ---------------------------------------------------------------------------

/**
 * Estado de uma migração de acervo entre destinos de armazenamento (E-11).
 *
 * Contadores PERSISTIDOS (modelo push, como `aiReprocessBatches`), ao
 * contrário de `documentReprocessBatches`, cujo progresso é derivado de
 * `documents.status`: aqui não há coluna em `documents` que distinga "já
 * copiado por ESTA migração" de "já nasceu no destino".
 *
 * `uniq_storage_migration_running` — índice único PARCIAL em `tenantId` sobre
 * PENDING/RUNNING: uma migração ativa por empresa. Migrações encerradas saem
 * do índice, então o histórico acumula sem bloquear a próxima.
 *
 * `fromProvider`/`toProvider` são DESCRITIVOS (rótulo em tela e no histórico).
 * O que determina quais documentos migrar é `documents.storageConfigId`
 * (`IS DISTINCT FROM` a config de destino), nunca estas duas colunas: numa
 * troca S3 → S3 elas são iguais e a seleção por provider devolveria zero.
 */
export const storageMigrations = pgTable(
  'storage_migrations',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    fromProvider: text('from_provider').notNull(),
    toProvider: text('to_provider').notNull(),
    // 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED'
    status: text('status').notNull().default('PENDING'),
    totalDocs: integer('total_docs').notNull().default(0),
    migratedDocs: integer('migrated_docs').notNull().default(0),
    failedDocs: integer('failed_docs').notNull().default(0),
    lastError: text('last_error'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('uniq_storage_migration_running')
      .on(t.tenantId)
      .where(sql`status IN ('PENDING', 'RUNNING')`),
  ],
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

export type AiReprocessBatch = typeof aiReprocessBatches.$inferSelect;
export type NewAiReprocessBatch = typeof aiReprocessBatches.$inferInsert;

export type TenantStorageConfig = typeof tenantStorageConfigs.$inferSelect;
export type NewTenantStorageConfig = typeof tenantStorageConfigs.$inferInsert;

export type StorageMigration = typeof storageMigrations.$inferSelect;
export type NewStorageMigration = typeof storageMigrations.$inferInsert;
