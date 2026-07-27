import type { Sql } from 'postgres';

/**
 * Helpers de leitura/escrita do LOTE de reprocessamento COMPLETO em massa
 * (épico E-7) — o pipeline integral (extração → embeddings → IA), não apenas
 * as etapas de IA do `ai-reprocess-batch.ts`. Toda operação é escopada por
 * `tenantId` (isolamento multi-tenant inegociável).
 *
 * NÃO EXISTE FUNÇÃO DE INCREMENTO AQUI, E ISSO É DELIBERADO. O progresso é
 * DERIVADO em tempo de leitura, agregando `documents.status` dos ids gravados
 * no lote (ver `deriveDocumentReprocessBatchProgress`). Motivos:
 *
 *  1. O payload de `document-processing` é validado por um `z.object`
 *     (`DocumentProcessingJobDataSchema`), que STRIPPA chaves desconhecidas —
 *     um `batchId` enfiado no job sumiria silenciosamente antes do worker.
 *  2. A fila roda com `attempts: 3` e o pipeline grava `FAILED` e RE-LANÇA o
 *     erro — um contador de push contaria a MESMA falha até 3 vezes.
 *
 * O lote de IA (E-4) só pôde usar push porque ganhou uma fila dedicada com
 * `attempts: 1`. Se bater a vontade de escrever um `increment...` aqui, o
 * modelo foi mal entendido: mexa na derivação, não na tabela.
 *
 * Ver `schema.ts` (`documentReprocessBatches`) e a migration
 * `0016_document_reprocess_batch.sql`.
 */

/** Status do lote — sempre DERIVADO, nunca persistido. */
export type DocumentReprocessBatchStatus = 'running' | 'completed';

/** Registro de lote já mapeado para camelCase (formato de leitura da API). */
export interface DocumentReprocessBatchRecord {
  id: string;
  tenantId: string;
  createdBy: string | null;
  documentIds: string[];
  total: number;
  skipped: number;
  createdAt: Date;
}

/** Linha crua (snake_case) devolvida pelo postgres.js. */
interface DocumentReprocessBatchRow {
  id: string;
  tenant_id: string;
  created_by: string | null;
  document_ids: string[];
  total: number;
  skipped: number;
  created_at: Date;
}

function mapRow(row: DocumentReprocessBatchRow): DocumentReprocessBatchRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    createdBy: row.created_by,
    documentIds: row.document_ids,
    total: row.total,
    skipped: row.skipped,
    createdAt: row.created_at,
  };
}

export interface CreateDocumentReprocessBatchParams {
  tenantId: string;
  createdBy: string;
  /** Ids dos documentos ELEGÍVEIS efetivamente enfileirados (lista imutável). */
  documentIds: string[];
  /** Denominador estável do progresso (normalmente `documentIds.length`). */
  total: number;
  /** Selecionados que não eram elegíveis (não estavam em FAILED). */
  skipped: number;
}

/**
 * Cria o registro de lote e devolve o registro completo (inclui o `id` gerado,
 * necessário para a rota responder o `batchId` de acompanhamento).
 *
 * `documentIds` vai com cast explícito `::uuid[]`: postgres.js serializa um
 * array de strings como `text[]`, e o Postgres NÃO converte implicitamente
 * `text[]` para a coluna `uuid[]` (erro "column ... is of type uuid[]").
 */
export async function createDocumentReprocessBatch(
  sql: Sql,
  params: CreateDocumentReprocessBatchParams,
): Promise<DocumentReprocessBatchRecord> {
  const rows = await sql<DocumentReprocessBatchRow[]>`
    INSERT INTO document_reprocess_batch (tenant_id, created_by, document_ids, total, skipped)
    VALUES (
      ${params.tenantId},
      ${params.createdBy},
      ${params.documentIds}::uuid[],
      ${params.total},
      ${params.skipped}
    )
    RETURNING *
  `;
  return mapRow(rows[0]!);
}

/**
 * Lê um lote ESCOPADO ao tenant informado. Retorna `null` quando o lote não
 * existe OU pertence a outra empresa — a rota HTTP mapeia `null` para 404
 * (nunca 403: não vaza a existência de lote de outro tenant).
 */
