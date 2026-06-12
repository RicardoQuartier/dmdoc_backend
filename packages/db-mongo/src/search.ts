import type { Db } from 'mongodb';
import { z } from 'zod';

/**
 * Um resultado de chunk retornado pelas buscas (lexical, vetorial ou híbrida).
 *
 * `score` é o score de relevância atribuído pelo motor de busca (pode ser
 * normalizado pelo $rankFusion na busca híbrida). Não faz parte do ChunkSchema
 * de negócio pois é artefato da query, não do documento armazenado.
 */
export const ChunkSearchResultSchema = z.object({
  documentId: z.string(),
  tenantId: z.string(),
  departmentId: z.string(),
  documentTypeName: z.string().nullable(),
  pageNumber: z.number().nullable(),
  chunkIndex: z.number(),
  text: z.string(),
  tokenCount: z.number(),
  score: z.number(),
});

export type ChunkSearchResult = z.infer<typeof ChunkSearchResultSchema>;

/**
 * Parâmetros comuns às buscas lexical, vetorial e híbrida.
 *
 * `tenantId`: tenant único (mode: 'single' / 'all'). Mutuamente exclusivo com `tenantIds`.
 * `tenantIds`: lista de tenants (mode: 'allowed' — MULTI_TENANT_ADMIN). Quando presente,
 *   o filtro de tenant nos pipelines usa `$in` em vez de igualdade simples.
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
  /** Usado quando mode === 'allowed' (MULTI_TENANT_ADMIN): filtra por $in. */
  tenantIds?: string[];
  allowedDepartmentIds: string[] | null;
  filterDocumentIds?: string[];
  topK: number;
}

/**
 * Parâmetros para busca lexical via Atlas Search ($search).
 */
export interface LexicalSearchParams extends SearchParams {
  queryText: string;
}

/**
 * Parâmetros para busca vetorial via Atlas Vector Search ($vectorSearch).
 */
export interface VectorSearchParams extends SearchParams {
  queryEmbedding: number[];
  /**
   * Candidatos para o índice HNSW antes do filtro topK.
   * Maior = mais recall, menor = mais rápido. Padrão: topK * 10 (mín 100).
   */
  numCandidates?: number;
}

/**
 * Parâmetros para busca híbrida via $rankFusion (combina lexical + vetorial).
 */
export interface HybridSearchParams extends SearchParams {
  queryText: string;
  queryEmbedding: number[];
  numCandidates?: number;
}

/**
 * Monta o filtro de tenant para uso nos pipelines de busca.
 *
 * - `tenantId` (string): filtro de igualdade simples — mode 'single'.
 * - `tenantIds` (string[]): filtro `$in` — mode 'allowed' (MULTI_TENANT_ADMIN).
 * - Nenhum dos dois: sem restrição de tenant — mode 'all' (SUPER_ADMIN global).
 *
 * A invariante de isolamento multi-tenant é preservada: nunca retorna chunks
 * de tenants fora do escopo do usuário autenticado (spec §10, invariante 5).
 */
function buildTenantFilter(
  tenantId: string | undefined,
  tenantIds: string[] | undefined
): Record<string, unknown> {
  if (tenantIds !== undefined && tenantIds.length > 0) {
    return { tenantId: { $in: tenantIds } };
  }
  if (tenantId !== undefined) {
    return { tenantId };
  }
  return {};
}


/**
 * Busca lexical em chunks usando Atlas Search ($search).
 *
 * Usa o índice "chunks_text_search" na coleção `chunks` com analyzer
 * `lucene.portuguese` no campo `text`. Filtros de tenant e departamento
 * são aplicados via `filter` compounds no pipeline $search.
 *
 * Retorna os `topK` chunks mais relevantes, em ordem decrescente de score.
 *
 * Spec §9 (etapa 3 — Atlas Search).
 */
