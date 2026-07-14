-- Título de exibição sugerido por IA (Fase 8.1) — CONSULTIVO.
-- A IA sugere, na MESMA chamada de classificação de tipo (Fase 8), um título
-- de exibição legível derivado do conteúdo do documento. Como toda sugestão de
-- IA no DMDoc, exige confirmação do usuário antes de valer.
-- Ver regra de negócio "Título de exibição sugerido por IA".
--
-- Duas colunas nullable em `documents`:
--   * title           — título de exibição CONFIRMADO/editado pelo usuário.
--                        Nulo até haver confirmação; enquanto nulo, listagens e
--                        telas exibem `original_filename` como fallback.
--   * suggested_title — sugestão BRUTA da IA (antes da confirmação). Consultiva:
--                        nunca é exibida como título oficial. Reprocessar
--                        sobrescreve esta coluna, mas NUNCA toca `title`.
--
-- `filename`/`original_filename` permanecem imutáveis e atrelados ao arquivo
-- físico (download, S3 key) — nenhuma sugestão de IA os substitui.

ALTER TABLE documents ADD COLUMN title text;
ALTER TABLE documents ADD COLUMN suggested_title text;
