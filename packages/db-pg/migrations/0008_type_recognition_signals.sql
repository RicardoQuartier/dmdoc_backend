-- Sinais estruturados de reconhecimento por TIPO de documento (Fase 8, epic E-1).
-- Dão a cada tipo pistas de reconhecimento além do nome+descrição, usadas pelo
-- prompt de classificação por IA (classify-document-type-v2) para desambiguar
-- tipos parecidos (ex.: Boleto × Fatura × Recibo).
--
-- Mudança ADITIVA e retrocompatível: ambas as colunas têm default seguro, então
-- tipos existentes seguem funcionando exatamente como antes (keywords vazias,
-- regras nulas) — o prompt renderiza esses tipos sem nenhuma linha extra.
-- Ver regra de negócio "Reconhecimento de tipo por IA — sinais estruturados".
--
--   * recognition_keywords — palavras/expressões que costumam aparecer no
--                            documento daquele tipo (sinais lexicais). NOT NULL,
--                            default '{}' (vazio).
--   * recognition_rules    — texto livre com regras de desambiguação, inclusive
--                            NEGATIVAS ("NÃO classifique como X se..."). Nullable.

ALTER TABLE document_types ADD COLUMN recognition_keywords text[] NOT NULL DEFAULT '{}';
ALTER TABLE document_types ADD COLUMN recognition_rules text;
