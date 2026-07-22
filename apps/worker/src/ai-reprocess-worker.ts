import { Worker, type Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import { incrementAiReprocessBatchProgress } from '@dmdoc/db-pg';
import { AiReprocessJobDataSchema, type AiReprocessJobData } from '@dmdoc/shared-types';
import type { LLMProvider } from '@dmdoc/llm-provider';
import { config } from './config.js';
import { createRedisConnection } from './redis.js';
import { AI_REPROCESS_QUEUE } from './queues.js';
import { runAiReprocessDocument } from './pipeline/ai-reprocess.js';

/**
 * Concorrência do worker de reprocessamento de IA (épico E-4 / T-24).
 *
 * BAIXA de propósito: cada documento dispara até 3 chamadas de LLM (título/tipo,
 * índices, tags). Em lotes grandes, uma concorrência alta estouraria o rate
 * limit do provedor. 2 jobs em paralelo mantêm throughput razoável sem risco —
 * o retry/backoff do provedor (dentro dos núcleos de `@dmdoc/llm-provider`) já
 * absorve picos pontuais.
 */
const AI_REPROCESS_CONCURRENCY = 2;

/**
 * Dependências injetadas no worker de reprocessamento de IA. Construídas uma
 * única vez no boot (`worker.ts main()`) e reutilizadas em cada job.
 */
export interface AiReprocessWorkerDeps {
  sql: Sql;
  llmProvider: LLMProvider;
  /** Modelo de chat configurado — fallback de auditoria do TypeSuggestion. */
  chatModel: string;
  logger: Logger;
  /** Confiança mínima para auto-aplicar o tipo classificado (ver `ai-reprocess.ts`). */
  typeAutoApplyMinConfidence: number;
}

/**
 * Cria o processor BullMQ do reprocessamento de IA em massa.
 *
 * Para cada job (1 documento do lote):
 * 1. Revalida o payload na borda (`AiReprocessJobDataSchema`).
 * 2. Roda as etapas de IA pedidas (`runAiReprocessDocument`) — best-effort por
 *    etapa (falha de LLM não derruba o documento).
 * 3. Incrementa EXATAMENTE uma vez o contador do lote: `done` no caminho feliz,
 *    `failed` quando uma pré-condição falha (documento sem texto/inexistente).
 *
 * NUNCA re-lança: a fila roda com `attempts: 1`, e re-lançar arriscaria contagem
 * dupla do lote. Erros inesperados de INFRA (ex.: banco indisponível ao gravar o
 * contador) são logados; o lote pode não fechar nesse caso extremo (documentado
 * para o QA — o polling do front deve tolerar lote que não atinge o total).
 */
function createAiReprocessProcessor(deps: AiReprocessWorkerDeps) {
  return async (job: Job<AiReprocessJobData>): Promise<void> => {
    const { tenantId, documentId, batchId, steps } = AiReprocessJobDataSchema.parse(job.data);
    const log = deps.logger.child({ jobId: job.id, tenantId, documentId, batchId });

    let outcome: 'done' | 'failed' = 'done';
    try {
      await runAiReprocessDocument(
        { tenantId, documentId, steps },
        {
          sql: deps.sql,
          llmProvider: deps.llmProvider,
          chatModel: deps.chatModel,
          logger: deps.logger,
          typeAutoApplyMinConfidence: deps.typeAutoApplyMinConfidence,
        },
      );
    } catch (err: unknown) {
      // Pré-condição do documento falhou (sem texto/inexistente) OU erro
      // inesperado: conta como `failed`. NÃO re-lança (attempts: 1 + contagem
      // exata do lote). 1 documento falho nunca derruba o lote.
      outcome = 'failed';
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'documento não pôde ser reprocessado (best-effort) — contando como failed no lote',
      );
    }

    try {
      await incrementAiReprocessBatchProgress(deps.sql, tenantId, batchId, outcome);
    } catch (counterErr: unknown) {
      log.error(
        { err: counterErr instanceof Error ? counterErr.message : String(counterErr) },
        'falha ao incrementar contador do lote de reprocessamento de IA',
      );
    }
  };
}

/**
 * Cria o Worker BullMQ ligado à fila `ai-reprocess`. Sobe ao lado dos demais
 * workers (documentos, tenant-deletion) — não os substitui.
 */
export function createAiReprocessWorker(deps: AiReprocessWorkerDeps): Worker<AiReprocessJobData> {
  const connection = createRedisConnection(config);

  const worker = new Worker<AiReprocessJobData>(
    AI_REPROCESS_QUEUE,
    createAiReprocessProcessor(deps),
    {
      connection,
      concurrency: AI_REPROCESS_CONCURRENCY,
    },
  );

  worker.on('failed', (job, err) => {
    deps.logger.error(
      { jobId: job?.id, tenantId: job?.data.tenantId, documentId: job?.data.documentId, batchId: job?.data.batchId, err },
      'job de reprocessamento de IA falhou',
    );
  });

  worker.on('error', (err) => {
    deps.logger.error({ err }, 'erro no worker de reprocessamento de IA');
  });

  return worker;
}
