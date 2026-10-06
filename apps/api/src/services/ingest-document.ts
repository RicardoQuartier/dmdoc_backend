import type { FastifyBaseLogger } from 'fastify';
import type { Queue } from 'bullmq';
import {
  TenantRepository,
  DocumentEventsRepository,
  newId,
  type Sql,
  type CreateDocumentEventPgInput,
} from '@dmdoc/db-pg';
import {
  DocumentProcessingJobDataSchema,
  type DocumentProcessingJobData,
} from '@dmdoc/shared-types';
import type { StorageDriver, StorageResolver } from '@dmdoc/storage';
import { NotFoundError, QuotaExceededError, ConflictError } from '../errors/index.js';
import { assertCanWriteDepartment } from '../auth/department-access.js';
import { AuditLogger } from '../auth/audit.js';
import type { DocumentRow } from './document-row.js';

/**
 * Ingestão de documento — o pipeline que TODO upload aceito percorre
 * (épico E-16 / ADR 0004), usado pelo upload simples (`POST /documents`) e pela
 * conclusão do upload em partes (`document-uploads.ts`):
 *
 *   cota de disco → deduplicação (com exceção FAILED) → tipo de documento →
 *   gravação no storage → insert PENDING → fila → audit log → evento de upload.
 *
 * Quem chama entrega o conteúdo JÁ MEDIDO (`contentHash` e `sizeBytes`
 * calculados por ele) e a origem dos bytes: um `Buffer` (upload simples) ou um
 * arquivo em disco (upload em partes, enviado por stream com `putFile`).
 *
 * Regras que não podem ser reabertas aqui (wiki "Cotas de disco…",
 * "Deduplicação de documentos por conteúdo", "Histórico de eventos de upload…"):
 * - cota recusada → 422 `QUOTA_EXCEEDED`, sem objeto no storage e sem evento;
 * - dedup por `(tenantId, contentHash)`, departamento do reenvio ignorado;
 * - corrida de dedup (23505) → 409;
 * - todo upload aceito gera exatamente um evento, o deduplicado inclusive.
 */

/** Origem dos bytes do documento. */
export type IngestContent =
  | { kind: 'buffer'; buffer: Buffer }
  | { kind: 'file'; path: string };

export interface IngestDocumentParams {
  sql: Sql;
  storage: StorageResolver;
  /** Fila de processamento; `null` em testes (job não enfileirado). */
  queue: Queue | null;
  /** Logger da requisição (já carrega `traceId`). */
  log: FastifyBaseLogger;
  tenantId: string;
  userId: string;
  departmentId: string;
  documentTypeId: string | undefined;
  indexValues: Record<string, string | number | null>;
  /** `webkitRelativePath` do upload de pasta; `null` em arquivo avulso. */
  originalPath: string | null;
  originalFilename: string;
  mimeType: string;
  /** SHA-256 hex (64 chars) do conteúdo, calculado por quem chama. */
  contentHash: string;
  sizeBytes: number;
  content: IngestContent;
}

export interface IngestDocumentResult {
  document: DocumentRow;
  /** `true` quando o conteúdo já existia na empresa (header `X-Deduplicated`). */
  deduplicated: boolean;
}

interface TenantRow {
  id: string;
  name: string;
  disk_quota_bytes: bigint;
  user_quota: number;
  active: boolean;
  created_at: Date;
}

/**
 * Sanitiza o nome original do arquivo para uso seguro como chave de armazenamento.
 * Remove caracteres especiais e preserva a extensão.
 */
export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}


/**
 * Resolve o `name` de um tipo de documento (tenant OU global) para denormalizar
 * no evento de upload.
 */