export async function lexicalSearch(
  db: Db,
  params: LexicalSearchParams
): Promise<ChunkSearchResult[]> {
  const { tenantId, tenantIds, allowedDepartmentIds, queryText, topK, filterDocumentIds } = params;

  // Monta os filtros para o compound query do Atlas Search.
  // Para MULTI_TENANT_ADMIN (tenantIds[]), o operador `in` do Atlas Search aceita
  // arrays de strings diretamente — suportado desde Atlas Search 1.x.
  const mustFilters: unknown[] = [];

  if (tenantIds !== undefined && tenantIds.length > 0) {
    mustFilters.push({ in: { path: 'tenantId', value: tenantIds } });
  } else if (tenantId !== undefined) {
    mustFilters.push({ equals: { path: 'tenantId', value: tenantId } });
  }

  if (allowedDepartmentIds !== null) {
    mustFilters.push({
      in: { path: 'departmentId', value: allowedDepartmentIds },
    });
  }

  if (filterDocumentIds !== undefined && filterDocumentIds.length > 0) {
    mustFilters.push({
      in: { path: 'documentId', value: filterDocumentIds },
    });
  }

  const pipeline: object[] = [
    {
      $search: {
        index: 'chunks_text_search',
        compound: {
          must: [
            {
              text: {
                query: queryText,
                path: 'text',
                fuzzy: { maxEdits: 1 },
              },
            },
          ],
          filter: mustFilters,
        },
      },
    },
    {
      $limit: topK,
    },
    {
      $project: {
        _id: 0,
        documentId: 1,
        tenantId: 1,
        departmentId: 1,
        documentTypeName: 1,
        pageNumber: 1,
        chunkIndex: 1,
        text: 1,
        tokenCount: 1,
        score: { $meta: 'searchScore' },
      },
    },
  ];

  const results = await db.collection('chunks').aggregate(pipeline).toArray();
  return results as ChunkSearchResult[];
}

/**
 * Busca vetorial em chunks usando Atlas Vector Search ($vectorSearch).
 *
 * Usa o índice "chunks_vector_search" na coleção `chunks` com 1536
 * dimensões (text-embedding-3-small) e similaridade cosine. Filtros de
 * tenant e departamento são aplicados como pre-filter do índice vetorial.
 *
 * Spec §9 (etapa 3 — Atlas Vector Search).
 */
export async function vectorSearch(
  db: Db,
  params: VectorSearchParams
): Promise<ChunkSearchResult[]> {
  const { tenantId, tenantIds, allowedDepartmentIds, queryEmbedding, topK, numCandidates, filterDocumentIds } =
    params;

  const candidates = numCandidates ?? Math.max(topK * 10, 100);

  // Filtro pre-filter para o $vectorSearch.
  //
  // Atlas Vector Search suporta `$in` no campo filter desde a versão que introduziu
  // filtros de metadados (documentado em:
  // https://www.mongodb.com/docs/atlas/atlas-vector-search/vector-search-stage/#about-the-filter-option).
  // Para MULTI_TENANT_ADMIN usamos `{ $in: tenantIds }` diretamente.
  const preFilter: Record<string, unknown> = {};

  if (tenantIds !== undefined && tenantIds.length > 0) {
    preFilter['tenantId'] = { $in: tenantIds };
  } else if (tenantId !== undefined) {
    preFilter['tenantId'] = { $eq: tenantId };
  }

  if (allowedDepartmentIds !== null) {
    preFilter['departmentId'] = { $in: allowedDepartmentIds };
  }

  if (filterDocumentIds !== undefined && filterDocumentIds.length > 0) {
    preFilter['documentId'] = { $in: filterDocumentIds };
  }

  const pipeline: object[] = [
    {
      $vectorSearch: {
        index: 'chunks_vector_search',
        path: 'embedding',
        queryVector: queryEmbedding,
        numCandidates: candidates,
        limit: topK,
        filter: preFilter,
      },
    },
    {
      $project: {
        _id: 0,
        documentId: 1,
        tenantId: 1,
        departmentId: 1,
        documentTypeName: 1,
        pageNumber: 1,
        chunkIndex: 1,
        text: 1,
        tokenCount: 1,
        score: { $meta: 'vectorSearchScore' },
      },
    },
  ];

  const results = await db.collection('chunks').aggregate(pipeline).toArray();
  return results as ChunkSearchResult[];
}

