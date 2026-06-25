-- =============================================================================
-- DMDoc — Migration 0001: Schema inicial completo
-- =============================================================================
-- Cria as 13 tabelas do DMDoc com todos os índices regulares.
-- Extensões: pgcrypto (gen_random_uuid) + vector (pgvector 1536 dims).
-- Índices especiais:
--   HNSW em chunks.embedding       — busca vetorial por cosseno
--   GIN  em chunks.text_search_pt  — busca lexical fulltext em português
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Drizzle migration tracking
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS drizzle;
CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
    id         SERIAL PRIMARY KEY,
    hash       TEXT   NOT NULL,
    created_at BIGINT
);

-- ---------------------------------------------------------------------------
-- Extensões
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- ---------------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------------
-- SEM coluna deleted: tenants são desativados via active = false.

CREATE TABLE tenants (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT        NOT NULL,
    disk_quota_bytes BIGINT     NOT NULL,
    user_quota      INTEGER     NOT NULL,
    active          BOOLEAN     NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uniq_tenant_name UNIQUE (name)
);

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------

CREATE TABLE users (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID        REFERENCES tenants(id),
    email             TEXT        NOT NULL,
    password_hash     TEXT        NOT NULL,
    name              TEXT        NOT NULL,
    role              TEXT        NOT NULL,
    active            BOOLEAN     NOT NULL DEFAULT true,
    allowed_tenant_ids TEXT[],
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted           BOOLEAN     NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX uniq_users_tenant_email ON users (tenant_id, email);
-- Índice parcial para usuários sem tenant (SUPER_ADMIN, MULTI_TENANT_ADMIN):
-- NULL != NULL no Postgres, então o índice composto acima não impede duplicatas quando tenant_id IS NULL.
CREATE UNIQUE INDEX uniq_users_null_tenant_email ON users (email) WHERE tenant_id IS NULL;
CREATE INDEX users_by_tenant ON users (tenant_id);

-- ---------------------------------------------------------------------------
-- departments
-- ---------------------------------------------------------------------------

CREATE TABLE departments (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID        NOT NULL REFERENCES tenants(id),
    parent_id   UUID,
    name        TEXT        NOT NULL,
    level       INTEGER     NOT NULL DEFAULT 0,
    tags        TEXT[]      NOT NULL DEFAULT '{}',
    deleted     BOOLEAN     NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX departments_by_tenant ON departments (tenant_id);
CREATE INDEX departments_by_tenant_parent ON departments (tenant_id, parent_id);

-- FK self-referencing: parent_id → departments(id)
ALTER TABLE departments ADD CONSTRAINT fk_department_parent
    FOREIGN KEY (parent_id) REFERENCES departments(id);

-- ---------------------------------------------------------------------------
-- department_permissions
-- ---------------------------------------------------------------------------

CREATE TABLE department_permissions (
    id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID    NOT NULL REFERENCES tenants(id),
    user_id         UUID    NOT NULL REFERENCES users(id),
    department_id   UUID    NOT NULL REFERENCES departments(id),
    can_read        BOOLEAN NOT NULL DEFAULT false,
    can_write       BOOLEAN NOT NULL DEFAULT false,
    deleted         BOOLEAN NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX uniq_dept_perm_user_dept ON department_permissions (user_id, department_id);
CREATE INDEX dept_perm_by_user_tenant ON department_permissions (user_id, tenant_id);
CREATE INDEX dept_perm_by_department ON department_permissions (department_id);

-- ---------------------------------------------------------------------------
-- document_types
-- ---------------------------------------------------------------------------

CREATE TABLE document_types (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID        REFERENCES tenants(id),
    name           TEXT        NOT NULL,
    description    TEXT,
    is_global      BOOLEAN     NOT NULL DEFAULT false,
    deleted        BOOLEAN     NOT NULL DEFAULT false,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Campos de índice embutidos como JSONB (array de IndexField)
    index_fields   JSONB       NOT NULL DEFAULT '[]',
    -- Departamentos aos quais o tipo pertence (para tipos de tenant; NULL para globais)
    department_ids UUID[]      DEFAULT NULL
);

CREATE UNIQUE INDEX uniq_doc_type_tenant_name   ON document_types (tenant_id, name);
-- Tipos globais (tenant_id IS NULL): unicidade só por nome
CREATE UNIQUE INDEX uniq_doc_type_global_name   ON document_types (name) WHERE tenant_id IS NULL;
CREATE INDEX doc_types_by_tenant ON document_types (tenant_id);

-- ---------------------------------------------------------------------------
-- document_type_index_fields
-- ---------------------------------------------------------------------------
-- Campo `order` renomeado para `sort_order` (palavra reservada em SQL).

CREATE TABLE document_type_index_fields (
    id                  UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    document_type_id    UUID    NOT NULL REFERENCES document_types(id),
    name                TEXT    NOT NULL,
    field_type          TEXT    NOT NULL,   -- 'TEXT' | 'DATE' | 'NUMBER'
    required            BOOLEAN NOT NULL DEFAULT false,
    ai_extraction_hint  TEXT,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    show_on_search      BOOLEAN NOT NULL DEFAULT true,
    deleted             BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_fields_by_doc_type ON document_type_index_fields (document_type_id);
CREATE UNIQUE INDEX uniq_index_field_type_name ON document_type_index_fields (document_type_id, name);

-- ---------------------------------------------------------------------------
-- global_type_tenant_depts
-- ---------------------------------------------------------------------------

CREATE TABLE global_type_tenant_depts (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    global_type_id  UUID        NOT NULL REFERENCES document_types(id),
    tenant_id       UUID        NOT NULL REFERENCES tenants(id),
    department_ids  UUID[]      NOT NULL DEFAULT '{}',
    deleted         BOOLEAN     NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uniq_global_type_tenant ON global_type_tenant_depts (global_type_id, tenant_id);
CREATE INDEX global_type_depts_by_tenant ON global_type_tenant_depts (tenant_id);
CREATE INDEX global_type_depts_by_global_type ON global_type_tenant_depts (global_type_id);

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------

CREATE TABLE documents (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID        NOT NULL REFERENCES tenants(id),
    department_id       UUID        NOT NULL REFERENCES departments(id),
    document_type_id    UUID        REFERENCES document_types(id),
    filename            TEXT        NOT NULL,
    original_filename   TEXT        NOT NULL,
    content_hash        TEXT        NOT NULL,           -- SHA-256 hex, 64 chars
    size_bytes          BIGINT      NOT NULL,
    mime_type           TEXT        NOT NULL,
    s3_key              TEXT        NOT NULL,
    status              TEXT        NOT NULL DEFAULT 'PENDING', -- 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED'
    failure_reason      TEXT,
    tags                TEXT[]      NOT NULL DEFAULT '{}',
    index_values        JSONB       NOT NULL DEFAULT '{}',
    uploaded_by_id      UUID        NOT NULL REFERENCES users(id),
    uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at        TIMESTAMPTZ,
    cost_usd_cents      INTEGER     NOT NULL DEFAULT 0,
    deleted             BOOLEAN     NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX uniq_doc_tenant_content_hash ON documents (tenant_id, content_hash);
CREATE INDEX docs_by_tenant_status ON documents (tenant_id, status);
CREATE INDEX docs_by_tenant_department ON documents (tenant_id, department_id);
CREATE INDEX docs_by_tenant_deleted ON documents (tenant_id, deleted);

-- ---------------------------------------------------------------------------
-- document_content
-- ---------------------------------------------------------------------------
-- Relação 1:1 com documents. PK = document_id.

CREATE TABLE document_content (
    document_id         UUID    PRIMARY KEY REFERENCES documents(id),
    tenant_id           UUID    NOT NULL REFERENCES tenants(id),
    full_text           TEXT    NOT NULL,
    extraction          JSONB   NOT NULL,       -- ExtractionResult
    index_suggestion    JSONB,                  -- IndexSuggestion | null
    cost_breakdown      JSONB                   -- CostBreakdown | null
);

CREATE INDEX doc_content_by_tenant ON document_content (tenant_id);

-- ---------------------------------------------------------------------------
-- chunks
-- ---------------------------------------------------------------------------

CREATE TABLE chunks (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id         UUID        NOT NULL REFERENCES documents(id),
    tenant_id           UUID        NOT NULL REFERENCES tenants(id),
    department_id       UUID        NOT NULL REFERENCES departments(id),
    document_type_name  TEXT,
    page_number         INTEGER,
    chunk_index         INTEGER     NOT NULL,
    text                TEXT        NOT NULL,
    embedding           vector(1536) NOT NULL,
    token_count         INTEGER     NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uniq_chunk_doc_index ON chunks (document_id, chunk_index);
CREATE INDEX chunks_by_document ON chunks (document_id);
CREATE INDEX chunks_by_tenant ON chunks (tenant_id);
CREATE INDEX chunks_by_tenant_department ON chunks (tenant_id, department_id);

-- Coluna gerada para busca lexical em português (tsvector).
-- NÃO pode ser modelada pelo Drizzle schema — criada via SQL raw.
ALTER TABLE chunks ADD COLUMN text_search_pt TSVECTOR
    GENERATED ALWAYS AS (to_tsvector('portuguese', text)) STORED;

-- Índice GIN para busca lexical fulltext
CREATE INDEX chunks_text_search_pt_gin ON chunks USING gin(text_search_pt);

-- Índice HNSW para busca vetorial por cosseno (pgvector)
CREATE INDEX chunks_embedding_hnsw ON chunks
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- ---------------------------------------------------------------------------
-- document_events
-- ---------------------------------------------------------------------------
-- Append-only / imutável. SEM coluna deleted.

CREATE TABLE document_events (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID        NOT NULL REFERENCES tenants(id),
    document_id         UUID        REFERENCES documents(id),
    uploaded_by_id      UUID        NOT NULL REFERENCES users(id),
    event_type          TEXT        NOT NULL DEFAULT 'upload',
    mime_type           TEXT        NOT NULL,
    document_type_id    UUID        REFERENCES document_types(id),
    document_type_name  TEXT,
    size_bytes          BIGINT      NOT NULL,
    page_count          INTEGER,
    deduplicated        BOOLEAN     NOT NULL DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX doc_events_by_tenant_created_at ON document_events (tenant_id, created_at DESC);
CREATE INDEX doc_events_by_tenant_uploader_created_at ON document_events (tenant_id, uploaded_by_id, created_at DESC);
CREATE INDEX doc_events_by_document ON document_events (document_id);

-- ---------------------------------------------------------------------------
-- department_templates
-- ---------------------------------------------------------------------------

CREATE TABLE department_templates (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL,
    description TEXT,
    nodes       JSONB       NOT NULL DEFAULT '[]',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uniq_dept_template_name ON department_templates (name);

-- ---------------------------------------------------------------------------
-- audit_logs
-- ---------------------------------------------------------------------------
-- Append-only / imutável. tenantId e userId podem ser NULL.

CREATE TABLE audit_logs (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID        REFERENCES tenants(id),
    user_id     UUID        REFERENCES users(id),
    action      TEXT        NOT NULL,
    resource    TEXT,
    metadata    JSONB       NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_by_tenant_created_at ON audit_logs (tenant_id, created_at DESC);
