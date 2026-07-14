-- Sugestão de tipo de documento por IA (Fase 8) — CONSULTIVA, espelhando o
-- padrão de `document_content.index_suggestion` (Fase 7). O worker escreve a
-- sugestão de tipo aqui; NUNCA sobrescreve `documents.document_type_id` — a
-- escolha manual do usuário sempre vence e sobrevive a reprocessamento.
-- Ver regra de negócio "Classificação de tipo por IA — catálogo e fallback
-- sem tipo compatível".

-- ---------------------------------------------------------------------------
-- document_content — coluna nullable de sugestão de tipo
-- ---------------------------------------------------------------------------
-- Nula enquanto o pipeline de classificação de IA ainda não executou, igual a
-- `index_suggestion` e `cost_breakdown`.

ALTER TABLE document_content ADD COLUMN type_suggestion JSONB;
