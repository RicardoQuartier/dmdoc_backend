-- Aplicação automática das tags sugeridas por IA (5ª feature de IA) —
-- quando ligada, o worker/endpoint sob demanda mescla `suggested_tags`
-- diretamente em `documents.tags` (dedupe case-insensitive, teto de 60),
-- sem exigir o clique manual do usuário no card "Tags sugeridas pela IA".
--
-- Mesmo esquema de dois níveis das 4 features de IA já existentes
-- (classificação de tipo, título sugerido, sugestão de índices, geração de
-- tags): valor efetivo = platform_settings.ai_tag_auto_apply_enabled AND
-- tenants.ai_tag_auto_apply_enabled. Ver migration 0004_ai_feature_flags e
-- 0010_ai_tag_generation.
--
-- Default TRUE nos dois níveis (decisão de produto: liga por padrão).

-- ---------------------------------------------------------------------------
-- platform_settings — 5ª flag (SUPER_ADMIN, kill switch global)
-- ---------------------------------------------------------------------------

ALTER TABLE platform_settings ADD COLUMN ai_tag_auto_apply_enabled boolean NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------------
-- tenants — 5ª flag (toggle por empresa), mesmo default true
-- ---------------------------------------------------------------------------

ALTER TABLE tenants ADD COLUMN ai_tag_auto_apply_enabled boolean NOT NULL DEFAULT true;
