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
// Allocator de parâmetros posicionais
// ---------------------------------------------------------------------------

/** Valores que podem ser passados como binding posicional para o postgres.js. */
export type SqlBindingValue = string | number | boolean | null | string[] | number[];

/**
 * Aloca parâmetros posicionais (`$1`, `$2`, ...) e acumula os bindings na mesma
 * ordem em que foram emitidos.
 *
 * Existe para permitir que predicados sejam montados por funções independentes
 * e depois inlinados em qualquer posição de uma query maior: quem monta o
 * fragmento não precisa saber quantos parâmetros já foram usados antes dele.
 */
export interface ParamAllocator {
  /**
   * Registra um valor e devolve o placeholder já formatado (ex.: `'$3'`).
   *
   * Chame UMA vez por valor e reutilize a string devolvida quando o mesmo valor
   * aparecer em mais de um fragmento — alocar duas vezes desloca todos os `$N`
   * seguintes e corrompe a query inteira.
   */
  add(value: SqlBindingValue): string;
  /** Bindings acumulados, na ordem de alocação. Passar direto ao `sql.unsafe`. */
  readonly bindings: SqlBindingValue[];
  /** Índice que a próxima chamada de `add` vai receber (1-based). */
  readonly next: number;
}

/**
 * Cria um allocator de parâmetros posicionais.
 *
 * O índice é derivado de `bindings.length`, e não de um contador paralelo: é
 * estruturalmente impossível alocar um placeholder sem empurrar o binding
 * correspondente (parâmetro sobrando/faltando é erro duro do Postgres —
 * `bind message supplies N parameters, but prepared statement requires M`).
 *
 * O padrão nasceu em `apps/api/src/routes/search.ts` (`addParam`) e foi trazido
 * para cá para ser usado por todas as funções de busca.
 */
export function createParamAllocator(): ParamAllocator {
  const bindings: SqlBindingValue[] = [];

  return {
    add(value: SqlBindingValue): string {
      bindings.push(value);
      return `$${bindings.length}`;
    },
    get bindings(): SqlBindingValue[] {
      return bindings;
    },
    get next(): number {
      return bindings.length + 1;
    },
  };
}

// ---------------------------------------------------------------------------
// Builders de predicado reutilizáveis
// ---------------------------------------------------------------------------

/**
 * Tamanho mínimo de uma palavra para participar da busca por metadados.
 *
 * Fica em 2 de propósito: subir para 3 quebraria buscas legítimas e comuns no
 * domínio ("NF", "CT", "OS").
 */
export const METADATA_MIN_WORD_LENGTH = 2;

/**
 * Quebra o texto da busca nas palavras usadas pelo predicado de metadados,
 * descartando as menores que `METADATA_MIN_WORD_LENGTH`.
 */
export function tokenizeMetadataQuery(queryText: string): string[] {
  return queryText
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= METADATA_MIN_WORD_LENGTH);
}

/**
 * Monta o predicado de casamento por metadados na tabela `documents`.
 *
 * Para cada palavra, casa (case-insensitive, por substring) contra:
 *   - `original_filename`
 *   - qualquer tag (`unnest(tags)`)
 *   - qualquer valor de índice (`jsonb_each_text(index_values)`), também na
 *     variante com `.` trocado por `,` — assim "1.234,56" e "1234.56"
 *     encontram um ao outro em campos numéricos digitados por humanos.
 *
 * As palavras são combinadas com OR (replica o regex alternado do MongoDB).
 * Cada palavra consome UM slot de parâmetro reutilizado nas quatro posições.
 *
 * Com a lista de palavras vazia o predicado degenera para `false` (nunca uma
 * string vazia, que produziria `AND ()` — erro de sintaxe).
 */
export function buildMetadataPredicate(words: string[], alloc: ParamAllocator): string {
  if (words.length === 0) return 'false';

  const wordParts = words.map((word) => {
    const p = alloc.add(word);
    return `(original_filename ILIKE '%' || ${p}::text || '%' OR EXISTS (SELECT 1 FROM unnest(tags) t WHERE t ILIKE '%' || ${p}::text || '%') OR EXISTS (SELECT 1 FROM jsonb_each_text(index_values) kv WHERE kv.value ILIKE '%' || ${p}::text || '%' OR REPLACE(kv.value, '.', ',') ILIKE '%' || ${p}::text || '%'))`;
  });

  return `(${wordParts.join(' OR ')})`;
}

/** Condições aceitas por campo de índice nos filtros estruturados. */
export interface StructuredIndexFilter {
  gte?: string | number | undefined;
  lte?: string | number | undefined;
  eq?: string | number | undefined;
}

/** Filtros estruturados aplicáveis sobre a tabela `documents`. */
export interface StructuredDocumentFilters {
  departmentIds?: string[] | undefined;
  documentTypeIds?: string[] | undefined;
  tags?: string[] | undefined;
  indexFilters?: Record<string, StructuredIndexFilter> | undefined;
}

/** Entradas do predicado de filtros estruturados sobre `documents`. */
export interface DocumentFilterPredicateParams {
  tenantId?: string | undefined;
  tenantIds?: string[] | undefined;
  allowedDepartmentIds: string[] | null;
  filters?: StructuredDocumentFilters | undefined;
}

