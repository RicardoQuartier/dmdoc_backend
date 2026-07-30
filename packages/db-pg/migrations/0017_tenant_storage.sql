-- Storage plugável por empresa (épico E-11) — o destino de armazenamento do
-- arquivo binário deixa de ser "o bucket S3 da plataforma" e passa a ser uma
-- escolha por empresa: S3 da plataforma (comportamento atual), S3 próprio do
-- cliente, ou SharePoint via Microsoft Graph.
--
-- SEM BACKFILL, DE PROPÓSITO. `documents.storage_config_id IS NULL` EQUIVALE a
-- ('s3', 'platform') — é isso que faz todas as empresas existentes continuarem
-- funcionando sem nenhuma escrita de dados nesta migration.
-- `tenant_storage_configs` e `storage_migrations` nascem VAZIAS; a leitura
-- delas só entra no código na T-137/T-150.
--
-- ⚠️ CONSEQUÊNCIA DO NULL, PARA QUEM FOR ESCREVER AS QUERIES (T-141, T-142):
-- comparar `storage_config_id` com a configuração de destino é sempre
-- `IS DISTINCT FROM`, NUNCA `<>`. Com NULL de um dos lados, `<>` devolve NULL,
-- o WHERE descarta a linha e a seleção da migração volta VAZIA — a migração
-- fecha em DONE com total_docs = 0, o cleanup-source conclui que a origem não
-- tem nada e apaga o acervo que nunca foi copiado. Sem erro e sem volta.

-- ---------------------------------------------------------------------------
-- documents — a chave do arquivo deixa de ser específica de S3
-- ---------------------------------------------------------------------------

-- RENAME, não ADD + UPDATE + DROP: o rename é uma operação de catálogo
-- (instantânea, sem reescrever a tabela) e preserva índices, defaults e o
-- conteúdo de todas as linhas. Nome antigo `s3_key` mentia sobre o destino
-- assim que existisse um documento no SharePoint.
-- `0001_initial.sql` continua declarando `s3_key` e isso está correto:
-- migration aplicada é IMUTÁVEL (ver README.md do pacote).
ALTER TABLE documents RENAME COLUMN s3_key TO storage_key;

-- TIPO do destino onde o arquivo desta linha está ('s3' | 'sharepoint').
-- É DENORMALIZAÇÃO de `storage_config_id` (a autoridade), mantida por ser
-- barata em `SELECT DISTINCT` e em tela. Nunca use `storage_provider` para
-- decidir SE um documento precisa migrar: dois destinos diferentes do mesmo
-- provider (bucket da plataforma → bucket do cliente) têm o mesmo valor aqui.
-- DEFAULT 's3' preenche o acervo existente na própria DDL: todo documento já
-- gravado está no S3 da plataforma.
ALTER TABLE documents ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 's3';

-- ---------------------------------------------------------------------------
-- tenant_storage_configs — histórico VERSIONADO dos destinos de cada empresa
-- ---------------------------------------------------------------------------

