-- Remove o índice único total (que bloqueia re-upload após soft delete)
DROP INDEX IF EXISTS uniq_doc_tenant_content_hash;

-- Recria como índice único parcial: apenas documentos não deletados competem pela unicidade.
-- Documentos soft-deletados (deleted = true) ficam fora do índice, permitindo
-- que o mesmo contentHash seja reutilizado após uma exclusão lógica.
CREATE UNIQUE INDEX uniq_doc_tenant_content_hash
  ON documents (tenant_id, content_hash)
  WHERE deleted = false;
