-- Reprocessamento COMPLETO em massa (épico E-7) — registro de LOTE.
-- A API cria uma linha por disparo e enfileira UM job de `document-processing`
-- por documento ELEGÍVEL (pipeline integral: extração → embeddings → IA).
--
-- ATENÇÃO — ESTA TABELA NÃO TEM `done`/`failed`/`status`/`updated_at`, E ISSO
-- É O PONTO DELA. NÃO ADICIONE ESSAS COLUNAS.
-- O progresso do lote é DERIVADO em tempo de leitura, agregando
-- `documents.status` dos ids em `document_ids` (ver
-- `deriveDocumentReprocessBatchProgress` em `src/document-reprocess-batch.ts`).
-- Nada aqui é incrementado por worker. Duas razões concretas:
--   1. `DocumentProcessingJobDataSchema` é um `z.object` do Zod, que STRIPPA
--      chaves desconhecidas — um `batchId` extra no payload do job sumiria
--      silenciosamente antes de chegar ao worker. O lote não é conhecido lá.
--   2. A fila `document-processing` roda com `attempts: 3` e o pipeline grava
--      `FAILED` e RE-LANÇA o erro — um contador de push contaria a MESMA falha
--      até 3 vezes, estourando o `total`.
-- O lote de IA (`ai_reprocess_batch`, migration 0011) só pôde usar contadores
-- porque ganhou uma fila dedicada com `attempts: 1`. Modelos diferentes de
-- propósito: aquele é push, este é pull.
--
-- Multi-tenant: `tenant_id` escopa o lote — o progresso de um lote de outra
-- empresa nunca é legível (a leitura filtra por tenant → 404 cross-tenant,
-- nunca 403).

CREATE TABLE document_reprocess_batch (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID        NOT NULL REFERENCES tenants (id),
  -- Nullable para sobreviver à purga de usuário (append-only, como
  -- document_events.uploaded_by_id e ai_reprocess_batch.created_by).
  created_by    UUID        REFERENCES users (id),
  -- Lista IMUTÁVEL dos documentos elegíveis efetivamente enfileirados. É o
  -- universo sobre o qual o progresso é agregado; sem ela não há como derivar
  -- nada. Nunca reescrita depois do INSERT.
  document_ids  UUID[]      NOT NULL,
  -- Denominador ESTÁVEL do progresso (= cardinality(document_ids) no momento
  -- do disparo). Persistido em coluna própria porque a derivação precisa
  -- comparar o total original com o que ainda existe em `documents`: a
  -- diferença (`gone`) são as linhas apagadas fisicamente depois do disparo,
  -- que contam como falha e permitem o lote FECHAR em vez de travar em
  -- 'running' para sempre.
  total         INTEGER     NOT NULL,
  -- Quantos dos documentos SELECIONADOS pelo usuário não eram elegíveis
  -- (não estavam em FAILED) e por isso ficaram de fora de `document_ids`.
  -- Informativo para a UI; não entra na conta do progresso.
  skipped       INTEGER     NOT NULL DEFAULT 0,
  -- Marco temporal do disparo. Além de auditoria, é a base do sinal `stalled`
  -- (pendências vivas 30 min depois do disparo ⇒ worker provavelmente parado).
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX document_reprocess_batch_by_tenant ON document_reprocess_batch (tenant_id);