/** Resultado da montagem do predicado de filtros estruturados. */
export interface DocumentFilterPredicate {
  /** Predicado pronto para o WHERE, sempre não vazio. Usa o alias `d`. */
  sql: string;
  /**
   * `true` quando os filtros são insatisfazíveis por construção (ex.: nenhum
   * dos departamentos pedidos está entre os permitidos). Quem chama deve
   * devolver lista vazia sem ir ao banco — o `sql` devolvido é `false`.
   */
  unsatisfiable: boolean;
}

/**
 * Indica se há algum filtro estruturado a aplicar. Sem nenhum, não faz sentido
 * resolver uma lista de documentIds (a busca fica sem restrição).
 */
export function hasStructuredDocumentFilters(
  filters: StructuredDocumentFilters | undefined
): boolean {
  return (
    filters !== undefined &&
    (filters.departmentIds !== undefined ||
      filters.documentTypeIds !== undefined ||
      (filters.tags !== undefined && filters.tags.length > 0) ||
      (filters.indexFilters !== undefined && Object.keys(filters.indexFilters).length > 0))
  );
}

/**
 * Monta o WHERE dos filtros estruturados sobre `documents` (alias `d`).
 *
 * Filtros JSONB para indexValues (spec §9 etapa 4 + §7 search):
 *   - TEXT/eq:    index_values->>'campo' = $val
 *   - NUMBER/gte: (index_values->>'campo')::numeric >= $val
 *   - NUMBER/lte: (index_values->>'campo')::numeric <= $val
 *   - DATE/gte:   (index_values->>'campo')::timestamptz >= $val::timestamptz
 *   - DATE/lte:   (index_values->>'campo')::timestamptz <= $val::timestamptz
 *   - tags:       tags @> $tags::text[]   (contém TODAS)
 *   - documentTypeIds: document_type_id = ANY($ids::uuid[])
 *
 * A distinção DATE × NUMBER é feita pelo formato do valor (`YYYY-MM-DD...`),
 * não pelo tipo declarado do campo — é o que a rota já fazia.
 */
export function buildDocumentFilterPredicate(
  params: DocumentFilterPredicateParams,
  alloc: ParamAllocator
): DocumentFilterPredicate {
  const { tenantId, tenantIds, allowedDepartmentIds, filters } = params;

  const conditions: string[] = [`d.deleted = false`, `d.status = 'READY'`];

  // Filtro de tenant
  if (tenantIds !== undefined && tenantIds.length > 0) {
    conditions.push(`d.tenant_id = ANY(${alloc.add(tenantIds)}::uuid[])`);
  } else if (tenantId !== undefined) {
    conditions.push(`d.tenant_id = ${alloc.add(tenantId)}`);
  }

  // Filtro de departamentos (interseção entre o pedido e o permitido)
  if (filters?.departmentIds !== undefined) {
    const requested = filters.departmentIds;
    let effective: string[];
    if (allowedDepartmentIds !== null) {
      effective = requested.filter((id) => allowedDepartmentIds.includes(id));
      if (effective.length === 0) return { sql: 'false', unsatisfiable: true };
    } else {
      effective = requested;
    }
    conditions.push(`d.department_id = ANY(${alloc.add(effective)}::uuid[])`);
  } else if (allowedDepartmentIds !== null) {
    conditions.push(`d.department_id = ANY(${alloc.add(allowedDepartmentIds)}::uuid[])`);
  }

  // Filtro de documentTypeIds
  if (filters?.documentTypeIds !== undefined && filters.documentTypeIds.length > 0) {
    conditions.push(`d.document_type_id = ANY(${alloc.add(filters.documentTypeIds)}::uuid[])`);
  }

  // Filtro de tags: contém TODAS as tags pedidas
  if (filters?.tags !== undefined && filters.tags.length > 0) {
    conditions.push(`d.tags @> ${alloc.add(filters.tags)}::text[]`);
  }

  // Filtros de indexValues (JSONB)
  if (filters?.indexFilters !== undefined) {
    for (const [fieldName, condition] of Object.entries(filters.indexFilters)) {
      if (condition.eq !== undefined) {
        conditions.push(
          `d.index_values->>${alloc.add(fieldName)} = ${alloc.add(String(condition.eq))}`
        );
      }
      if (condition.gte !== undefined) {
        const val = condition.gte;
        if (isDateFilterValue(val)) {
          conditions.push(
            `(d.index_values->>${alloc.add(fieldName)})::timestamptz >= ${alloc.add(val)}::timestamptz`
          );
        } else {
          conditions.push(
            `(d.index_values->>${alloc.add(fieldName)})::numeric >= ${alloc.add(val)}`
          );
        }
      }
      if (condition.lte !== undefined) {
        const val = condition.lte;
        if (isDateFilterValue(val)) {
          conditions.push(
            `(d.index_values->>${alloc.add(fieldName)})::timestamptz <= ${alloc.add(val)}::timestamptz`
          );
        } else {
          conditions.push(
            `(d.index_values->>${alloc.add(fieldName)})::numeric <= ${alloc.add(val)}`
          );
        }
      }
    }
  }

  return { sql: conditions.join(' AND '), unsatisfiable: false };
}

/** Um valor de filtro é tratado como data quando começa em `YYYY-MM-DD`. */
function isDateFilterValue(value: string | number): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value);
}

