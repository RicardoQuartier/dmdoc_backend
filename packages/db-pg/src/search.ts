import type { Sql } from 'postgres';

// ---------------------------------------------------------------------------
// Tipos de resultado e parâmetros de busca
// ---------------------------------------------------------------------------

/**
 * Um resultado de chunk retornado pelas buscas (lexical, vetorial ou híbrida).
 *
 * `score` é o score de relevância atribuído pelo motor de busca:
 *   - lexical: ts_rank() normalizado pelo PostgreSQL FTS
 *   - vetorial: 1 - (embedding <=> queryVector) — similaridade cosine [0,1]
 *   - híbrida: RRF score = 1/(60+rank_l) + 1/(60+rank_v)  (constante k=60)
 *
 * Não faz parte do ChunkSchema de negócio pois é artefato da query, não do
 * documento armazenado.
 */
export interface ChunkSearchResult {
  documentId: string;
  tenantId: string;
  departmentId: string;
  documentTypeName: string | null;
  pageNumber: number | null;
  chunkIndex: number;
  text: string;
  tokenCount: number;
  score: number;
}

/**
 * Parâmetros comuns às buscas lexical, vetorial e híbrida.
 *
 * `tenantId`: tenant único (mode: 'single' / 'all'). Mutuamente exclusivo com `tenantIds`.
 * `tenantIds`: lista de tenants (mode: 'allowed' — MULTI_TENANT_ADMIN). Quando presente,
 *   o filtro de tenant usa `= ANY($ids::uuid[])` em vez de igualdade simples.
 *   Exatamente um dos dois deve ser fornecido; se nenhum for informado, a busca
 *   não filtra por tenant (equivale ao modo SUPER_ADMIN sem restrição).
 *
 * `allowedDepartmentIds`: lista de departmentIds que o usuário pode ler.
 *   `null` = sem restrição (TENANT_ADMIN/SUPER_ADMIN/MULTI_TENANT_ADMIN).
 *
 * `filterDocumentIds`: se fornecido, restringe a busca a esses documentos
 *   (resultado de filtros estruturados por indexValues/tags).
 */
export interface SearchParams {
  tenantId?: string;
  /** Usado quando mode === 'allowed' (MULTI_TENANT_ADMIN): filtra por = ANY. */
  tenantIds?: string[];
  allowedDepartmentIds: string[] | null;
  filterDocumentIds?: string[];
  topK: number;
}

/**
 * Parâmetros para busca lexical via tsvector/tsquery.
 */
export interface LexicalSearchParams extends SearchParams {
  queryText: string;
}

/**
 * Parâmetros para busca vetorial via pgvector HNSW cosine.
 */
export interface VectorSearchParams extends SearchParams {
  queryEmbedding: number[];
  /**
   * Mantido para compatibilidade de assinatura com o MongoDB search.ts.
   * No PostgreSQL com HNSW, o parâmetro equivalente é `hnsw.ef_search`
   * configurado no índice — não é passado por query.
   */
  numCandidates?: number;
}

/**
 * Parâmetros para busca híbrida com RRF manual (combina lexical + vetorial).
 */
export interface HybridSearchParams extends SearchParams {
  queryText: string;
  queryEmbedding: number[];
  numCandidates?: number;
}

/**
 * Parâmetros para busca por metadados na tabela `documents`.
 */
