-- Geração automática de TAGS por IA (Fase 9 / épico E-3 / GH #36) — CONSULTIVA.
-- A IA investiga o texto do documento e sugere até 30 tags livres (nomes,
-- datas, valores, ou qualquer informação relevante). A sugestão é gravada em
-- `document_content.suggested_tags` (espelhando `type_suggestion`/
-- `index_suggestion`); o worker NUNCA escreve em `documents.tags` (as tags
-- CONFIRMADAS pelo usuário) — a decisão do usuário sempre vence e sobrevive a
-- reprocessamento.
--
-- A feature entra no MESMO esquema de liga/desliga das 3 features de IA já
-- existentes (classificação de tipo, título sugerido, sugestão de índices):
-- valor efetivo = platform_settings.ai_tag_generation_enabled AND
-- tenants.ai_tag_generation_enabled. Ver regra de negócio "Controle de
-- features de IA por plataforma e empresa" e a migration 0004_ai_feature_flags.

-- ---------------------------------------------------------------------------
-- document_content — coluna nullable de sugestão de tags
-- ---------------------------------------------------------------------------
-- Nula enquanto o pipeline de geração de tags ainda não executou, igual a
-- `index_suggestion`, `type_suggestion` e `cost_breakdown`. JSONB no formato
-- { tags: string[], model, promptVersion, generatedAt, rawResponse }.

ALTER TABLE document_content ADD COLUMN suggested_tags JSONB;

-- ---------------------------------------------------------------------------
-- platform_settings — 4ª flag (SUPER_ADMIN, kill switch global)
-- ---------------------------------------------------------------------------

ALTER TABLE platform_settings ADD COLUMN ai_tag_generation_enabled boolean NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------------
-- tenants — 4ª flag (toggle por empresa), mesmo default true
-- ---------------------------------------------------------------------------

ALTER TABLE tenants ADD COLUMN ai_tag_generation_enabled boolean NOT NULL DEFAULT true;