/**
 * Semi-join que amarra um chunk ao documento VIVO correspondente
 * (`deleted = false` e `status = 'READY'`).
 *
 * POR QUE EXISTE (T-99). As buscas por chunk liam `chunks` direto, sem tocar em
 * `documents`. A única coisa que barrava um chunk de documento excluído era o
 * `filterDocumentIds` que a rota resolve a partir de `documents` — e ele é
 * `null` sempre que a busca não traz filtro estruturado, que é o caso da busca
 * livre e do RAG. Medido: documento com `deleted = true` cujo chunk foi
 * reinserido depois (o worker termina a ingestão DEPOIS da exclusão) voltava em
 * `lexicalSearch`, `vectorSearch` e `hybridSearch`, com o TEXTO — que no RAG
 * entra no prompt do LLM. `searchDocumentsPaged` nunca vazou porque a CTE
 * `merged` já semi-junta com `filtered`, que carrega os dois predicados; este
 * builder leva a mesma garantia para o caminho por chunk.
 *
 * O predicado vale SEMPRE, independente de `filterDocumentIds`: a barreira não
 * pode depender de a requisição ter filtros.
 *
 * Forma: `EXISTS` correlacionado pela PK de `documents`, de propósito. O planner
 * o converte em semi-join e, com a tabela de documentos grande, resolve cada
 * candidato por `Memoize` + `documents_pkey` — nested loop, que PRESERVA a ordem
 * do lado externo e por isso não inviabiliza nem o corte por `ts_rank` nem o
 * índice HNSW do lado vetorial.
 *
 * MEDIDO com EXPLAIN (ANALYZE, BUFFERS) em base descartável — 24.000 chunks,
 * 202.000 documentos, 10% de chunks órfãos, PG16 + pgvector 0.8.3 — mediana de
 * 5 execuções, antes → depois:
 *
 *   busca de UMA empresa (o caso de todo dia)
 *     lexicalSearch  0,47 → 0,91 ms   mesmo `chunks_fts_tenant_gin`, mais um
 *                                     nested loop de 240 lookups por PK
 *     vectorSearch   9,07 → 0,37 ms   o plano TROCOU: o custo do semi-join sobre
 *                                     1.200 linhas tornou o caminho "varre o
 *                                     tenant inteiro e ordena" mais caro que o
 *                                     HNSW, que passou a ser usado
 *     hybridSearch   6,39 → 1,73 ms   mesma forma (2 CTEs → FULL OUTER JOIN),
 *                                     com o semi-join DENTRO das duas, antes do
 *                                     LIMIT de topK*3
 *
 *   SUPER_ADMIN sem filtro de tenant (pior caso, termo pouco seletivo)
 *     lexicalSearch  6,13 → 10,64 ms  4.800 candidatos × lookup memoizado
 *     vectorSearch   0,35 → 0,36 ms   HNSW preservado (22 linhas do índice para
 *                                     devolver 20 — o filtro é aplicado sobre o
 *                                     fluxo do índice, não depois dele)
 *     hybridSearch   8,58 → 11,56 ms
 *
 * Com a tabela de documentos pequena (1.800 linhas) o planner prefere hash
 * semi-join com seq scan em `documents`; é escolha de custo e se corrige sozinha
 * conforme a tabela cresce — foi o que se observou ao passar de 1.800 para
 * 202.000 documentos.
 *
 * RESÍDUO CONHECIDO (não introduzido aqui, mas exposto por esta medição): com o
 * lado vetorial servido pelo HNSW e `hnsw.ef_search` no padrão 40, um filtro
 * seletivo faz o índice devolver MENOS candidatos que o `topK*3` pedido (27 de
 * 60 na medição por empresa). É a limitação conhecida de busca vetorial filtrada
 * do pgvector — `hnsw.iterative_scan` está `off`. Avaliar em tarefa própria,
 * com NDCG/MRR medido; não mexer aqui.
 *
 * `chunkAlias` é o nome pelo qual a tabela `chunks` é referenciada no escopo
 * onde o fragmento for inlinado (`chunks` quando sem alias, `c` no JOIN final da
 * híbrida). Não gasta parâmetro: os dois valores são constantes literais.
 */
export function buildLiveDocumentPredicate(chunkAlias = 'chunks'): string {
  return `EXISTS (SELECT 1 FROM documents ld WHERE ld.id = ${chunkAlias}.document_id AND ld.deleted = false AND ld.status = 'READY')`;
}

// ---------------------------------------------------------------------------
// documentMetadataSearch
// ---------------------------------------------------------------------------