export interface MetadataSearchParams {
  tenantId?: string;
  tenantIds?: string[];
  allowedDepartmentIds: string[] | null;
  filterDocumentIds?: string[];
  queryText: string;
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

/**
 * Formata um embedding number[] como literal vector do pgvector.
 * Ex.: [0.1, 0.2, ...] → '[0.1,0.2,...]'
 */
function embeddingToLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/**
 * Alias de tipo para os parâmetros aceitos pelo postgres.js `unsafe()`.
 * Permite tipar o array de bindings de forma compatível com a lib.
 */
type UnsafeParams = Parameters<Sql['unsafe']>[1];

// ---------------------------------------------------------------------------
// documentMetadataSearch
// ---------------------------------------------------------------------------

/**
 * Busca documentos na tabela `documents` pelos campos `original_filename` e `tags`.
 *
 * Tokeniza a query em palavras (≥ 2 chars) e para cada palavra verifica:
 *   original_filename ILIKE '%word%'  OR  word = ANY(tags)
 *
 * As condições por palavra são combinadas com OR, replicando o comportamento do
 * regex alternado do MongoDB. Retorna até 10 IDs de documentos (READY, não
 * deletados) que passem nos filtros de tenant, departamento e lista pré-filtrada.
 *
 * Spec §9 (etapa 4 — filtros estruturados + metadados).
 */
export async function documentMetadataSearch(
  sql: Sql,
  params: MetadataSearchParams
): Promise<string[]> {
  const { tenantId, tenantIds, allowedDepartmentIds, filterDocumentIds, queryText } = params;

  const words = queryText
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  if (words.length === 0) return [];

  let paramIndex = 1;
  const bindings: (string | string[])[] = [];

  // Predicados de palavras: cada palavra gera um par de condições ILIKE + ANY(tags).
  // O índice do parâmetro é reutilizado duas vezes ($N aparece duas vezes na cláusula).
  const wordParts: string[] = [];
  for (const word of words) {
    bindings.push(word);
    const idx = paramIndex++;
    wordParts.push(
      `(original_filename ILIKE '%' || $${idx}::text || '%' OR $${idx}::text = ANY(tags))`
    );
  }

  let whereClause = `deleted = false AND status = 'READY' AND (${wordParts.join(' OR ')})`;

  // Filtro de tenant
  if (tenantIds !== undefined && tenantIds.length > 0) {
    bindings.push(tenantIds);
    whereClause += ` AND tenant_id = ANY($${paramIndex++}::uuid[])`;
  } else if (tenantId !== undefined) {
    bindings.push(tenantId);
    whereClause += ` AND tenant_id = $${paramIndex++}::uuid`;
  }

  // Filtro de departamento
  if (allowedDepartmentIds !== null) {
    bindings.push(allowedDepartmentIds);
    whereClause += ` AND department_id = ANY($${paramIndex++}::uuid[])`;
  }

  // Filtro de documentos pré-filtrados
  if (filterDocumentIds !== undefined && filterDocumentIds.length > 0) {
    bindings.push(filterDocumentIds);
    whereClause += ` AND id = ANY($${paramIndex++}::uuid[])`;
  }

  const query = `SELECT id FROM documents WHERE ${whereClause} LIMIT 10`;

  type Row = { id: string };
  const rows = await sql.unsafe<Row[]>(query, bindings as UnsafeParams);
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// lexicalSearch
// ---------------------------------------------------------------------------

/**
 * Busca lexical em chunks usando tsvector + tsquery do PostgreSQL.
 *
 * Substitui o $search com `lucene.portuguese` do Atlas Search.
 * Usa a coluna gerada `text_search_pt` (TSVECTOR com dicionário portuguese)
 * e `plainto_tsquery('portuguese', $query)` para normalização de stemming.
 *
 * `ts_rank()` retorna um score em [0, 1] que reflete a frequência dos termos
 * no chunk, usado para ordenação e exposição no campo `score`.
 *
 * Spec §9 (etapa 3 — busca lexical).
 */
export async function lexicalSearch(
  sql: Sql,
  params: LexicalSearchParams
): Promise<ChunkSearchResult[]> {
  const { tenantId, tenantIds, allowedDepartmentIds, queryText, topK, filterDocumentIds } = params;

  let paramIndex = 1;
  const bindings: (string | string[] | number)[] = [];

  bindings.push(queryText);
  const queryParam = paramIndex++;   // $1 — tsquery

  let whereClause = `text_search_pt @@ plainto_tsquery('portuguese', $${queryParam}::text)`;

  // Filtro de tenant
  if (tenantIds !== undefined && tenantIds.length > 0) {
    bindings.push(tenantIds);
    whereClause += ` AND tenant_id = ANY($${paramIndex++}::uuid[])`;
  } else if (tenantId !== undefined) {
    bindings.push(tenantId);
    whereClause += ` AND tenant_id = $${paramIndex++}::uuid`;
  }

  // Filtro de departamento
  if (allowedDepartmentIds !== null) {
    bindings.push(allowedDepartmentIds);
    whereClause += ` AND department_id = ANY($${paramIndex++}::uuid[])`;
  }

  // Filtro de documentos pré-filtrados
  if (filterDocumentIds !== undefined && filterDocumentIds.length > 0) {
    bindings.push(filterDocumentIds);
    whereClause += ` AND document_id = ANY($${paramIndex++}::uuid[])`;
  }

  bindings.push(topK);
  const limitParam = paramIndex++;

  const query = `
    SELECT
      document_id        AS "documentId",
      tenant_id          AS "tenantId",
      department_id      AS "departmentId",
      document_type_name AS "documentTypeName",
      page_number        AS "pageNumber",
      chunk_index        AS "chunkIndex",
      text,
      token_count        AS "tokenCount",
      ts_rank(text_search_pt, plainto_tsquery('portuguese', $${queryParam}::text)) AS score
    FROM chunks
    WHERE ${whereClause}
    ORDER BY score DESC
    LIMIT $${limitParam}
  `;

  type Row = {
    documentId: string;
    tenantId: string;
    departmentId: string;
    documentTypeName: string | null;
    pageNumber: number | null;
    chunkIndex: number;
    text: string;
    tokenCount: number;
    score: number;
  };

  const rows = await sql.unsafe<Row[]>(query, bindings as UnsafeParams);
  return rows.map((r) => ({
    documentId: r.documentId,
    tenantId: r.tenantId,
    departmentId: r.departmentId,
    documentTypeName: r.documentTypeName,
    pageNumber: r.pageNumber,
    chunkIndex: r.chunkIndex,
    text: r.text,
    tokenCount: r.tokenCount,
    score: Number(r.score),
  }));
}

// ---------------------------------------------------------------------------
// vectorSearch
// ---------------------------------------------------------------------------

/**
 * Busca vetorial em chunks usando o operador <=> do pgvector (distância cosine).
 *
 * Substitui o $vectorSearch com índice HNSW cosine do Atlas Vector Search.
 * O índice HNSW é criado via migration (Fase 1) com `vector_cosine_ops`.
 *
 * Score retornado = 1 - distância cosine, i.e., similaridade cosine em [0,1]:
 *   score = 1 corresponde a vetores idênticos.
 *
 * `numCandidates` é mantido na assinatura por compatibilidade com o MongoDB
 * search.ts, mas não tem efeito no PostgreSQL — o HNSW usa `hnsw.ef_search`
 * configurado no índice.
 *
 * Spec §9 (etapa 3 — busca vetorial).
 */
export async function vectorSearch(
  sql: Sql,
  params: VectorSearchParams
): Promise<ChunkSearchResult[]> {
  const { tenantId, tenantIds, allowedDepartmentIds, queryEmbedding, topK, filterDocumentIds } =
    params;

  const embeddingLiteral = embeddingToLiteral(queryEmbedding);

  let paramIndex = 1;
  const bindings: (string | string[] | number)[] = [];

  bindings.push(embeddingLiteral);
  const embParam = paramIndex++;   // $1 — embedding literal

  let whereClause = '1=1';

  // Filtro de tenant
  if (tenantIds !== undefined && tenantIds.length > 0) {
    bindings.push(tenantIds);
    whereClause += ` AND tenant_id = ANY($${paramIndex++}::uuid[])`;
  } else if (tenantId !== undefined) {
    bindings.push(tenantId);
    whereClause += ` AND tenant_id = $${paramIndex++}::uuid`;
  }

  // Filtro de departamento
  if (allowedDepartmentIds !== null) {
    bindings.push(allowedDepartmentIds);
    whereClause += ` AND department_id = ANY($${paramIndex++}::uuid[])`;
  }

  // Filtro de documentos pré-filtrados
  if (filterDocumentIds !== undefined && filterDocumentIds.length > 0) {
    bindings.push(filterDocumentIds);
    whereClause += ` AND document_id = ANY($${paramIndex++}::uuid[])`;
  }

  bindings.push(topK);
  const limitParam = paramIndex++;

  const query = `
    SELECT
      document_id        AS "documentId",
      tenant_id          AS "tenantId",
      department_id      AS "departmentId",
      document_type_name AS "documentTypeName",
      page_number        AS "pageNumber",
      chunk_index        AS "chunkIndex",
      text,
      token_count        AS "tokenCount",
      1 - (embedding <=> $${embParam}::vector) AS score
    FROM chunks
    WHERE ${whereClause}
    ORDER BY embedding <=> $${embParam}::vector
    LIMIT $${limitParam}
  `;

  type Row = {
    documentId: string;
    tenantId: string;
    departmentId: string;
    documentTypeName: string | null;
    pageNumber: number | null;
    chunkIndex: number;
    text: string;
    tokenCount: number;
    score: number;
  };

  const rows = await sql.unsafe<Row[]>(query, bindings as UnsafeParams);
  return rows.map((r) => ({
    documentId: r.documentId,
    tenantId: r.tenantId,
    departmentId: r.departmentId,
    documentTypeName: r.documentTypeName,
    pageNumber: r.pageNumber,
    chunkIndex: r.chunkIndex,
    text: r.text,
    tokenCount: r.tokenCount,
    score: Number(r.score),
  }));
}

// ---------------------------------------------------------------------------
// hybridSearch
// ---------------------------------------------------------------------------

/**
 * Busca híbrida com Reciprocal Rank Fusion (RRF) manual.
 *
 * Substitui o $rankFusion nativo do MongoDB Atlas 8.0+.
 *
 * Algoritmo (constante k=60, padrão da literatura RRF de Cormack et al. 2009):
 *   1. lexical_ranked: ROW_NUMBER sobre ts_rank DESC, LIMIT topK*3 candidatos
 *   2. vector_ranked:  ROW_NUMBER sobre embedding <=> ASC, LIMIT topK*3 candidatos
 *   3. rrf:            FULL OUTER JOIN em chunk_id
 *                      rrf_score = 1/(60+rank_l) + 1/(60+rank_v)
 *                      chunk ausente em um lado recebe rank fictício 10000
 *   4. JOIN com chunks para recuperar campos, ORDER BY rrf_score DESC, LIMIT topK
 *
 * A constante k=60 é o valor padrão amplamente adotado. Chunks ausentes em um
 * dos rankings recebem rank fictício 10000 (praticamente zero de contribuição)
 * para garantir que chunks presentes nos dois rankings sejam promovidos.
 *
 * Os filtros de tenant/dept são aplicados DENTRO de cada CTE para garantir
 * isolamento multi-tenant desde o início da execução.
 * O filtro de filterDocumentIds é aplicado no JOIN final para evitar
 * duplicação de parâmetros entre os dois CTEs internos.
 *
 * Spec §9 (etapa 3 — busca híbrida $rankFusion → RRF manual).
 */
export async function hybridSearch(
  sql: Sql,
  params: HybridSearchParams
): Promise<ChunkSearchResult[]> {
  const {
    tenantId,
    tenantIds,
    allowedDepartmentIds,
    queryText,
    queryEmbedding,
    topK,
    filterDocumentIds,
  } = params;

  const embeddingLiteral = embeddingToLiteral(queryEmbedding);
  const candidateLimit = topK * 3;

  let paramIndex = 1;
  const bindings: (string | string[] | number)[] = [];

  bindings.push(queryText);
  const queryParam = paramIndex++;           // $1 — tsquery text

  bindings.push(embeddingLiteral);
  const embParam = paramIndex++;             // $2 — embedding literal

  bindings.push(candidateLimit);
  const candidateLimitParam = paramIndex++;  // $3 — LIMIT para cada CTE

  // Filtros comuns (aplicados identicamente em lexical_ranked e vector_ranked)
  let tenantFilter = '';
  if (tenantIds !== undefined && tenantIds.length > 0) {
    bindings.push(tenantIds);
    tenantFilter = ` AND tenant_id = ANY($${paramIndex++}::uuid[])`;
  } else if (tenantId !== undefined) {
    bindings.push(tenantId);
    tenantFilter = ` AND tenant_id = $${paramIndex++}::uuid`;
  }

  let deptFilter = '';
  if (allowedDepartmentIds !== null) {
    bindings.push(allowedDepartmentIds);
    deptFilter = ` AND department_id = ANY($${paramIndex++}::uuid[])`;
  }

  // filterDocumentIds aplicado no JOIN final (após o RRF)
  let docFilter = '';
  if (filterDocumentIds !== undefined && filterDocumentIds.length > 0) {
    bindings.push(filterDocumentIds);
    docFilter = ` AND c.document_id = ANY($${paramIndex++}::uuid[])`;
  }

  bindings.push(topK);
  const topKParam = paramIndex++;            // último parâmetro — LIMIT final

  const query = `
    WITH lexical_ranked AS (
      SELECT
        id AS chunk_id,
        ROW_NUMBER() OVER (
          ORDER BY ts_rank(text_search_pt, plainto_tsquery('portuguese', $${queryParam}::text)) DESC
        ) AS rnk
      FROM chunks
      WHERE text_search_pt @@ plainto_tsquery('portuguese', $${queryParam}::text)
        ${tenantFilter}
        ${deptFilter}
      LIMIT $${candidateLimitParam}
    ),
    vector_ranked AS (
      SELECT
        id AS chunk_id,
        ROW_NUMBER() OVER (
          ORDER BY embedding <=> $${embParam}::vector
        ) AS rnk
      FROM chunks
      WHERE 1=1
        ${tenantFilter}
        ${deptFilter}
      ORDER BY embedding <=> $${embParam}::vector
      LIMIT $${candidateLimitParam}
    ),
    rrf AS (
      SELECT
        COALESCE(l.chunk_id, v.chunk_id) AS chunk_id,
        (
          1.0 / (60 + COALESCE(l.rnk, 10000)) +
          1.0 / (60 + COALESCE(v.rnk, 10000))
        ) AS rrf_score
      FROM lexical_ranked l
      FULL OUTER JOIN vector_ranked v USING (chunk_id)
    )
    SELECT
      c.document_id        AS "documentId",
      c.tenant_id          AS "tenantId",
      c.department_id      AS "departmentId",
      c.document_type_name AS "documentTypeName",
      c.page_number        AS "pageNumber",
      c.chunk_index        AS "chunkIndex",
      c.text,
      c.token_count        AS "tokenCount",
      r.rrf_score          AS score
    FROM rrf r
    JOIN chunks c ON c.id = r.chunk_id
    WHERE 1=1
      ${docFilter}
    ORDER BY r.rrf_score DESC
    LIMIT $${topKParam}
  `;

  type Row = {
    documentId: string;
    tenantId: string;
    departmentId: string;
    documentTypeName: string | null;
    pageNumber: number | null;
    chunkIndex: number;
    text: string;
    tokenCount: number;
    score: number;
  };

  const rows = await sql.unsafe<Row[]>(query, bindings as UnsafeParams);
  return rows.map((r) => ({
    documentId: r.documentId,
    tenantId: r.tenantId,
    departmentId: r.departmentId,
    documentTypeName: r.documentTypeName,
    pageNumber: r.pageNumber,
    chunkIndex: r.chunkIndex,
    text: r.text,
    tokenCount: r.tokenCount,
    score: Number(r.score),
  }));
}