/**
 * Busca híbrida usando $rankFusion (combina lexical + vetorial).
 *
 * O $rankFusion intercala dois sub-pipelines — $vectorSearch e $search —
 * e combina seus resultados via Reciprocal Rank Fusion, retornando chunks
 * relevantes para ambas as formas de busca.
 *
 * Esta é a query principal da Fase 4 (spec §9, etapa 3).
 *
 * Nota: $rankFusion requer MongoDB Atlas 8.0+ com Atlas Search habilitado.
 * Em dev, usar obrigatoriamente `mongodb/mongodb-atlas-local` (spec §3).
 */
export async function hybridSearch(
  db: Db,
  params: HybridSearchParams
): Promise<ChunkSearchResult[]> {
  const {
    tenantId,
    tenantIds,
    allowedDepartmentIds,
    queryText,
    queryEmbedding,
    topK,
    numCandidates,
    filterDocumentIds,
  } = params;

  const candidates = numCandidates ?? Math.max(topK * 10, 100);

  // Filtro pre-filter para $vectorSearch (dentro do $rankFusion).
  // Atlas Vector Search suporta `$in` no campo filter — usado para MTA.
  const vectorPreFilter: Record<string, unknown> = {};
  if (tenantIds !== undefined && tenantIds.length > 0) {
    vectorPreFilter['tenantId'] = { $in: tenantIds };
  } else if (tenantId !== undefined) {
    vectorPreFilter['tenantId'] = { $eq: tenantId };
  }
  if (allowedDepartmentIds !== null) {
    vectorPreFilter['departmentId'] = { $in: allowedDepartmentIds };
  }
  if (filterDocumentIds !== undefined && filterDocumentIds.length > 0) {
    vectorPreFilter['documentId'] = { $in: filterDocumentIds };
  }

  // Filtros para o $search (dentro do $rankFusion).
  // O operador `in` do Atlas Search aceita arrays — usado para MTA.
  const searchMustFilters: unknown[] = [];
  if (tenantIds !== undefined && tenantIds.length > 0) {
    searchMustFilters.push({ in: { path: 'tenantId', value: tenantIds } });
  } else if (tenantId !== undefined) {
    searchMustFilters.push({ equals: { path: 'tenantId', value: tenantId } });
  }
  if (allowedDepartmentIds !== null) {
    searchMustFilters.push({
      in: { path: 'departmentId', value: allowedDepartmentIds },
    });
  }
  if (filterDocumentIds !== undefined && filterDocumentIds.length > 0) {
    searchMustFilters.push({
      in: { path: 'documentId', value: filterDocumentIds },
    });
  }

  const pipeline: object[] = [
    {
      $rankFusion: {
        input: {
          pipelines: {
            vectorPipeline: [
              {
                $vectorSearch: {
                  index: 'chunks_vector_search',
                  path: 'embedding',
                  queryVector: queryEmbedding,
                  numCandidates: candidates,
                  limit: topK,
                  filter: vectorPreFilter,
                },
              },
            ],
            lexicalPipeline: [
              {
                $search: {
                  index: 'chunks_text_search',
                  compound: {
                    must: [
                      {
                        text: {
                          query: queryText,
                          path: 'text',
                          fuzzy: { maxEdits: 1 },
                        },
                      },
                    ],
                    filter: searchMustFilters,
                  },
                },
              },
              { $limit: topK },
            ],
          },
        },
      },
    },
    {
      $limit: topK,
    },
    {
      $project: {
        _id: 0,
        documentId: 1,
        tenantId: 1,
        departmentId: 1,
        documentTypeName: 1,
        pageNumber: 1,
        chunkIndex: 1,
        text: 1,
        tokenCount: 1,
        score: { $meta: 'rankFusionScore' },
      },
    },
  ];

  const results = await db.collection('chunks').aggregate(pipeline).toArray();
  return results as ChunkSearchResult[];
}
