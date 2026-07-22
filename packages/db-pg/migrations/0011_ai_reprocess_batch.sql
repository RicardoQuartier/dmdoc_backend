-- Reprocessamento de IA em massa (épico E-4 / T-24) — registro de LOTE.
-- A API (`POST /documents/bulk-reprocess-ai`) cria uma linha por disparo e
-- enfileira UM job de IA por documento na fila dedicada `ai-reprocess`. O worker
-- incrementa `done`/`failed` atomicamente ao concluir cada documento e faz a
-- transição para `status = 'completed'` quando `done + failed = total`.
--
-- Multi-tenant: `tenant_id` escopa o lote — o status de um lote de outra empresa
-- nunca é legível (GET .../batches/:id filtra por tenant → 404 cross-tenant).
--
-- `steps` guarda as etapas de IA efetivamente enfileiradas (subconjunto de
-- {title, indexes, tags}), já filtradas pelas feature flags do tenant na API.

CREATE TABLE ai_reprocess_batch (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES tenants (id),
  -- Nullable para sobreviver à purga de usuário (append-only, como document_events).
  created_by  UUID        REFERENCES users (id),
  total       INTEGER     NOT NULL,
  done        INTEGER     NOT NULL DEFAULT 0,
  failed      INTEGER     NOT NULL DEFAULT 0,
  status      TEXT        NOT NULL DEFAULT 'running', -- 'running' | 'completed'
  steps       TEXT[]      NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ai_reprocess_batch_by_tenant ON ai_reprocess_batch (tenant_id);
