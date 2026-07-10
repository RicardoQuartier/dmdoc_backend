-- Kill switch de plataforma + toggles por empresa das features de IA de
-- sugestão (classificação de tipo, título sugerido, sugestão de índices).
-- Ver regra de negócio "Controle de features de IA por plataforma e empresa"
-- (Fases 7/8/8.1) — valor efetivo de cada feature = platform_settings.<feature>
-- AND tenants.<feature>.

-- ---------------------------------------------------------------------------
-- platform_settings — singleton (SUPER_ADMIN, kill switch global)
-- ---------------------------------------------------------------------------
-- Sem tenant_id: registro único que vale para toda a plataforma. O índice
-- único parcial abaixo (expressão constante `true`) impede a inserção de uma
-- segunda linha, garantindo o invariante de singleton no nível do banco.

CREATE TABLE platform_settings (
    id                            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    ai_classification_enabled     BOOLEAN     NOT NULL DEFAULT true,
    ai_title_suggestion_enabled   BOOLEAN     NOT NULL DEFAULT true,
    ai_index_suggestion_enabled   BOOLEAN     NOT NULL DEFAULT true,
    updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uniq_platform_settings_singleton ON platform_settings ((true));

-- Seed da linha singleton — todas as features habilitadas por padrão.
INSERT INTO platform_settings (
    ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled
) VALUES (true, true, true);

-- ---------------------------------------------------------------------------
-- tenants — toggles por empresa (TENANT_ADMIN), mesmo default true
-- ---------------------------------------------------------------------------

ALTER TABLE tenants ADD COLUMN ai_classification_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE tenants ADD COLUMN ai_title_suggestion_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE tenants ADD COLUMN ai_index_suggestion_enabled boolean NOT NULL DEFAULT true;
