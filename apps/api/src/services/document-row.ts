import type { TenantDocument } from '@dmdoc/db-pg';

/**
 * Linha de `documents` como o postgres.js entrega (snake_case) e o mapeamento
 * para o corpo de resposta da API. Compartilhado pelas rotas de documentos e
 * pela ingestão (`ingest-document.ts`), usada pelo upload simples e pelo
 * upload em partes — os dois devolvem exatamente o mesmo corpo.
 */

export interface DocumentRow extends TenantDocument {
  tenant_id: string; // postgres.js entrega snake_case; TenantDocument.tenantId é undefined em runtime
  department_id: string;
  document_type_id: string | null;
  filename: string;
  original_filename: string;
  original_path: string | null;
  title: string | null;
  suggested_title: string | null;
  content_hash: string;
  size_bytes: bigint;
  mime_type: string;
  storage_key: string;
  /**
   * Rótulo do destino onde o arquivo DESTA linha está: `s3` | `sharepoint`
   * (migration 0017). DENORMALIZAÇÃO — nunca é o critério de "de onde ler":
   * dois destinos diferentes do mesmo provider têm o mesmo valor aqui.
   */
  storage_provider: string;
  /**
   * A configuração de armazenamento de que ESTE arquivo depende para ser lido
   * (E-11 / ADR-1). É a AUTORIDADE do destino. `null` = S3 da plataforma.
   */
  storage_config_id: string | null;
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
 * Mapeia uma linha snake_case do PostgreSQL para o formato camelCase da resposta.
 */
export function rowToDocument(r: DocumentRow): Record<string, unknown> {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    departmentId: r.department_id,
    documentTypeId: r.document_type_id,
    filename: r.filename,
    originalFilename: r.original_filename,
    originalPath: r.original_path,
    title: r.title,
    suggestedTitle: r.suggested_title,
    contentHash: r.content_hash,
    sizeBytes: Number(r.size_bytes),
    mimeType: r.mime_type,
    storageKey: r.storage_key,
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