export async function getDocumentReprocessBatch(
  sql: Sql,
  tenantId: string,
  batchId: string,
): Promise<DocumentReprocessBatchRecord | null> {
  const rows = await sql<DocumentReprocessBatchRow[]>`
    SELECT *
    FROM document_reprocess_batch
    WHERE id = ${batchId}
      AND tenant_id = ${tenantId}
    LIMIT 1
  `;
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Lê um lote SEM restrição de tenant (SUPER_ADMIN, que tem acesso cross-tenant
 * nativo). Retorna `null` se o lote não existir.
 */
export async function getDocumentReprocessBatchGlobal(
  sql: Sql,
  batchId: string,
): Promise<DocumentReprocessBatchRecord | null> {
  const rows = await sql<DocumentReprocessBatchRow[]>`
    SELECT *
    FROM document_reprocess_batch
    WHERE id = ${batchId}
    LIMIT 1
  `;
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Lê um lote restrito a uma lista de tenants permitidos (MULTI_TENANT_ADMIN).
 * Retorna `null` se não existir ou se o tenant do lote não estiver na lista.
 * Lista vazia curto-circuita em `null` sem consultar o banco (um MTA sem
 * empresas atribuídas não enxerga lote nenhum).
 */
export async function getDocumentReprocessBatchInTenants(
  sql: Sql,
  allowedTenantIds: string[],
  batchId: string,
): Promise<DocumentReprocessBatchRecord | null> {
  if (allowedTenantIds.length === 0) return null;
  const rows = await sql<DocumentReprocessBatchRow[]>`
    SELECT *
    FROM document_reprocess_batch
    WHERE id = ${batchId}
      AND tenant_id = ANY(${allowedTenantIds}::uuid[])
    LIMIT 1
  `;
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/** Progresso derivado de um lote (nada disso é persistido). */
export interface DocumentReprocessBatchProgress {
  total: number;
  done: number;
  failed: number;
  pending: number;
  status: DocumentReprocessBatchStatus;
  /**
   * Ainda há pendências 30 min depois do disparo — sinal de worker parado. A
   * UI usa para avisar o usuário e PARAR o polling; não fecha o lote sozinho.
   */
  stalled: boolean;
}

/** Janela após a qual um lote com pendências vivas é considerado travado. */
const STALLED_AFTER_MS = 30 * 60 * 1000;

/**
 * DERIVA o progresso do lote a partir do estado atual de `documents` — uma
 * única query agregada, sem contador persistido em lugar nenhum.
 *
 * Mapeamento:
 *   done    = READY
 *   pending = PENDING + PROCESSING
 *   failed  = FAILED + gone   (gone = total - Σ das linhas encontradas)
 *
 * `gone` são documentos que sumiram fisicamente de `documents` depois do
 * disparo (purga). Sem contá-los como falha, o lote ficaria preso em
 * `running` para sempre — nenhum status jamais chegaria por eles.
 *
 * NÃO FILTRA `deleted = false` DE PROPÓSITO: um documento soft-deleted ainda
 * tem status real (o pipeline continua e chega a READY/FAILED), e escondê-lo
 * o transformaria falsamente em `gone`. Só a ausência REAL da linha vira
 * `gone`. Não adicione o filtro "por consistência com as outras queries".
 *
 * Nem `gone` nem `stalled` forjam um `completed` falso: o status só fecha
 * quando `pending` chega a zero de fato.
 *
 * `count(*)` volta como string no postgres.js — daí o `::int` no SELECT.
 */
export async function deriveDocumentReprocessBatchProgress(
  sql: Sql,
  batch: DocumentReprocessBatchRecord,
): Promise<DocumentReprocessBatchProgress> {
  const rows = await sql<{ status: string; n: number }[]>`
    SELECT status, count(*)::int AS n
    FROM documents
    WHERE id = ANY(${batch.documentIds}::uuid[])
      AND tenant_id = ${batch.tenantId}
    GROUP BY status
  `;

  let done = 0;
  let failed = 0;
  let pending = 0;
  let found = 0;
  for (const row of rows) {
    const n = Number(row.n);
    found += n;
    if (row.status === 'READY') done += n;
    else if (row.status === 'FAILED') failed += n;
    else if (row.status === 'PENDING' || row.status === 'PROCESSING') pending += n;
  }

  // Documentos que não existem mais (purga) contam como falha — é o que
  // permite o lote fechar em vez de travar em `running`.
  const gone = Math.max(0, batch.total - found);
  failed += gone;

  const status: DocumentReprocessBatchStatus = pending === 0 ? 'completed' : 'running';
  const stalled = pending > 0 && Date.now() - batch.createdAt.getTime() > STALLED_AFTER_MS;

  return { total: batch.total, done, failed, pending, status, stalled };
}
