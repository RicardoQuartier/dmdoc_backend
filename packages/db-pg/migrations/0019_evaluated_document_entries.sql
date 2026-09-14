-- Lançamentos manuais de páginas avaliadas (épico E-13 / T-155).
--
-- Fonte de dados da seção "Documentos avaliados" do relatório de Uso e
-- Cobrança. Diferente de `document_events` (automático e imutável), aqui o
-- lançamento é MANUAL e CORRIGÍVEL: o admin informa a data da avaliação, o
-- usuário a quem as páginas são atribuídas e a quantidade de páginas. Editar e
-- excluir exigem justificativa, mas a justificativa mora no audit log (API),
-- não nesta tabela.
--
-- Decisões:
--
-- - `evaluated_on` é `date` (sem hora): o que se lança é o DIA da avaliação,
--   não um instante. Filtro por período compara datas puras — não existe
--   borda de fuso para errar.
-- - Soft delete (`deleted`, `deleted_at`, `deleted_by_id`): o lançamento
--   excluído sai dos totais, mas o registro permanece (regra geral do DMDoc).
-- - `user_id` e todos os `*_by_id` são NULLABLE pelo mesmo motivo de
--   `document_events.uploaded_by_id`: a purga de empresa remove fisicamente os
--   usuários dela, e o histórico de cobrança sobrevive com a referência
--   anulada (ver `purgeTenantData`).
-- - `page_count > 0` garantido pelo banco (CHECK nomeado), não só pela API.
-- - `user_id` é FK SIMPLES em `users(id)`, de propósito. Uma FK composta
--   `(user_id, tenant_id) → users(id, tenant_id)` foi descartada: a promoção
--   de usuário local a papel global (`PATCH /users/:id`) grava
--   `users.tenant_id = NULL`, o que a violaria — e `ON UPDATE CASCADE` não
--   serve, porque `tenant_id` aqui é NOT NULL. "Usuário da mesma empresa" é
--   validado pela API na escrita; a purga anula `user_id` por usuário purgado,
--   sem filtrar o tenant do lançamento (ver `purgeTenantData`).
--
-- Índices:
--
-- - `evaluated_doc_entries_by_tenant_date` (PARCIAL, `deleted = false`): serve
--   o `summary` e o `listPaged` do repositório, que sempre filtram tenant +
--   não excluídos + período. Linhas excluídas não ocupam o índice.
-- - `evaluated_doc_entries_by_tenant_user_date` (COMPLETO, de propósito):
--   filtro por usuário no relatório e as operações da purga de empresa, que
--   varrem por `tenant_id` SEM filtro de `deleted` — o índice parcial não
--   serviria a elas.

CREATE TABLE evaluated_document_entries (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants(id),
  user_id       uuid        REFERENCES users(id),
  evaluated_on  date        NOT NULL,
  page_count    integer     NOT NULL,
  created_by_id uuid        REFERENCES users(id),
  updated_by_id uuid        REFERENCES users(id),
  deleted_by_id uuid        REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted       boolean     NOT NULL DEFAULT false,
  deleted_at    timestamptz,
  CONSTRAINT evaluated_doc_entries_page_count_positive CHECK (page_count > 0)
);

CREATE INDEX evaluated_doc_entries_by_tenant_date
  ON evaluated_document_entries (tenant_id, evaluated_on)
  WHERE deleted = false;

CREATE INDEX evaluated_doc_entries_by_tenant_user_date
  ON evaluated_document_entries (tenant_id, user_id, evaluated_on);
