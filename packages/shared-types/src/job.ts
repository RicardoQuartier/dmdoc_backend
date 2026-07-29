import { z } from 'zod';

/**
 * Payload de um job de processamento de documento na fila BullMQ.
 *
 * Este schema é a única fonte de verdade para o contrato entre o produtor de
 * jobs (API, rota POST /documents) e o consumidor (worker). Ambos importam
 * daqui — nunca duplicar.
 *
 * Validado na borda: o produtor valida com `DocumentProcessingJobDataSchema`
 * antes de enfileirar; o worker valida no início do handler antes de processar.
 *
 * Campos:
 * - `tenantId` / `documentId`: identificam o documento sem necessidade de
 *   lookup adicional no início do job.
 * - `storageKey`: chave do arquivo original no destino de armazenamento da
 *   empresa, para o worker baixá-lo sem precisar consultar o banco. É uma chave
 *   OPACA: só o driver de storage resolvido para o tenant sabe interpretá-la
 *   (objeto em bucket S3, item no SharePoint etc.) — nada aqui pode assumir que
 *   ela é uma chave S3.
 * - `mimeType`: indica ao extrator qual parser usar sem precisar detectar
 *   o tipo novamente.
 *
 * Spec §5.3 (coleção `jobs`) e spec §8 (pipeline de processamento).
 */
export const DocumentProcessingJobDataSchema = z.object({
  tenantId: z.string().uuid(),
  documentId: z.string().uuid(),
  storageKey: z.string().min(1),
  mimeType: z.string().min(1),
});

export type DocumentProcessingJobData = z.infer<typeof DocumentProcessingJobDataSchema>;

/**
 * Payload de um job de purga de empresa (tenant) na fila `tenant-deletion`.
 *
 * Enfileirado pela API (DELETE /admin/tenants/:id) após marcar o tenant como
 * `deleted=true`. O worker consome este job e executa a purga definitiva dos
 * dados da empresa (arquivos no destino de armazenamento configurado para ela,
 * banco) em background.
 *
 * Como o restante do contrato de jobs, é a única fonte de verdade do payload:
 * o produtor valida com `TenantDeletionJobDataSchema` antes de enfileirar; o
 * worker revalida no início do handler.
 */
export const TenantDeletionJobDataSchema = z.object({
  tenantId: z.string().uuid(),
});

export type TenantDeletionJobData = z.infer<typeof TenantDeletionJobDataSchema>;

/**
 * Etapas de IA reprocessáveis em massa (épico E-4 / T-24).
 *
 * Cada etapa reaproveita uma feature de IA já existente e é INDEPENDENTE:
 * - `title`   → classificação de tipo + título sugerido (mesma chamada de LLM,
 *               `classify-document-type-v4`); consultiva, nunca toca o tipo/título
 *               confirmado pelo usuário.
 * - `indexes` → sugestão de valores de índice (Fase 7) sobre o tipo CONFIRMADO
 *               do documento; consultiva, grava só `document_content.index_suggestion`.
 * - `tags`    → geração automática de tags (Fase 9 / E-3); consultiva, grava só
 *               `document_content.suggested_tags` (nunca `documents.tags`).
 *
 * O conjunto é extensível — novas features de IA entram aqui sem quebrar o
 * contrato do job.
 */
export const AI_REPROCESS_STEPS = ['title', 'indexes', 'tags'] as const;

export const AiReprocessStepSchema = z.enum(AI_REPROCESS_STEPS);

export type AiReprocessStep = z.infer<typeof AiReprocessStepSchema>;

/**
 * Payload de um job de reprocessamento de IA em massa (épico E-4 / T-24) na
 * fila BullMQ dedicada `ai-reprocess`.
 *
 * Enfileirado pela API (`POST /documents/bulk-reprocess-ai`) — UM job por
 * documento do lote — e consumido pelo worker dedicado, que roda só as etapas
 * de IA pedidas em `steps` (sem re-extrair, re-embeddar nem apagar chunks).
 *
 * Como o restante do contrato de jobs, é a única fonte de verdade do payload:
 * o produtor valida com `AiReprocessJobDataSchema` antes de enfileirar; o
 * worker revalida no início do handler.
 *
 * Campos:
 * - `tenantId` / `documentId`: identificam o documento (isolamento multi-tenant).
 * - `batchId`: lote (`ai_reprocess_batch`) ao qual este job pertence — usado
 *   para incrementar os contadores de progresso ao concluir o documento.
 * - `steps`: subconjunto NÃO-vazio de `AI_REPROCESS_STEPS` já filtrado pelas
 *   feature flags efetivas do tenant na API (o worker ainda re-checa por etapa).
 */
export const AiReprocessJobDataSchema = z.object({
  tenantId: z.string().uuid(),
  documentId: z.string().uuid(),
  batchId: z.string().uuid(),
  steps: z.array(AiReprocessStepSchema).min(1),
});

export type AiReprocessJobData = z.infer<typeof AiReprocessJobDataSchema>;

/**
 * Payload de um job de migração de acervo entre destinos de armazenamento
 * (épico E-11 / T-141) na fila BullMQ `storage-migration`.
 *
 * Enfileirado pela API (`POST /admin/tenants/:id/storage/migrate`) depois de
 * criar a linha em `storage_migrations`; consumido pelo worker dedicado
 * (`apps/worker/src/storage-migration-worker.ts`), que copia os arquivos dos
 * destinos anteriores para o ativo. Produtor e consumidor vivem em apps
 * diferentes, e é por isso que o contrato mora aqui: é a mesma razão dos três
 * schemas de job acima.
 *
 * Campos:
 * - `tenantId`: empresa cujo acervo está sendo movido (isolamento multi-tenant).
 * - `migrationId`: linha de `storage_migrations`, que é a **autoridade** sobre o
 *   estado da migração (progresso, cancelamento, resultado). O job carrega só o
 *   id: o destino ativo e a lista de documentos a copiar são resolvidos NO
 *   WORKER, no instante em que ele começa, e não congelados no payload.
 *   Congelá-los reintroduziria a janela em que a fila trabalha sobre um mundo
 *   que já mudou — e a seleção precisa ser recalculada a cada tentativa, já que
 *   o retry do BullMQ é o mecanismo de retomada da migração.
 *
 * Spec §5.5 (`storage_migrations`) e §7 (endpoints de migração de acervo).
 */
export const StorageMigrationJobDataSchema = z.object({
  tenantId: z.string().uuid(),
  migrationId: z.string().uuid(),
});

export type StorageMigrationJobData = z.infer<typeof StorageMigrationJobDataSchema>;
