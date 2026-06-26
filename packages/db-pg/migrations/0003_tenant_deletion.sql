-- Preparação do schema para a exclusão de empresa (tenant).
-- Ver feature "Exclusão de empresa (tenant)" — fase 6.

-- 1. document_events.uploaded_by_id passa a aceitar NULL.
-- Ao purgar os usuários de uma empresa excluída, os eventos de upload são
-- preservados (append-only/imutáveis), mas o ponteiro para o usuário purgado
-- precisa ser anulado para não violar a FK. As colunas document_id,
-- document_type_id e audit_logs.user_id/tenant_id já são nullable.
ALTER TABLE document_events ALTER COLUMN uploaded_by_id DROP NOT NULL;

-- 2. tenants ganha exclusão lógica própria.
-- Hoje a empresa só pode ser desativada via `active = false`. A exclusão de
-- empresa marca o registro como deletado (`deleted = true`) e guarda o momento
-- da purga (`deleted_at`), permitindo ocultá-la das listagens sem apagar a
-- linha — necessária para integridade referencial dos eventos preservados.
ALTER TABLE tenants ADD COLUMN deleted boolean NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN deleted_at timestamptz;
