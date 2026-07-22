import type { Sql } from 'postgres';

/**
 * Helpers de leitura/escrita do LOTE de reprocessamento de IA em massa
 * (épico E-4 / T-24), compartilhados entre API (cria o lote + lê status) e
 * worker (incrementa contadores). Toda operação é escopada por `tenantId`
 * (isolamento multi-tenant inegociável).
 *
 * Ver `schema.ts` (`aiReprocessBatches`) e a migration `0011_ai_reprocess_batch.sql`.
 */

/** Etapas de IA de um lote (subconjunto de {title, indexes, tags}). */
export type AiReprocessBatchStep = 'title' | 'indexes' | 'tags';

/** Status do lote. */
export type AiReprocessBatchStatus = 'running' | 'completed';

/** Registro de lote já mapeado para camelCase (formato de leitura da API). */
export interface AiReprocessBatchRecord {
  id: string;
  tenantId: string;
  createdBy: string | null;
  total: number;
  done: number;
  failed: number;
  status: AiReprocessBatchStatus;
  steps: AiReprocessBatchStep[];
  createdAt: Date;
  updatedAt: Date;
}

/** Linha crua (snake_case) devolvida pelo postgres.js. */
interface AiReprocessBatchRow {
  id: string;
  tenant_id: string;
  created_by: string | null;
  total: number;
  done: number;
  failed: number;
  status: AiReprocessBatchStatus;
  steps: AiReprocessBatchStep[];
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: AiReprocessBatchRow): AiReprocessBatchRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    createdBy: row.created_by,
    total: row.total,
    done: row.done,
    failed: row.failed,
    status: row.status,
    steps: row.steps,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateAiReprocessBatchParams {
  tenantId: string;
  createdBy: string;
  total: number;
  steps: AiReprocessBatchStep[];
}

/**
 * Cria o registro de lote (status inicial `running`, `done = failed = 0`) e
 * devolve o registro completo (inclui o `id` gerado para enfileirar os jobs).
 *
 * `steps` é um array de texto (coluna `text[]`) — passado direto como parâmetro
 * (postgres.js serializa arrays nativos; NÃO usar `sql.json`, a coluna não é jsonb).
 */
export async function createAiReprocessBatch(
  sql: Sql,
  params: CreateAiReprocessBatchParams,
): Promise<AiReprocessBatchRecord> {
  const rows = await sql<AiReprocessBatchRow[]>`
    INSERT INTO ai_reprocess_batch (tenant_id, created_by, total, steps)
    VALUES (
      ${params.tenantId},
      ${params.createdBy},
      ${params.total},
      ${params.steps}
    )
    RETURNING *
  `;
  return mapRow(rows[0]!);
}

/**
 * Lê o status de um lote ESCOPADO ao tenant informado. Retorna `null` quando o
 * lote não existe OU pertence a outra empresa — a rota HTTP mapeia `null` para
 * 404 (nunca 403 — não vaza a existência de lote de outro tenant).
 */
export async function getAiReprocessBatch(
  sql: Sql,
  tenantId: string,
  batchId: string,
): Promise<AiReprocessBatchRecord | null> {
  const rows = await sql<AiReprocessBatchRow[]>`
    SELECT *
    FROM ai_reprocess_batch
    WHERE id = ${batchId}
      AND tenant_id = ${tenantId}
    LIMIT 1
  `;
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Lê o status de um lote SEM restrição de tenant (SUPER_ADMIN, que tem acesso
 * cross-tenant nativo). Retorna `null` se o lote não existir.
 */
export async function getAiReprocessBatchGlobal(
  sql: Sql,
  batchId: string,
): Promise<AiReprocessBatchRecord | null> {
  const rows = await sql<AiReprocessBatchRow[]>`
    SELECT *
    FROM ai_reprocess_batch
    WHERE id = ${batchId}
    LIMIT 1
  `;
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Lê o status de um lote restrito a uma lista de tenants permitidos
 * (MULTI_TENANT_ADMIN). Retorna `null` se não existir ou o tenant do lote não
 * estiver na lista.
 */
export async function getAiReprocessBatchInTenants(
  sql: Sql,
  allowedTenantIds: string[],
  batchId: string,
): Promise<AiReprocessBatchRecord | null> {
  if (allowedTenantIds.length === 0) return null;
  const rows = await sql<AiReprocessBatchRow[]>`
    SELECT *
    FROM ai_reprocess_batch
    WHERE id = ${batchId}
      AND tenant_id = ANY(${allowedTenantIds}::uuid[])
    LIMIT 1
  `;
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Incrementa ATOMICAMENTE o contador de progresso de um lote e transiciona
 * para `completed` quando `done + failed` atinge `total` — tudo num único
 * `UPDATE` (sem race entre jobs concorrentes; `done`/`failed` no SET referem-se
 * aos valores ANTERIORES da linha, então somamos o incremento atual no CASE).
 *
 * `outcome`:
 * - `'done'`   → o documento concluiu (ao menos as etapas pedidas rodaram).
 * - `'failed'` → o documento não pôde ser reprocessado (pré-condição faltando).
 *
 * Escopado por `tenantId` (defesa em profundidade — o worker já conhece o
 * tenant do job). Idempotência de contagem é responsabilidade do chamador:
 * cada job deve chamar isto EXATAMENTE uma vez (fila `ai-reprocess` roda com
 * `attempts: 1`).
 */
export async function incrementAiReprocessBatchProgress(
  sql: Sql,
  tenantId: string,
  batchId: string,
  outcome: 'done' | 'failed',
): Promise<void> {
  const doneInc = outcome === 'done' ? 1 : 0;
  const failedInc = outcome === 'failed' ? 1 : 0;
  await sql`
    UPDATE ai_reprocess_batch
    SET done = done + ${doneInc},
        failed = failed + ${failedInc},
        status = CASE
          WHEN (done + ${doneInc} + failed + ${failedInc}) >= total THEN 'completed'
          ELSE status
        END,
        updated_at = now()
    WHERE id = ${batchId}
      AND tenant_id = ${tenantId}
  `;
}