/**
 * Busca documentos na tabela `documents` pelos campos `original_filename` e `tags`.
 *
 * Tokeniza a query em palavras (≥ 2 chars) e para cada palavra verifica:
 *   original_filename ILIKE '%word%'  OR  alguma tag ILIKE '%word%'
 *   OR  algum valor de índice ILIKE '%word%'
 *
 * O casamento por TAG é case-insensitive e por substring (via `unnest(tags)` +
 * `ILIKE`), não igualdade exata — assim digitar parte de uma tag confirmada na
 * busca livre já traz o documento (Fase 9 / E-3, tags como material buscável).
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

  const words = tokenizeMetadataQuery(queryText);

  if (words.length === 0) return [];

  const alloc = createParamAllocator();

  // Predicado de metadados compartilhado com o restante do pipeline de busca.
  let whereClause = `deleted = false AND status = 'READY' AND ${buildMetadataPredicate(words, alloc)}`;

  // Filtro de tenant
  if (tenantIds !== undefined && tenantIds.length > 0) {
    whereClause += ` AND tenant_id = ANY(${alloc.add(tenantIds)}::uuid[])`;
  } else if (tenantId !== undefined) {
    whereClause += ` AND tenant_id = ${alloc.add(tenantId)}::uuid`;
  }

  // Filtro de departamento
  if (allowedDepartmentIds !== null) {
    whereClause += ` AND department_id = ANY(${alloc.add(allowedDepartmentIds)}::uuid[])`;
  }

  // Filtro de documentos pré-filtrados
  if (filterDocumentIds !== undefined && filterDocumentIds.length > 0) {
    whereClause += ` AND id = ANY(${alloc.add(filterDocumentIds)}::uuid[])`;
  }

  const query = `SELECT id FROM documents WHERE ${whereClause} LIMIT 10`;

  type Row = { id: string };
  const rows = await sql.unsafe<Row[]>(query, alloc.bindings as UnsafeParams);
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
 * Só devolve chunks de documento vivo e `READY` — ver
 * `buildLiveDocumentPredicate` (T-99).
 *
 * Spec §9 (etapa 3 — busca lexical).
 */
