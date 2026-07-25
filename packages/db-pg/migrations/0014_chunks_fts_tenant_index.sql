-- Busca lexical multi-tenant: índice GIN composto (tenant_id, department_id,
-- text_search_pt) + estatísticas estendidas sobre o par (tenant_id,
-- department_id) em `chunks`.
--
-- PROBLEMA
-- --------
-- O único índice de full-text era `chunks_text_search_pt_gin` (0001_initial.sql:245),
-- GIN puro sobre `text_search_pt`, sem coluna de empresa. Um termo comum casa
-- chunks de TODAS as empresas: o custo de cada busca cresce com o total de
-- chunks da base, não com o tamanho da empresa que busca. Com a paginação
-- server-side (T-59) esse custo passou a ser pago a cada clique de página.
--
-- Pior: a partir de certo volume o planner ABANDONA o GIN e passa a varrer a
-- fatia da empresa por `chunks_by_tenant_department`, aplicando o `@@` como
-- filtro no heap — o que detoasta o `text_search_pt` de todo chunk da empresa.
--
-- MEDIÇÃO (base descartável, 40 empresas x 7.500 chunks = 300.000 chunks,
-- pgvector/pgvector:pg16, shared_buffers 128MB, cache quente; a query medida é
-- `searchDocumentsPaged` de src/search.ts, termo comum, página 1):
--
--   A  antes                          33,3 ms   24.020 buffers   (sem GIN no plano)
--   B  só estatísticas estendidas     30,4 ms    7.485 buffers   (BitmapAnd volta)
--   C  estatísticas + índice composto 19,3 ms    7.509 buffers   (índice novo escolhido)
--   D  só índice composto             33,3 ms   24.020 buffers   (idêntico a A)
--
-- As duas peças são INSEPARÁVEIS — daí virem na mesma migration:
--
-- * Sem as estatísticas (cenário D) o planner nunca escolhe o índice novo. Ele
--   trata `tenant_id` e `department_id` como independentes e estima
--   (1/40)x(3/160) = 145 linhas onde existem 5.625 (39x a menos), o que faz o
--   caminho por `chunks_by_tenant_department` parecer 39x mais barato do que é.
--   Índice criado e nunca usado = só custo.
-- * Sem o índice composto (cenário B) o plano melhora (o BitmapAnd volta e o
--   HashAggregate substitui o Sort+GroupAggregate), mas o ramo GIN ainda
--   percorre a lista de postings do termo na base INTEIRA: 13,8 ms para 86.984
--   entradas. Com o índice composto o mesmo ramo lê só a fatia da empresa:
--   1,4 ms para 1.621 entradas. Essa é a parcela que escala com o número de
--   empresas — a que esta migration existe para eliminar.
--
-- O ÍNDICE ANTIGO FICA. Busca sem filtro de empresa (SUPER_ADMIN sem empresa
-- selecionada) continua usando `chunks_text_search_pt_gin` — verificado com
-- EXPLAIN. Com `tenant_id = ANY(...)` (SUPER_ADMIN com N empresas) o planner
-- usa o composto: btree_gin trata ScalarArrayOp normalmente.
--
-- CONTRAPARTIDAS MEDIDAS
-- ----------------------
-- * Disco: 37 MB para 300.000 chunks (~129 bytes/chunk). O GIN puro equivalente
--   ocupa 51 MB; o composto é MENOR porque as entradas de tenant/departamento
--   são poucas e de posting list densa.
-- * Escrita: lote de 25 chunks (1 documento ingerido pelo worker) passou de
--   8,40 ms para 9,91 ms sem o HNSW no caminho — +1,5 ms por documento (+18%).
--   Com o `chunks_embedding_hnsw` presente, como em produção, o lote custa
--   24-54 ms e é dominado pela inserção no grafo HNSW: a diferença com/sem o
--   índice composto some no ruído (29,3 vs 27,3 ms e 24,4 vs 25,5 ms em blocos
--   alternados). O worker paga o HNSW de qualquer forma; este índice é ruído
--   perto disso.
-- * `CREATE INDEX` (não CONCURRENTLY — a migration roda em transação) levou
--   7,2 s para 300.000 chunks, bloqueando escrita em `chunks` nesse intervalo.
--
-- Registro completo: task T-61 (épico E-5).

CREATE EXTENSION IF NOT EXISTS btree_gin;

-- Ordem das colunas é irrelevante para o GIN (não há prefixo como no btree):
-- cada coluna vira uma classe de entradas independente. Mantida legível.
CREATE INDEX chunks_fts_tenant_gin
  ON chunks USING gin (tenant_id, department_id, text_search_pt);

-- `department_id` determina funcionalmente `tenant_id` (um departamento
-- pertence a uma empresa). Sem dizer isso ao planner, a estimativa do par sai
-- 39x menor que a realidade e o índice acima nunca é escolhido.
CREATE STATISTICS chunks_tenant_dept_stats (dependencies, ndistinct, mcv)
  ON tenant_id, department_id FROM chunks;

-- Estatística estendida só passa a existir de fato depois de coletada.
ANALYZE chunks;