-- Uma linha POR CONFIGURAÇÃO, não por empresa (ADR-1 do E-11). Um documento
-- que ficou para trás num destino aposentado só é legível com as credenciais
-- DAQUELE destino; se a troca sobrescrevesse a linha, o acervo antigo ficaria
-- inalcançável no instante em que a empresa mudasse de bucket.
CREATE TABLE tenant_storage_configs (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID        NOT NULL REFERENCES tenants (id),
  provider           TEXT        NOT NULL,                  -- 's3' | 'sharepoint'
  -- 'platform' = usa as credenciais do .env da plataforma (o bucket de sempre).
  -- 'tenant'   = usa as credenciais da própria empresa, em `config`/`encrypted_secret`.
  -- Default 'tenant': quem INSERE uma linha aqui está justamente saindo do
  -- padrão da plataforma; o caso 'platform' é o de `documents.storage_config_id
  -- IS NULL`, que não tem linha nenhuma.
  credentials_source TEXT        NOT NULL DEFAULT 'tenant',
  -- Parte NÃO sensível da configuração (bucket, região, endpoint, siteId,
  -- driveId, tenantId Azure...). Formato depende do provider.
  -- ATENÇÃO ao gravar: `sql.json(...)`, nunca `JSON.stringify` — o postgres.js
  -- re-serializa e a coluna vira uma string double-encoded.
  config             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- Segredo (secret key da AWS, client secret do Azure) cifrado pela
  -- aplicação. Nulo quando credentials_source = 'platform'.
  encrypted_secret   TEXT,
  -- Destino CORRENTE da empresa (para onde vão os uploads novos). As linhas
  -- aposentadas continuam aqui, e continuam sendo usadas para LER os documentos
  -- que ainda apontam para elas.
  active             BOOLEAN     NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Quando esta configuração deixou de receber uploads. NULL na ativa.
  retired_at         TIMESTAMPTZ,
  -- Não existe SharePoint DA PLATAFORMA: o DMDoc não tem um tenant Azure
  -- global para hospedar arquivo de cliente. Logo, credenciais de plataforma
  -- só fazem sentido com provider = 's3'. O invariante mora no banco, não na
  -- aplicação — uma rota nova, um seed ou um psql manual não conseguem burlá-lo.
  -- NÃO é restrito às linhas ativas de propósito: uma linha aposentada
  -- inválida seria igualmente impossível de resolver na hora de ler o acervo
  -- antigo. O CHECK vale para toda linha, viva ou histórica.
  CONSTRAINT storage_platform_creds_only_s3
    CHECK (credentials_source = 'tenant' OR provider = 's3'),
  -- Alvo da FK COMPOSTA de `documents`. Redundante como unicidade (`id` já é
  -- PK), indispensável como referência: uma FK só pode apontar para colunas
  -- cobertas por PK ou UNIQUE, e é esta linha que permite amarrar o tenant
  -- dentro da própria FK. Ver `documents_storage_config_fk` abaixo.
  CONSTRAINT uniq_storage_config_id_tenant UNIQUE (id, tenant_id)
);

-- ⚠️ INVARIANTE DE ESCRITA (T-140): as linhas desta tabela são IMUTÁVEIS nos
-- campos de configuração. Trocar o destino de uma empresa é
--   INSERT da linha nova  +  UPDATE ... SET active = false, retired_at = now()
-- na anterior. NUNCA um UPDATE de `provider`/`config`/`encrypted_secret`:
-- documentos apontam para a linha, e reescrevê-la apagaria o passado — é
-- exatamente a perda de dados que a ADR-1 corrigiu. `active` e `retired_at`
-- são as únicas colunas que mudam depois do INSERT.
-- (Não há CHECK amarrando `active = false` a `retired_at IS NOT NULL`:
-- `retired_at` é informativo — alimenta a tela de destinos anteriores — e
-- nenhuma decisão de leitura ou de purga depende dele. O que precisa ser
-- garantido pelo catálogo está nos dois índices/constraints acima e abaixo.)

-- No máximo UMA configuração ativa por empresa — as demais são o histórico.
-- Índice único PARCIAL, mesmo padrão de `uniq_doc_tenant_content_hash` e de
-- `uniq_storage_migration_running`: só a linha viva compete pela unicidade,
-- então quantas linhas aposentadas quiser convivem para o mesmo tenant.
CREATE UNIQUE INDEX uniq_tenant_storage_active
  ON tenant_storage_configs (tenant_id)
  WHERE active;

-- ---------------------------------------------------------------------------
-- documents.storage_config_id — de qual configuração ESTE arquivo depende
-- ---------------------------------------------------------------------------

-- NULLABLE, e NULL significa "S3 da plataforma, credenciais do .env". Todo o
-- acervo existente fica em NULL e continua legível sem que esta migration
-- escreva uma única linha de dado. Sintetizar uma linha "plataforma" por
-- empresa só para evitar o nullable seria backfill disfarçado, ainda por cima
-- sobre credenciais que nem moram no banco.
ALTER TABLE documents ADD COLUMN storage_config_id UUID;