export async function lexicalSearch(
  sql: Sql,
  params: LexicalSearchParams
): Promise<ChunkSearchResult[]> {
  const { tenantId, tenantIds, allowedDepartmentIds, queryText, topK, filterDocumentIds } = params;

  const alloc = createParamAllocator();

  const queryParam = alloc.add(queryText); // $1 — tsquery

  let whereClause = `text_search_pt @@ plainto_tsquery('portuguese', ${queryParam}::text)`;

  // Documento vivo e READY — sempre, mesmo sem filtros estruturados (T-99).
  whereClause += ` AND ${buildLiveDocumentPredicate()}`;

  // Filtro de tenant
  if (tenantIds !== undefined && tenantIds.length > 0) {
    whereClause += ` AND tenant_id = ANY(${alloc.add(tenantIds)}::uuid[])`;
  } else if (tenantId !== undefined) {
    whereClause += ` AND tenant_id = ${alloc.add(tenantId)}::uuid`;
  }

  // Filtro de departamento
  if (allowedDepartmentIds !== null) {
    whereClause += ` AND department_id = ANY(${alloc.add(allowedDepartmentIds)}::uuid[])`;
  }

  // Filtro de documentos pré-filtrados
  if (filterDocumentIds !== undefined && filterDocumentIds.length > 0) {
    whereClause += ` AND document_id = ANY(${alloc.add(filterDocumentIds)}::uuid[])`;
  }

  const limitParam = alloc.add(topK);

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
      ts_rank(text_search_pt, plainto_tsquery('portuguese', ${queryParam}::text)) AS score
    FROM chunks
    WHERE ${whereClause}
    ORDER BY score DESC
    LIMIT ${limitParam}
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

  const rows = await sql.unsafe<Row[]>(query, alloc.bindings as UnsafeParams);
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
// searchDocumentsPaged
// ---------------------------------------------------------------------------

/**
 * Teto de documentos trazidos pelo ramo de metadados numa mesma busca.
 *
 * O ramo de metadados é um OR de `ILIKE '%palavra%'` — não tem índice e não tem
 * ranking: todo documento que casa vale exatamente o mesmo (score 0). Sem teto,
 * uma palavra genérica ("nota") varreria a tabela inteira de `documents` a cada
 * página. 200 é generoso o bastante para que o ramo continue útil como rede de
 * segurança (o valor anterior era 10, em `documentMetadataSearch`).
 */
export const METADATA_BRANCH_LIMIT = 200;

/**
 * Um resultado de DOCUMENTO da busca lexical paginada.
 *
 * Mesmo formato de campos de `ChunkSearchResult` — o consumidor continua
 * montando um `SearchChunk` —, porém com semântica diferente: há no máximo UMA
 * linha por documento, e os campos de chunk (`text`, `chunkIndex`, `pageNumber`,
 * `tokenCount`, `documentTypeName`) descrevem o MELHOR chunk daquele documento
 * para a query.
 *
 * `score` é o `max(ts_rank(...))` entre os chunks do documento. Documento que
 * entrou só pelo ramo de metadados tem `score = 0`.
 *
 * Documento READY sem nenhum chunk (PDF escaneado sem texto extraível —
 * `apps/worker/src/pipeline/persist.ts` só insere quando há chunks) que case por
 * metadado APARECE no resultado, com `text: ''`, `chunkIndex: 0`,
 * `tokenCount: 0`, `pageNumber: null` e `documentTypeName: null`. É mudança de
 * comportamento intencional: antes ele sumia silenciosamente.
 */
export interface DocumentSearchResult {
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
 * Parâmetros da busca lexical paginada por documento.
 *
 * `structuredFilter` substitui o antigo `filterDocumentIds`: os filtros viram a
 * CTE `filtered` dentro da própria query, em vez de uma lista de UUIDs
 * materializada no Node e devolvida ao Postgres a cada página.
 *
 * `page` é 1-based.
 */
export interface PagedDocumentSearchParams {
  tenantId?: string | undefined;
  tenantIds?: string[] | undefined;
  allowedDepartmentIds: string[] | null;
  structuredFilter?: StructuredDocumentFilters | undefined;
  queryText: string;
  page: number;
  pageSize: number;
}

/** Página de documentos + total exato de documentos que casam com a busca. */
export interface PagedDocumentSearchResult {
  items: DocumentSearchResult[];
  /** Documentos distintos (conteúdo ∪ metadados) que casam — NÃO é nº de chunks. */
  total: number;
}

/** Linha crua devolvida pela query paginada. */
type PagedRow = {
  documentId: string;
  tenantId: string;
  departmentId: string;
  documentTypeName: string | null;
  pageNumber: number | null;
  chunkIndex: number;
  text: string;
  tokenCount: number;
  score: number;
  /** `count(*) OVER ()` é int8 — chega como string no postgres.js. */
  total: string;
};

/**
 * Busca lexical PAGINADA POR DOCUMENTO, com total exato.
 *
 * Unifica numa única query os dois ramos que antes eram consultas separadas e
 * truncadas (`lexicalSearch` + `documentMetadataSearch`) e devolve uma página de
 * documentos — não de chunks — junto do total de documentos que casam.
 *
 * Forma da query (a ORDEM dos estágios é o que garante corretude e desempenho):
 *
 *   filtered → filtros estruturados + tenant + dept + deleted + READY
 *   content  → HashAggregate `GROUP BY document_id`: 1 linha por documento
 *   meta     → ramo de metadados (ILIKE em filename/tags/indexValues), com teto
 *   merged   → UNION ALL + `max(score)` + semi-join de `filtered`: dedup por
 *              construção, conteúdo vence metadado
 *   paged    → MATERIALIZED: corta a página ANTES de tocar em `chunks.text`
 *   final    → LEFT JOIN LATERAL do melhor chunk, só para as linhas da página
 *
 * Invariantes que NÃO podem ser "otimizados" (cada um é um defeito real):
 *
 * - **`AS MATERIALIZED` na CTE `paged`**: CTE referenciada uma única vez é
 *   inlined por padrão desde o PG12. Sem o `MATERIALIZED`, nada garante que o
 *   `LIMIT` seja aplicado antes do join e o `text` de TODOS os documentos
 *   casados seja lido e destoastado a cada página (dezenas de MB por request).
 *   Medido no PG16 os dois planos coincidem — o `LIMIT` já impede o pullup da
 *   subquery —, mas a barreira é explícita e custa um tuplestore de `pageSize`
 *   linhas: fica.
 * - **Semi-join de `filtered` ANTES do `count(*) OVER ()`**: o filtro
 *   estruturado precisa estar aplicado antes da contagem e do `LIMIT`. Ele vive
 *   em `merged` (sempre) e, quando há filtros de fato, também é empurrado para
 *   dentro de `content` — ver o comentário no corpo da função.
 * - **`GROUP BY max(ts_rank)` em vez de `ROW_NUMBER() OVER (PARTITION BY ...)`**:
 *   o window function forçaria sort completo dos N chunks casados (spill em
 *   disco acima do `work_mem`); o `GROUP BY` vira HashAggregate O(N) com hash
 *   table do tamanho de N_docs.
 * - **Tenant e departamento DENTRO de todas as CTEs**: no join final (depois do
 *   `LIMIT`) eles filtrariam o item mas contariam documentos proibidos no
 *   `total` — vazamento por contagem, mesmo sem vazar o item.
 * - **Tiebreaker `document_id ASC` em todo `ORDER BY` de ranking**: sem ele,
 *   scores empatados (e o ramo de metadados empata TUDO em 0) produzem itens
 *   duplicados ou ausentes entre páginas.
 * - **`tenant_id`/`department_id` vêm de `documents`**, nunca do chunk:
 *   `chunks.tenant_id` é cópia congelada do momento da ingestão.
 * - **`count(*) OVER ()` é int8** e chega como string no postgres.js —
 *   convertido com `parseInt` (mesmo padrão de `routes/documents.ts`).
 *
 * `plainto_tsquery` é STABLE, não IMMUTABLE: cada ocorrência textual é
 * reavaliada por linha. Aparece o mínimo possível (3x: filtro do `content`,
 * ranking do `content`, ranking do LATERAL).
 */
export async function searchDocumentsPaged(
  sql: Sql,
  params: PagedDocumentSearchParams
): Promise<PagedDocumentSearchResult> {
  const { tenantId, tenantIds, allowedDepartmentIds, structuredFilter, queryText } = params;

  const page = Math.max(1, Math.trunc(params.page));
  const pageSize = Math.max(1, Math.trunc(params.pageSize));
  const offset = (page - 1) * pageSize;

  const alloc = createParamAllocator();

  // --- CTE `filtered`: filtros estruturados + tenant + dept + deleted + READY.
  // Usa o alias `d`, como o builder espera.
  const predicate = buildDocumentFilterPredicate(
    { tenantId, tenantIds, allowedDepartmentIds, filters: structuredFilter },
    alloc
  );

  // Filtros insatisfazíveis por construção (ex.: nenhum departamento pedido é
  // permitido): nenhum documento pode passar, não vale ir ao banco.
  if (predicate.unsatisfiable) {
    return { items: [], total: 0 };
  }

  const queryParam = alloc.add(queryText);
  const tsQuery = `plainto_tsquery('portuguese', ${queryParam}::text)`;

  // Fragmentos de tenant/dept montados UMA vez e reusados em `content` e `meta`.
  // Alocar por CTE duplicaria o parâmetro. As colunas se chamam igual em
  // `chunks` e em `documents`, então o mesmo fragmento serve às duas.
  let tenantFilter = '';
  if (tenantIds !== undefined && tenantIds.length > 0) {
    tenantFilter = ` AND tenant_id = ANY(${alloc.add(tenantIds)}::uuid[])`;
  } else if (tenantId !== undefined) {
    tenantFilter = ` AND tenant_id = ${alloc.add(tenantId)}::uuid`;
  }

  let deptFilter = '';
  if (allowedDepartmentIds !== null) {
    deptFilter = ` AND department_id = ANY(${alloc.add(allowedDepartmentIds)}::uuid[])`;
  }

  // --- CTE `meta`: predicado de metadados inlinado (mesmo de documentMetadataSearch).
  const metadataPredicate = buildMetadataPredicate(tokenizeMetadataQuery(queryText), alloc);

  // Semi-join de `filtered` DENTRO do ramo de conteúdo: só quando há filtros
  // estruturados de fato. Medido com EXPLAIN (ANALYZE, BUFFERS), 75k chunks:
  //
  //   com semi-join sempre → o planner multiplica a seletividade de tenant/dept
  //   duas vezes (uma no predicado sobre `chunks`, outra na de `filtered` sobre
  //   `documents`), estima 1440 linhas onde há 8330, conclui que cada grupo tem
  //   1 linha e troca o HashAggregate por Sort + GroupAggregate — um sort de
  //   N_CHUNKS carregando o `text_search_pt` (width 799):
  //     Sort Method: external merge  Disk: 6584kB   → 46 ms
  //
  //   sem o semi-join redundante → estimativa de grupos correta (2997) e
  //   HashAggregate: 15 ms, zero temp.
  //
  // Sem filtros estruturados o semi-join não restringe nada além do que
  // tenant/dept já restringem (mais `deleted`/`READY`, que `merged` reaplica),
  // então sai. Com filtros estruturados ele é genuinamente seletivo e o
  // pushdown vale mais que a estimativa.
  //
  // O semi-join OBRIGATÓRIO — o que garante que nenhum documento fora dos
  // filtros seja contado — vive em `merged`, ainda ANTES do `count(*) OVER ()`
  // e do LIMIT. Nunca no join final.
  const contentSemiJoin = hasStructuredDocumentFilters(structuredFilter)
    ? `
        AND document_id IN (SELECT id FROM filtered)`
    : '';

  // Prefixo comum às duas queries (página e contagem de fallback). Precisa ser
  // fechado ANTES de alocar LIMIT/OFFSET: a query de fallback não os referencia
  // e o Postgres rejeita bind com parâmetros sobrando.
  const cteBlock = `
    WITH filtered AS (
      SELECT d.id
      FROM documents d
      WHERE ${predicate.sql}
    ),
    content AS MATERIALIZED (
      SELECT
        document_id,
        max(ts_rank(text_search_pt, ${tsQuery}))::float8 AS score
      FROM chunks
      WHERE text_search_pt @@ ${tsQuery}${tenantFilter}${deptFilter}${contentSemiJoin}
      GROUP BY document_id
    ),
    meta AS MATERIALIZED (
      SELECT
        id AS document_id,
        0::float8 AS score
      FROM documents
      WHERE deleted = false
        AND status = 'READY'
        AND ${metadataPredicate}${tenantFilter}${deptFilter}
        AND id IN (SELECT id FROM filtered)
      LIMIT ${METADATA_BRANCH_LIMIT}
    ),
    merged AS (
      SELECT document_id, max(score) AS score
      FROM (
        SELECT document_id, score FROM content
        UNION ALL
        SELECT document_id, score FROM meta
      ) u
      WHERE document_id IN (SELECT id FROM filtered)
      GROUP BY document_id
    )`;

  const bindingsWithoutPaging = [...alloc.bindings];

  const limitParam = alloc.add(pageSize);
  const offsetParam = alloc.add(offset);

  const query = `${cteBlock},
    paged AS MATERIALIZED (
      SELECT
        document_id,
        score,
        count(*) OVER () AS total
      FROM merged
      ORDER BY score DESC, document_id ASC
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
    )
    SELECT
      p.document_id                     AS "documentId",
      d.tenant_id                       AS "tenantId",
      d.department_id                   AS "departmentId",
      best.document_type_name           AS "documentTypeName",
      best.page_number                  AS "pageNumber",
      COALESCE(best.chunk_index, 0)     AS "chunkIndex",
      COALESCE(best.text, '')           AS text,
      COALESCE(best.token_count, 0)     AS "tokenCount",
      p.score                           AS score,
      p.total                           AS total
    FROM paged p
    JOIN documents d ON d.id = p.document_id
    LEFT JOIN LATERAL (
      SELECT c.chunk_index, c.page_number, c.text, c.token_count, c.document_type_name
      FROM chunks c
      WHERE c.document_id = p.document_id
      ORDER BY ts_rank(c.text_search_pt, ${tsQuery}) DESC, c.chunk_index ASC
      LIMIT 1
    ) best ON true
    ORDER BY p.score DESC, p.document_id ASC
  `;

  const rows = await sql.unsafe<PagedRow[]>(query, alloc.bindings as UnsafeParams);

  const items: DocumentSearchResult[] = rows.map((r) => ({
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

  // `count(*) OVER ()` só existe se a página trouxe alguma linha. Numa página
  // além do fim (OFFSET > total) o resultado é vazio e o total se perderia —
  // devolver 0 ali faria o front dizer "nenhum resultado" para uma busca que
  // tem resultados. Só nesse caso pagamos uma segunda ida ao banco.
  let total: number;
  if (rows.length > 0) {
    total = parseInt(rows[0]!.total, 10);
  } else if (offset > 0) {
    const countRows = await sql.unsafe<Array<{ total: string }>>(
      `${cteBlock}
      SELECT count(*) AS total FROM merged`,
      bindingsWithoutPaging as UnsafeParams
    );
    total = parseInt(countRows[0]?.total ?? '0', 10);
  } else {
    total = 0;
  }

  return { items, total };
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
 * Só devolve chunks de documento vivo e `READY` — ver
 * `buildLiveDocumentPredicate` (T-99).
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

  const alloc = createParamAllocator();

  const embParam = alloc.add(embeddingLiteral); // $1 — embedding literal

  let whereClause = '1=1';

  // Documento vivo e READY — sempre, mesmo sem filtros estruturados (T-99).
  whereClause += ` AND ${buildLiveDocumentPredicate()}`;

  // Filtro de tenant
  if (tenantIds !== undefined && tenantIds.length > 0) {
    whereClause += ` AND tenant_id = ANY(${alloc.add(tenantIds)}::uuid[])`;
  } else if (tenantId !== undefined) {
    whereClause += ` AND tenant_id = ${alloc.add(tenantId)}::uuid`;
  }

  // Filtro de departamento
  if (allowedDepartmentIds !== null) {
    whereClause += ` AND department_id = ANY(${alloc.add(allowedDepartmentIds)}::uuid[])`;
  }

  // Filtro de documentos pré-filtrados
  if (filterDocumentIds !== undefined && filterDocumentIds.length > 0) {
    whereClause += ` AND document_id = ANY(${alloc.add(filterDocumentIds)}::uuid[])`;
  }

  const limitParam = alloc.add(topK);

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
      1 - (embedding <=> ${embParam}::vector) AS score
    FROM chunks
    WHERE ${whereClause}
    ORDER BY embedding <=> ${embParam}::vector
    LIMIT ${limitParam}
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

  const rows = await sql.unsafe<Row[]>(query, alloc.bindings as UnsafeParams);
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
 *   1. lexical_ranked: corta topK*3 candidatos por ts_rank DESC, id ASC e
 *                      numera os sobreviventes com ROW_NUMBER
 *   2. vector_ranked:  corta topK*3 candidatos por embedding <=> ASC e numera
 *                      os sobreviventes com ROW_NUMBER
 *   3. rrf:            FULL OUTER JOIN em chunk_id
 *                      rrf_score = 1/(60+rank_l) + 1/(60+rank_v)
 *                      chunk ausente em um lado recebe rank fictício 10000
 *   4. JOIN com chunks para recuperar campos, ORDER BY rrf_score DESC, LIMIT topK
 *
 * A constante k=60 é o valor padrão amplamente adotado. Chunks ausentes em um
 * dos rankings recebem rank fictício 10000 (praticamente zero de contribuição)
 * para garantir que chunks presentes nos dois rankings sejam promovidos.
 *
 * DETERMINISMO (T-60). Cada CTE tem duas etapas separadas de propósito: uma
 * subquery que CORTA (ORDER BY ... LIMIT topK*3) e um ROW_NUMBER que NUMERA os
 * sobreviventes. Antes da T-60 as duas eram a mesma etapa, e faltava
 * tiebreaker: o CTE lexical nem ORDER BY de statement tinha antes do `LIMIT`
 * (o Postgres podia devolver quaisquer topK*3 linhas) e as duas janelas
 * empatavam sem critério de desempate. Resultado: com empate de `ts_rank`
 * (comum — chunks com o mesmo texto) ou de distância cosine, o rank saía da
 * ordem física das linhas, o `rrf_score` saía junto, e a MESMA busca devolvia
 * ordens diferentes entre execuções.
 *
 * Hoje: a numeração é sempre determinística (`, chunk_id ASC` nas duas janelas)
 * e o ORDER BY final termina em `, c.id ASC`.
 *
 * Por que o corte vetorial NÃO leva `, id` no ORDER BY: `ORDER BY embedding <=>
 * $emb` sozinho é a única forma que o índice HNSW consegue servir. Medido em
 * 20k chunks com o índice forçado: `ORDER BY dist` usa o HNSW em 2,2 ms;
 * `ORDER BY dist, id` torna o plano HNSW impossível e cai para varredura
 * completa + sort, ~125 ms. Por isso o desempate por id fica na JANELA (que
 * roda sobre os ≤ topK*3 candidatos já cortados, onde custa zero) e não no
 * corte. Consequência assumida: sob empate EXATO de distância bem na fronteira
 * do corte, quais linhas entram no pool ainda depende do plano — resíduo
 * aceitável num índice que já é aproximado por construção. O lado lexical não
 * tem esse dilema (nenhum índice fornece ordem de `ts_rank`), então lá o
 * desempate por id entra também no corte.
 *
 * FILTROS. tenant/dept, `filterDocumentIds` e o semi-join de documento vivo
 * (`buildLiveDocumentPredicate`, T-99) são aplicados DENTRO de cada CTE, antes
 * do corte de `topK*3` candidatos. Aplicar o filtro de documentos só no JOIN
 * final (como era até T-60) descartava resultados válidos: os candidatos eram
 * escolhidos ignorando o filtro e podiam não conter nenhum documento que
 * passasse nele, devolvendo menos que `topK` — às vezes zero — mesmo havendo
 * muitos chunks elegíveis. O mesmo placeholder `$N` é reusado nas três
 * posições (allocator da T-58), então empurrar o filtro para dentro não
 * duplica binding nem desloca a numeração.
 *
 * Esta função NÃO pagina (sem offset/cursor): paginação de vector/hybrid exige
 * pool de candidatos fixo e `hnsw.ef_search` por página — dívida técnica
 * registrada à parte (T-68).
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

  const alloc = createParamAllocator();

  const queryParam = alloc.add(queryText);              // $1 — tsquery text
  const embParam = alloc.add(embeddingLiteral);         // $2 — embedding literal
  const candidateLimitParam = alloc.add(candidateLimit); // $3 — LIMIT para cada CTE

  // Filtros comuns (aplicados identicamente em lexical_ranked e vector_ranked).
  // O fragmento é montado UMA vez e a mesma string de placeholder é reusada nas
  // duas CTEs — alocar por CTE duplicaria o parâmetro.
  let tenantFilter = '';
  if (tenantIds !== undefined && tenantIds.length > 0) {
    tenantFilter = ` AND tenant_id = ANY(${alloc.add(tenantIds)}::uuid[])`;
  } else if (tenantId !== undefined) {
    tenantFilter = ` AND tenant_id = ${alloc.add(tenantId)}::uuid`;
  }

  let deptFilter = '';
  if (allowedDepartmentIds !== null) {
    deptFilter = ` AND department_id = ANY(${alloc.add(allowedDepartmentIds)}::uuid[])`;
  }

  // filterDocumentIds entra DENTRO das duas CTEs (antes do corte de candidatos)
  // e é repetido no JOIN final. As três posições reusam o MESMO placeholder —
  // uma segunda chamada de `alloc.add` deslocaria todos os `$N` seguintes.
  let docFilter = '';
  let docFilterAliased = '';
  if (filterDocumentIds !== undefined && filterDocumentIds.length > 0) {
    const docParam = alloc.add(filterDocumentIds);
    docFilter = ` AND document_id = ANY(${docParam}::uuid[])`;
    docFilterAliased = ` AND c.document_id = ANY(${docParam}::uuid[])`;
  }

  const topKParam = alloc.add(topK); // último parâmetro — LIMIT final

  // Documento vivo e READY. Entra nas DUAS CTEs, ANTES do corte de topK*3
  // (T-99): aplicado só no JOIN final, um chunk de documento excluído ainda
  // ocuparia uma vaga do pool de candidatos e sumiria depois, devolvendo menos
  // que topK e degradando o recall sem ninguém perceber — o mesmo defeito que a
  // T-60 corrigiu para `filterDocumentIds`. A repetição no JOIN final é
  // redundante por construção (todo chunk_id do RRF veio de uma das CTEs) e
  // custa um semi-join sobre ≤ topK*3 linhas; fica como segunda barreira, no
  // mesmo espírito de `docFilterAliased`.
  const liveDocFilter = ` AND ${buildLiveDocumentPredicate()}`;
  const liveDocFilterAliased = ` AND ${buildLiveDocumentPredicate('c')}`;

  const query = `
    WITH lexical_ranked AS (
      SELECT
        chunk_id,
        ROW_NUMBER() OVER (ORDER BY lex_rank DESC, chunk_id ASC) AS rnk
      FROM (
        SELECT
          id AS chunk_id,
          ts_rank(text_search_pt, plainto_tsquery('portuguese', ${queryParam}::text)) AS lex_rank
        FROM chunks
        WHERE text_search_pt @@ plainto_tsquery('portuguese', ${queryParam}::text)
          ${tenantFilter}
          ${deptFilter}
          ${docFilter}
          ${liveDocFilter}
        ORDER BY lex_rank DESC, id ASC
        LIMIT ${candidateLimitParam}
      ) l
    ),
    vector_ranked AS (
      SELECT
        chunk_id,
        ROW_NUMBER() OVER (ORDER BY dist ASC, chunk_id ASC) AS rnk
      FROM (
        SELECT
          id AS chunk_id,
          embedding <=> ${embParam}::vector AS dist
        FROM chunks
        WHERE 1=1
          ${tenantFilter}
          ${deptFilter}
          ${docFilter}
          ${liveDocFilter}
        ORDER BY embedding <=> ${embParam}::vector
        LIMIT ${candidateLimitParam}
      ) v
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
      ${docFilterAliased}
      ${liveDocFilterAliased}
    ORDER BY r.rrf_score DESC, c.id ASC
    LIMIT ${topKParam}
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

  const rows = await sql.unsafe<Row[]>(query, alloc.bindings as UnsafeParams);
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
