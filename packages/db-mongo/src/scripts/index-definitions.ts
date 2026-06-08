import type { IndexSpecification, CreateIndexesOptions } from 'mongodb';

/**
 * Definição de um índice REGULAR de uma coleção.
 *
 * Cobre apenas os índices que o driver MongoDB sabe criar via `createIndex`.
 * Os índices de **Vector Search** e **Atlas Search** (spec §5.3, coleção
 * `chunks`) NÃO entram aqui — são criados na Fase 3 (entregável 25) via Atlas
 * Management API, pois o driver não os suporta.
 */
export interface RegularIndex {
  /** Chaves do índice (ex.: `{ tenantId: 1, email: 1 }`). */
  keys: IndexSpecification;
  /** Opções (`name`, `unique`, ...). `name` explícito mantém idempotência estável. */
  options: CreateIndexesOptions & { name: string };
}

/**
 * Mapa coleção → índices regulares, fiel à spec §5.3 e às invariantes §5.4.
 *
 * `createIndex` é idempotente: criar um índice já existente com a mesma
 * definição é no-op. Por isso os scripts podem ser repetidos sem efeito colateral.
 */
export const REGULAR_INDEXES: Readonly<Record<string, readonly RegularIndex[]>> = {
  users: [
    { keys: { tenantId: 1, email: 1 }, options: { name: 'uniq_tenant_email', unique: true } },
    { keys: { tenantId: 1 }, options: { name: 'by_tenant' } },
  ],
  departments: [
    { keys: { tenantId: 1 }, options: { name: 'by_tenant' } },
    { keys: { tenantId: 1, parentId: 1 }, options: { name: 'by_tenant_parent' } },
  ],
  department_permissions: [
    {
      keys: { userId: 1, departmentId: 1 },
      options: { name: 'uniq_user_department', unique: true },
    },
    { keys: { userId: 1, tenantId: 1 }, options: { name: 'by_user_tenant' } },
    { keys: { departmentId: 1 }, options: { name: 'by_department' } },
  ],
  document_types: [
    { keys: { tenantId: 1 }, options: { name: 'by_tenant' } },
    { keys: { tenantId: 1, name: 1 }, options: { name: 'uniq_tenant_name', unique: true } },
  ],
  documents: [
    {
      keys: { tenantId: 1, contentHash: 1 },
      options: { name: 'uniq_tenant_content_hash', unique: true },
    },
    { keys: { tenantId: 1, status: 1 }, options: { name: 'by_tenant_status' } },
    { keys: { tenantId: 1, departmentId: 1 }, options: { name: 'by_tenant_department' } },
    { keys: { tenantId: 1, deleted: 1 }, options: { name: 'by_tenant_deleted' } },
  ],
  document_content: [
    { keys: { documentId: 1 }, options: { name: 'uniq_document', unique: true } },
    { keys: { tenantId: 1 }, options: { name: 'by_tenant' } },
  ],
  chunks: [
    { keys: { documentId: 1 }, options: { name: 'by_document' } },
    { keys: { tenantId: 1 }, options: { name: 'by_tenant' } },
    { keys: { tenantId: 1, departmentId: 1 }, options: { name: 'by_tenant_department' } },
  ],
  audit_logs: [{ keys: { tenantId: 1, createdAt: -1 }, options: { name: 'by_tenant_created_at' } }],
} as const;
