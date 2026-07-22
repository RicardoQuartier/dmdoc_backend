-- Rótulo amigável opcional para campos de índice de tipo de documento.
-- Quando NULL, o rótulo exibido é derivado do `name` (split por "_"/espaço,
-- capitalizando cada palavra) — ver `deriveIndexFieldLabel` em
-- apps/api/src/lib/index-fields.ts (T-15, fase 8).

ALTER TABLE document_type_index_fields ADD COLUMN label text;
