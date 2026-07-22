-- Aplicação automática das sugestões de TIPO, TÍTULO e ÍNDICES por IA —
-- pedido do Owner (2026-07-22): "quando a IA reconhecer um titulo, tag ou
-- indice auto aplicar em qualquer situação, independente se upload ou lote,
-- a nao ser que a flag esteja desligada global ou tenant". A 5ª feature
-- (aiTagAutoApplyEnabled, migration 0012) já cobre tags; esta migration
-- espelha o MESMO esquema de dois níveis para as 3 features restantes:
-- classificação de tipo (document_type_id), título (title) e índices
-- (index_values). Default TRUE nos dois níveis (mesma decisão de produto).
--
-- Auto-aplicação NUNCA sobrescreve um valor já CONFIRMADO manualmente — só
-- preenche campos ainda vazios. Roda em TODOS os gatilhos existentes (upload,
-- reprocessamento individual, reprocessamento em lote, endpoints sob demanda,
-- PATCH que define o tipo) — ver regra de negócio "Liga/desliga de recursos
-- de IA — dois níveis e granularidade por feature".

-- ---------------------------------------------------------------------------
-- platform_settings — 6ª/7ª/8ª flags (SUPER_ADMIN, kill switch global)
-- ---------------------------------------------------------------------------

ALTER TABLE platform_settings ADD COLUMN ai_classification_auto_apply_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE platform_settings ADD COLUMN ai_title_auto_apply_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE platform_settings ADD COLUMN ai_index_auto_apply_enabled boolean NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------------
-- tenants — mesmas 3 flags (toggle por empresa), mesmo default true
-- ---------------------------------------------------------------------------

ALTER TABLE tenants ADD COLUMN ai_classification_auto_apply_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE tenants ADD COLUMN ai_title_auto_apply_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE tenants ADD COLUMN ai_index_auto_apply_enabled boolean NOT NULL DEFAULT true;