-- FK COMPOSTA, não `REFERENCES tenant_storage_configs (id)`. Com FK simples,
-- nada no banco impediria um documento do tenant A apontar para a configuração
-- do tenant B — e resolver esse driver significaria ler o bucket de OUTRA
-- empresa COM AS CREDENCIAIS DELA. A T-141 escreve esta coluna em massa, então
-- não é hipótese remota. O isolamento fica no catálogo, não na aplicação.
--
-- MATCH SIMPLE (o default — não trocar por MATCH FULL): com MATCH SIMPLE, a
-- linha com `storage_config_id IS NULL` não é verificada, que é exatamente o
-- que o acervo da plataforma precisa. MATCH FULL exigiria todas as colunas da
-- FK nulas ou todas preenchidas e, como `tenant_id` é NOT NULL, rejeitaria
-- TODO documento na plataforma.
--
-- ON DELETE NO ACTION (default), também de propósito: enquanto houver
-- documento apontando para uma configuração, ela não pode ser apagada. É o que
-- impede a purga (T-142) de destruir as credenciais antes dos arquivos.
ALTER TABLE documents
  ADD CONSTRAINT documents_storage_config_fk
  FOREIGN KEY (storage_config_id, tenant_id)
  REFERENCES tenant_storage_configs (id, tenant_id);

-- Coerência entre a autoridade (`storage_config_id`) e a denormalização
-- (`storage_provider`): o destino da plataforma é sempre S3, nunca outra coisa.
-- Sem isto, um UPDATE que comutasse só uma das duas colunas deixaria um
-- documento marcado como 'sharepoint' apontando para o bucket da plataforma.
ALTER TABLE documents
  ADD CONSTRAINT documents_platform_storage_is_s3
  CHECK (storage_config_id IS NOT NULL OR storage_provider = 's3');

-- Serve à seleção da migração de acervo (T-141: documentos do tenant que ainda
-- não estão na configuração de destino) e à varredura de destinos da purga
-- (T-142). `tenant_id` na frente porque toda consulta do sistema filtra tenant.
CREATE INDEX docs_by_storage_config ON documents (tenant_id, storage_config_id);

-- ---------------------------------------------------------------------------
-- storage_migrations — estado de cada migração de acervo entre destinos
-- ---------------------------------------------------------------------------

-- Diferente de `document_reprocess_batch` (migration 0016, progresso DERIVADO
-- de documents.status), aqui os contadores são PERSISTIDOS: não há coluna em
-- `documents` que diga "já foi copiado nesta migração" — `storage_config_id`
-- diz de onde o arquivo depende, mas um documento que já nasceu no destino não
-- foi copiado por esta migração e não deveria contar. O modelo é push, como o
-- `ai_reprocess_batch` (0011).
-- `from_provider`/`to_provider` são DESCRITIVOS (rótulo da migração em tela e
-- no histórico); o que determina o que migrar é `storage_config_id`, nunca
-- estas duas colunas — ver o aviso sobre `IS DISTINCT FROM` no cabeçalho.
CREATE TABLE storage_migrations (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID        NOT NULL REFERENCES tenants (id),
  from_provider  TEXT        NOT NULL,
  to_provider    TEXT        NOT NULL,
  status         TEXT        NOT NULL DEFAULT 'PENDING',  -- PENDING|RUNNING|DONE|FAILED|CANCELLED
  total_docs     INTEGER     NOT NULL DEFAULT 0,
  migrated_docs  INTEGER     NOT NULL DEFAULT 0,
  failed_docs    INTEGER     NOT NULL DEFAULT 0,
  last_error     TEXT,
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- UMA migração ativa por empresa. Dois jobs concorrentes copiando o mesmo
-- acervo seria desperdício de banda e fonte de contagem errada (os dois
-- incrementando `migrated_docs` do seu próprio lote sobre os mesmos arquivos).
-- Índice único PARCIAL, mesmo padrão do `uniq_doc_tenant_content_hash`: só as
-- linhas vivas competem pela unicidade — migrações encerradas (DONE, FAILED,
-- CANCELLED) ficam fora do índice e o histórico pode acumular sem bloquear a
-- próxima migração da mesma empresa.
CREATE UNIQUE INDEX uniq_storage_migration_running
  ON storage_migrations (tenant_id)
  WHERE status IN ('PENDING', 'RUNNING');
