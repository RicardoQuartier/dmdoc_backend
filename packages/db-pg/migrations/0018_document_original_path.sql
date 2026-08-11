-- Path relativo de upload de pasta em `documents`.
--
-- Primeira peça da feature de upload de pasta: o front captura o
-- `webkitRelativePath` do browser, que só existe quando a pessoa
-- seleciona/arrasta uma PASTA (nunca em upload de arquivo avulso). Esta
-- coluna guarda esse path relativo tal como veio do browser.
--
-- Nullable, sem default: upload de arquivo avulso continua null — nunca
-- inventamos valor aqui. `filename`/`original_filename` permanecem a
-- identidade do arquivo físico; `original_path` é só o caminho relativo
-- dentro da pasta de origem, informativo.

ALTER TABLE documents ADD COLUMN original_path text;