export async function resolveDocumentTypeName(
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

/**
 * Verifica a permissão de ESCRITA do usuário no departamento e que ele está
 * ativo (não soft-deletado). Lança 404 em qualquer recusa (nunca 403).
 */
export async function assertCanUploadToDepartment(
  sql: Sql,
  userId: string,
  tenantId: string,
  departmentId: string,
  role: string
): Promise<void> {
  await assertCanWriteDepartment(sql, userId, tenantId, departmentId, role);

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
}

/**
 * Cota de disco da empresa: `uso atual + tamanho > cota` → 422
 * `QUOTA_EXCEEDED`. Uso = soma de `size_bytes` dos documentos não excluídos.
 */
export async function assertDiskQuota(sql: Sql, tenantId: string, sizeBytes: number): Promise<void> {
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

  if (currentUsageBytes + BigInt(sizeBytes) > tenant.disk_quota_bytes) {
    throw new QuotaExceededError(
      `Cota de disco esgotada: uso atual ${currentUsageBytes} bytes, ` +
        `arquivo ${sizeBytes} bytes, limite ${tenant.disk_quota_bytes} bytes`
    );
  }
}

/**
 * Tipo de documento informado precisa existir (não excluído) na empresa ou ser
 * global. Ausente (`undefined`) é aceito. Lança 404.
 */
export async function assertDocumentTypeAvailable(
  sql: Sql,
  tenantId: string,
  documentTypeId: string | undefined
): Promise<void> {
  if (documentTypeId === undefined) return;

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

/** Grava o conteúdo no destino pelo caminho certo para a origem dos bytes. */
async function writeContent(
  driver: StorageDriver,
  key: string,
  content: IngestContent,
  sizeBytes: number,
  mimeType: string
): Promise<void> {
  if (content.kind === 'buffer') {
    await driver.put({ key, buffer: content.buffer, mimeType });
    return;
  }
  await driver.putFile({ key, path: content.path, sizeBytes, mimeType });
}

/**
 * Executa a ingestão a partir da cota (a permissão no departamento é checada
 * antes, por quem chama, com `assertCanUploadToDepartment`).
 */
export async function ingestDocument(params: IngestDocumentParams): Promise<IngestDocumentResult> {
  const {
    sql,
    log,
    tenantId,
    userId,
    departmentId,
    documentTypeId,
    indexValues,
    originalFilename,
    mimeType,
    contentHash,
  } = params;
  const fileSize = params.sizeBytes;
  const filename = sanitizeFilename(originalFilename);

  // ------------------------------------------------------------------
  // 1. Verificar cota de disco do tenant
  // ------------------------------------------------------------------
  await assertDiskQuota(sql, tenantId, fileSize);

  // ------------------------------------------------------------------
  // 2. Deduplicação
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
    await emitUploadEvent(sql, log, tenantId, {
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

    log.info(
      { tenantId, userId, documentId: existingDoc.id, contentHash },
      'documento deduplicado — retornando existente'
    );
    return { document: existingDoc, deduplicated: true };
  }

  // ------------------------------------------------------------------
  // 3. Validar documentTypeId (se informado)
  // ------------------------------------------------------------------
  await assertDocumentTypeAvailable(sql, tenantId, documentTypeId);

  // ------------------------------------------------------------------
  // 4. Upload para o armazenamento
  // ------------------------------------------------------------------
  const storageKey = `tenants/${tenantId}/documents/${contentHash}/${filename}`;
  // Destino ATIVO da EMPRESA (bucket da plataforma, bucket próprio ou
  // SharePoint). É o único ponto do arquivo em que resolver pela empresa está
  // certo: arquivo NOVO vai para onde a empresa grava HOJE. Toda leitura
  // posterior usa o `storage_config_id` gravado logo abaixo.
  const { driver: storageDriver, storageConfigId } =
    await params.storage.activeDestination(tenantId);
  await writeContent(storageDriver, storageKey, params.content, fileSize, mimeType);

  // ------------------------------------------------------------------
  // 5. Persistir documento no PostgreSQL com status PENDING
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
    // Nunca inventado: só vem preenchido quando o front captura
    // `webkitRelativePath` de upload de pasta; ausência vira `null`.
    original_path: params.originalPath,
    title: null,
    suggested_title: null,
    content_hash: contentHash,
    size_bytes: BigInt(fileSize),
    mime_type: mimeType,
    storage_key: storageKey,
    // ONDE o arquivo ficou, por documento. Durante (e depois de) uma migração
    // de acervo a empresa tem arquivos em destinos diferentes ao mesmo tempo,
    // então quem lê precisa saber o destino DESTE arquivo — não o destino
    // corrente da empresa (ver migration 0017).
    //
    // As duas colunas juntas, sempre: `storage_config_id` é a AUTORIDADE (a
    // configuração cujas credenciais abrem este arquivo, `null` = plataforma)
    // e `storage_provider` é o rótulo denormalizado dela. Gravar só o provider
    // deixaria um documento em bucket próprio registrado como plataforma — o
    // ponteiro errado que a ADR-1 corrigiu.
    storage_provider: storageDriver.provider,
    storage_config_id: storageConfigId,
    status: 'PENDING',
    failure_reason: null,
    tags: [],
    index_values: indexValues,
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
      // NÃO remover o objeto do armazenamento aqui: a chave é derivada de
      // (contentHash, filename) e, quando o vencedor subiu o mesmo arquivo
      // com o mesmo nome, é a MESMA chave — apagá-la corromperia o documento
      // vencedor. O conteúdo já está armazenado (upload idempotente). Um eventual
      // objeto órfão (nomes de arquivo diferentes) é custo aceitável nesta
      // corrida rara, preferível a arriscar apagar o arquivo do vencedor.
      log.info(
        { tenantId, userId, contentHash },
        'colisão de deduplicação por corrida — perdedor tratado como 409'
      );
      throw new ConflictError('Conteúdo já existe nesta empresa (conflito de deduplicação por corrida)');
    }

    // Rollback: remove arquivo do armazenamento (erro de insert não relacionado à corrida).
    try {
      await storageDriver.delete(storageKey);
    } catch (deleteError) {
      log.error(
        { err: deleteError, storageKey, tenantId, userId },
        'falha ao remover arquivo do armazenamento no rollback'
      );
    }
    throw insertError;
  }

  // ------------------------------------------------------------------
  // 6. Enfileirar job BullMQ
  // ------------------------------------------------------------------
  const jobData: DocumentProcessingJobData = DocumentProcessingJobDataSchema.parse({
    tenantId,
    documentId: document.id,
    storageKey,
    mimeType,
  });

  if (params.queue !== null) {
    await params.queue.add('process-document', jobData, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });
  } else {
    log.warn(
      { tenantId, documentId: document.id },
      'queue não configurada — job de processamento não enfileirado'
    );
  }

  // ------------------------------------------------------------------
  // 7. AuditLog
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
    log.error(
      { err: auditError, tenantId, userId, documentId: document.id },
      'falha ao registrar audit log de upload'
    );
  }

  // ------------------------------------------------------------------
  // 8. Evento de upload
  // ------------------------------------------------------------------
  const documentTypeName = await resolveDocumentTypeName(
    sql,
    tenantId,
    documentTypeId ?? null
  );
  await emitUploadEvent(sql, log, tenantId, {
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

  log.info(
    { tenantId, userId, documentId: document.id, sizeBytes: fileSize, contentHash },
    'documento enviado com sucesso'
  );

  return { document, deduplicated: false };
}
