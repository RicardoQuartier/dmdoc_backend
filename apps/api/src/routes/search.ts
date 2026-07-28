import OpenAI from 'openai';
import { z } from 'zod';
import type { FastifyPluginAsync, FastifyReply, FastifyBaseLogger } from 'fastify';
import type { Sql } from '@dmdoc/db-pg';
import { SearchRequestSchema } from '@dmdoc/shared-types';
import type { SearchChunk, SearchChunkIndexValue, Citation } from '@dmdoc/shared-types';
import {
  hybridSearch,
  lexicalSearch,
  vectorSearch,
  documentMetadataSearch,
  searchDocumentsPaged,
  createParamAllocator,
  buildDocumentFilterPredicate,
  hasStructuredDocumentFilters,
} from '@dmdoc/db-pg';
import type {
  ChunkSearchResult,
  DocumentSearchResult,
  StructuredDocumentFilters,
} from '@dmdoc/db-pg';
import { createLLMProvider } from '@dmdoc/llm-provider';
import type { LLMProvider } from '@dmdoc/llm-provider';
import type { Config } from '../config.js';
import { embedQuery } from '../services/embedding.js';
import { parseCitations } from '../services/citation-parser.js';
import { RAG_ANSWER_PROMPT } from '../prompts/rag-answer.js';
import { resolveTenantContext } from '../auth/resolve-tenant.js';
import { resolveAccessibleDepartmentIds } from '../auth/department-access.js';
import { resolveIndexFieldDisplayLabel } from '../lib/index-fields.js';

// ---------------------------------------------------------------------------
// Tipos locais
// ---------------------------------------------------------------------------

/** Linha da query em lote de metadados de documento para enriquecer chunks. */
type DocMetaRow = {
  id: string;
  original_filename: string;
  title: string | null;
  document_type_id: string | null;
  index_values: Record<string, string | number | null> | null;
  tags: string[] | null;
  department_id: string;
  mime_type: string;
};

/** Linha da query em lote de caminho de departamento (`leaf_id` → nomes raiz→folha). */
type DeptPathRow = {
  leaf_id: string;
  path: string[];
};

/** Campo de índice showOnSearch de um tipo de documento (query em lote). */
type IndexFieldRow = {
  document_type_id: string;
  name: string;
  label: string | null;
  field_type: string;
  sort_order: number;
};

/** Metadados por documento montados em memória para o enriquecimento. */
type DocMeta = {
  originalFilename: string;
  title: string | null;
  indexValues: SearchChunkIndexValue[];
  tags: string[];
  departmentId: string;
  /** Nomes da RAIZ até o departamento, inclusive. Vazio só em dado inconsistente. */
  departmentPath: string[];
  mimeType: string;
};

/**
 * Campos que o enriquecimento em lote consome de um resultado de busca.
 *
 * Serve tanto a `ChunkSearchResult` (caminho por chunk — vector/hybrid/RAG)
 * quanto a `DocumentSearchResult` (caminho paginado por documento), que
 * compartilham esse subconjunto de campos.
 */
type EnrichableResult = Pick<
  ChunkSearchResult & DocumentSearchResult,
  'documentId' | 'tenantId' | 'documentTypeName' | 'pageNumber' | 'chunkIndex' | 'text' | 'score'
>;

/** Escopo de tenant já resolvido pela rota, reaproveitado no enriquecimento. */
type TenantScope = {
  singleTenantId: string | undefined;
  multiTenantIds: string[] | undefined;
};

/**
 * Teto de profundidade da paginação: `(page - 1) * pageSize`.
 *
 * O custo não é o OFFSET em si, e sim repagar o pipeline inteiro (ranking +
 * agregação) a cada página para descartar tudo antes do offset. Todo motor de
 * busca impõe um teto desse tipo; acima dele o caminho correto é refinar a
 * busca com filtros, não avançar páginas.
 */
const MAX_PAGINATION_DEPTH = 5000;

// ---------------------------------------------------------------------------
// Helpers de filtros estruturados
// ---------------------------------------------------------------------------

/**
 * Aplica filtros estruturados na tabela `documents` e retorna os documentIds
 * que passam. Retorna `null` quando não há filtros (sem restrição por documentId).
 *
 * A montagem do WHERE vive em `@dmdoc/db-pg` (`buildDocumentFilterPredicate`)
 * para poder ser inlinada em queries maiores sem duplicar o predicado — aqui
 * fica só a execução e o mapeamento do resultado.
 */
async function resolveFilteredDocumentIds(
  sql: Sql,
  tenantId: string | undefined,
  tenantIds: string[] | undefined,
  allowedDepartmentIds: string[] | null,
  filters: StructuredDocumentFilters | undefined,
): Promise<string[] | null> {
  if (!hasStructuredDocumentFilters(filters)) {
    return null;
  }

  const alloc = createParamAllocator();
  const predicate = buildDocumentFilterPredicate(
    { tenantId, tenantIds, allowedDepartmentIds, filters },
    alloc,
  );

  // Filtros insatisfazíveis (ex.: nenhum departamento pedido é permitido):
  // nenhum documento pode passar, não vale ir ao banco.
  if (predicate.unsatisfiable) return [];

  const query = `SELECT d.id FROM documents d WHERE ${predicate.sql}`;

  const rows = await sql.unsafe<Array<{ id: string }>>(
    query,
    alloc.bindings as Parameters<typeof sql.unsafe>[1],
  );
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Enriquecimento em lote dos resultados
// ---------------------------------------------------------------------------

/**
 * Enriquece os resultados da busca com nome original, título CONFIRMADO, tags
 * confirmadas e os valores de índice "que aparecem na busca" (showOnSearch).
 * Tudo em LOTE — duas queries no total, sem N+1.
 *
 * Multi-tenancy inegociável: além do `documentId` (que a busca já autorizou),
 * aplica o MESMO filtro de tenant/allowedTenantIds. Nenhum título/índice de
 * outra empresa entra por aqui.
 *
 * Esta query NÃO reaplica o filtro de departamento: ela confia que a busca já
 * autorizou os documentos. O que sustenta essa confiança é o filtro de
 * departamento estar dentro de TODAS as CTEs da query de busca — tanto no ramo
 * de conteúdo quanto no de metadados. Se algum dia esse filtro sair de lá, esta
 * função vira o vazamento.
 *
 * SEGUNDA BARREIRA (T-99): resultado cujo documento NÃO aparece nesta query é
 * DESCARTADO, não anonimizado. Antes o item seguia na resposta com
 * `documentName`/`title` nulos e `tags`/`indexValues` vazios — mas com o `text`
 * intacto, que é justamente o payload que vai para a tela e para o prompt do
 * LLM. Meta ausente só acontece por motivo ruim:
 *
 *   1. documento excluído ou fora de `READY` — conteúdo que não deveria mais
 *      ser recuperável;
 *   2. documento de outra empresa — o filtro de tenant acima o derruba;
 *   3. documento que sumiu ENTRE a busca e o enriquecimento — são duas queries
 *      em snapshots diferentes, então um `bulk-delete` que commita no meio ainda
 *      produz esse caso mesmo com o semi-join de `buildLiveDocumentPredicate`
 *      dentro da busca (`packages/db-pg/src/search.ts`). É a janela de corrida
 *      que esta barreira fecha.
 *
 * Nenhum dos três é caso de "mostrar mesmo assim": sem nome, título e tags o
 * item vira um cartão anônimo que o usuário não consegue abrir.
 *
 * Consequência aceita: a resposta pode vir com MENOS itens do que o `topK`
 * (ou do que o `pageSize`) pedido. O contrato paginado não promete página cheia
 * — `total`/`pageCount` continuam vindo da query de busca, que já aplica
 * `deleted = false AND status = 'READY'`.
 */
async function enrichResultsToChunks(
  sql: Sql,
  results: EnrichableResult[],
  scope: TenantScope,
  log: FastifyBaseLogger,
): Promise<SearchChunk[]> {
  const { singleTenantId, multiTenantIds } = scope;
  const uniqueDocIds = [...new Set(results.map((r) => r.documentId))];

  const docMetaMap = new Map<string, DocMeta>();
  if (uniqueDocIds.length > 0) {
    const tenantFilter =
      multiTenantIds !== undefined
        ? sql`AND d.tenant_id = ANY(${multiTenantIds}::uuid[])`
        : singleTenantId !== undefined
          ? sql`AND d.tenant_id = ${singleTenantId}`
          : sql``;

    const docRows = await sql<DocMetaRow[]>`
      SELECT d.id, d.original_filename, d.title, d.document_type_id, d.index_values, d.tags,
             d.department_id, d.mime_type
      FROM documents d
      WHERE d.id = ANY(${uniqueDocIds}::uuid[])
        AND d.deleted = false
        AND d.status = 'READY'
        ${tenantFilter}
    `;

    // Campos de índice showOnSearch dos tipos envolvidos — uma query em lote.
    const typeIds = [
      ...new Set(
        docRows.map((d) => d.document_type_id).filter((id): id is string => id !== null),
      ),
    ];

    const fieldsByType = new Map<string, IndexFieldRow[]>();
    if (typeIds.length > 0) {
      const fieldRows = await sql<IndexFieldRow[]>`
        SELECT document_type_id, name, label, field_type, sort_order
        FROM document_type_index_fields
        WHERE document_type_id = ANY(${typeIds}::uuid[])
          AND show_on_search = true
          AND deleted = false
        ORDER BY sort_order ASC
      `;
      for (const f of fieldRows) {
        const list = fieldsByType.get(f.document_type_id) ?? [];
        list.push(f);
        fieldsByType.set(f.document_type_id, list);
      }
    }

    // Caminho do departamento (raiz → folha) dos documentos da página, numa
    // query só — os departamentos DISTINTOS, subindo pela cadeia de `parent_id`.
    //
    // Resolver isso no servidor (e não no front, a partir da lista de
    // departamentos) é o que faz o caminho vir COMPLETO para quem tem ACL
    // restrita: `resolveAccessibleDepartmentIds` entrega ao front apenas a
    // subárvore da raiz concedida, então um USER com acesso a "Notas Fiscais"
    // veria "Notas Fiscais / 2026" sem o "Financeiro" acima.
    //
    // Detalhes que NÃO são cosméticos:
    //  - `ORDER BY depth DESC` porque a recursão SOBE: o maior `depth` é a raiz.
    //  - `CYCLE id SET is_cycle USING path` (pg14+; rodamos pg16) evita loop
    //    infinito se os dados já contiverem um ciclo herdado — mesma proteção do
    //    move de departamento (`routes/departments.ts`).
    //  - a recursão NÃO filtra `deleted`: ancestral soft-deletado continua sendo
    //    elo real da cadeia de `parent_id` (mesma escolha de
    //    `auth/department-access.ts`), e filtrar abriria buraco no meio do caminho.
    //  - o `tenantFilter` da query acima é reaproveitado na ÂNCORA porque ele é
    //    escrito sobre o alias `d` — daí a âncora manter esse alias. Os leaves já
    //    vêm de documentos autorizados, mas o filtro fica como rede de segurança:
    //    multi-tenancy é inegociável.
    const deptPathMap = new Map<string, string[]>();
    const uniqueDeptIds = [...new Set(docRows.map((d) => d.department_id))];

    if (uniqueDeptIds.length > 0) {
      const pathRows = await sql<DeptPathRow[]>`
        WITH RECURSIVE chain AS (
          SELECT d.id AS leaf_id, d.id, d.parent_id, d.name, 0 AS depth
            FROM departments d
           WHERE d.id = ANY(${uniqueDeptIds}::uuid[])
             ${tenantFilter}
          UNION ALL
          SELECT c.leaf_id, p.id, p.parent_id, p.name, c.depth + 1
            FROM departments p
            JOIN chain c ON p.id = c.parent_id
        ) CYCLE id SET is_cycle USING path
        SELECT leaf_id, array_agg(name ORDER BY depth DESC) AS path
          FROM chain
         GROUP BY leaf_id
      `;
      for (const row of pathRows) {
        deptPathMap.set(row.leaf_id, row.path);
      }
    }

    for (const d of docRows) {
      const fields = d.document_type_id !== null ? fieldsByType.get(d.document_type_id) ?? [] : [];
      const values = d.index_values ?? {};
      const indexValues: SearchChunkIndexValue[] = [];
      for (const field of fields) {
        const raw = values[field.name];
        if (raw === undefined || raw === null) continue;
        indexValues.push({
          fieldName: field.name,
          label: resolveIndexFieldDisplayLabel(field),
          fieldType: field.field_type,
          value: raw,
        });
      }
      docMetaMap.set(d.id, {
        originalFilename: d.original_filename,
        title: d.title,
        indexValues,
        tags: d.tags ?? [],
        departmentId: d.department_id,
        // Departamento sem linha na CTE é dado inconsistente, não motivo para
        // derrubar o resultado: o descarte é reservado a documento sem metadados
        // vivos. O front já trata caminho vazio omitindo a linha.
        departmentPath: deptPathMap.get(d.department_id) ?? [],
        mimeType: d.mime_type,
      });
    }
  }

  const chunks: SearchChunk[] = [];
  const droppedDocIds = new Set<string>();

  for (const r of results) {
    const meta = docMetaMap.get(r.documentId);
    if (meta === undefined) {
      // Documento não está mais vivo/`READY`/no escopo: o item inteiro cai,
      // inclusive o `text`. Ver o bloco de doc acima.
      droppedDocIds.add(r.documentId);
      continue;
    }
    chunks.push({
      documentId: r.documentId,
      documentName: meta.originalFilename,
      title: meta.title,
      indexValues: meta.indexValues,
      tags: meta.tags,
      tenantId: r.tenantId,
      documentTypeName: r.documentTypeName,
      // Departamento ATUAL do documento, lido de `documents` — a fonte canônica.
      // `chunks.department_id` é cópia denormalizada (mantida em sincronia pelo
      // move, na mesma transação); ler da fonte tira a exibição dessa dependência,
      // e o caminho por chunk nem sempre carrega o campo até aqui.
      departmentId: meta.departmentId,
      departmentPath: meta.departmentPath,
      mimeType: meta.mimeType,
      pageNumber: r.pageNumber,
      chunkIndex: r.chunkIndex,
      text: r.text,
      score: r.score,
    });
  }

  if (droppedDocIds.size > 0) {
    // Sinal de corrida ou de inconsistência entre `chunks` e `documents`; não é
    // erro de requisição, mas nunca deve ser silencioso.
    log.warn(
      {
        droppedResults: results.length - chunks.length,
        droppedDocumentIds: [...droppedDocIds],
      },
      'resultados de busca descartados: documento sem metadados vivos no enriquecimento',
    );
  }

  return chunks;
}

/**
 * Corpo de uma resposta de busca vazia, já com os campos de paginação.
 *
 * `page`/`pageSize` ecoam o que foi pedido (contrato do `SearchResponseSchema`);
 * `total` e `pageCount` são 0 — sem resultados não há página nenhuma.
 */
function emptySearchResponse(page: number, pageSize: number) {
  return {
    answer: null,
    citations: [],
    chunks: [],
    page,
    pageSize,
    total: 0,
    pageCount: 0,
    costUsd: 0,
  };
}

// ---------------------------------------------------------------------------
// Plugin de rotas
// ---------------------------------------------------------------------------

export interface SearchRoutesOptions {
  config: Config;
}

/**
 * Rotas de Busca RAG — Fase 4 (PostgreSQL).
 */
export const searchRoutes: FastifyPluginAsync<SearchRoutesOptions> = async (app, options) => {
  const { config } = options;

  const openaiClient = new OpenAI({
    apiKey: config.OPENAI_API_KEY || 'sk-placeholder',
    baseURL: 'https://api.openai.com/v1',
  });

  const llmProvider = createLLMProvider(
    {
      provider: config.LLM_PROVIDER,
      baseURL: config.LLM_BASE_URL,
      apiKey: config.LLM_API_KEY || 'placeholder',
      model: config.LLM_MODEL,
    },
    app.log,
  );

  app.post('/search', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.user!.sub;
    const role = request.user!.role;
    const sql = app.db;

    // Lido ANTES do parse (que aplica os defaults do Zod): só assim dá para
    // distinguir `page: 1` enviado pelo cliente do default. A guarda de
    // "paginação em modo não-lexical" depende dessa distinção.
    const rawBody =
      typeof request.body === 'object' && request.body !== null
        ? (request.body as Record<string, unknown>)
        : {};
    const pagingRequested = rawBody.page !== undefined || rawBody.pageSize !== undefined;

    const body = SearchRequestSchema.parse(request.body);

    const { tenantId: tenantIdParam } = z
      .object({ tenantId: z.string().uuid().optional() })
      .parse(request.query);
    const context = resolveTenantContext(request, { explicitTenantId: tenantIdParam, write: false });
    const { query, searchMode, filters, topK, generateAnswer, page, pageSize } = body;

    const singleTenantId = context.mode === 'single' ? context.tenantId : undefined;
    const multiTenantIds = context.mode === 'allowed' ? context.tenantIds : undefined;

    const logTenantId =
      singleTenantId ?? (multiTenantIds ? `[${multiTenantIds.join(',')}]` : 'all');
    const log = request.log.child({ tenantId: logTenantId, userId, traceId: request.id });

    // -----------------------------------------------------------------------
    // Guardas de paginação (400) — antes de qualquer ida ao banco.
    // -----------------------------------------------------------------------

    // (a) O caminho SSE não pagina: ele monta o contexto do LLM com os `topK`
    // chunks mais relevantes. Aceitar `page > 1` ali seria inventar semântica.
    if (generateAnswer && page > 1) {
      log.info({ page, generateAnswer }, 'busca recusada: geração de resposta com page > 1');
      return reply.status(400).send({
        error: {
          code: 'BAD_REQUEST',
          message:
            'generateAnswer não é compatível com page > 1: a resposta gerada por IA usa sempre a primeira página de resultados',
        },
      });
    }

    // (b) `total`/`pageCount` só são exatos no modo lexical (ver comentário do
    // SearchRequestSchema). Em vector/hybrid o conjunto candidato é truncado
    // pelo ranqueador — paginar sobre ele devolveria números mentirosos.
    if (searchMode !== 'lexical' && pagingRequested) {
      log.info({ searchMode, page, pageSize }, 'busca recusada: paginação em modo não-lexical');
      return reply.status(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: `paginação (page/pageSize) só é suportada em searchMode 'lexical'; recebido '${searchMode}'`,
        },
      });
    }

    // (c) Profundidade máxima.
    if ((page - 1) * pageSize > MAX_PAGINATION_DEPTH) {
      log.info({ page, pageSize }, 'busca recusada: profundidade de paginação excedida');
      return reply.status(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: `profundidade de paginação excedida: (page - 1) * pageSize deve ser no máximo ${MAX_PAGINATION_DEPTH}; refine a busca com filtros em vez de avançar páginas`,
        },
      });
    }

    let allowedDepartmentIds = await resolveAccessibleDepartmentIds(
      sql,
      userId,
      singleTenantId ?? null,
      role,
    );

    if (filters?.departmentIds !== undefined && filters.departmentIds.length > 0) {
      if (allowedDepartmentIds !== null) {
        const intersection = filters.departmentIds.filter((id) =>
          (allowedDepartmentIds as string[]).includes(id),
        );
        if (intersection.length === 0) {
          // Corte de PERMISSÃO: nenhum dos departamentos pedidos é acessível.
          // Não vale ir ao banco — o resultado é vazio por construção.
          if (generateAnswer) return sendEmptySSE(reply, log);
          log.info({ page, pageSize, total: 0 }, 'busca sem departamentos acessíveis');
          return reply.status(200).send(emptySearchResponse(page, pageSize));
        }
        allowedDepartmentIds = intersection;
      } else {
        allowedDepartmentIds = filters.departmentIds;
      }
    }

    const structuredFilter = filters as StructuredDocumentFilters | undefined;

    // -----------------------------------------------------------------------
    // Caminho PAGINADO — `searchMode: 'lexical'` sem geração de resposta.
    //
    // Uma única query (`searchDocumentsPaged`) resolve filtros estruturados,
    // ramo de conteúdo, ramo de metadados, dedup por documento, total exato e
    // recorte da página. Os filtros estruturados viram a CTE `filtered`: nenhum
    // array de UUIDs trafega mais entre Node e Postgres neste caminho.
    // -----------------------------------------------------------------------
    if (searchMode === 'lexical' && !generateAnswer) {
      const { items, total } = await searchDocumentsPaged(sql, {
        ...(singleTenantId !== undefined ? { tenantId: singleTenantId } : {}),
        ...(multiTenantIds !== undefined ? { tenantIds: multiTenantIds } : {}),
        allowedDepartmentIds,
        ...(structuredFilter !== undefined ? { structuredFilter } : {}),
        queryText: query,
        page,
        pageSize,
      });

      // `chunks.length` pode ser MENOR que `items.length` quando um documento é
      // excluído entre a busca e o enriquecimento (snapshots distintos). `total`
      // e `pageCount` continuam vindo da query de busca — a página fica curta,
      // que é o comportamento correto; o contrato não promete página cheia.
      const chunks = await enrichResultsToChunks(
        sql,
        items,
        { singleTenantId, multiTenantIds },
        log,
      );
      const pageCount = Math.ceil(total / pageSize);

      log.info(
        { searchMode, page, pageSize, total, pageCount, returned: chunks.length },
        'busca lexical paginada concluída',
      );

      return reply.status(200).send({
        answer: null,
        citations: [],
        chunks,
        page,
        pageSize,
        total,
        pageCount,
        costUsd: 0,
      });
    }

    // -----------------------------------------------------------------------
    // Caminho por CHUNK — vector/hybrid e o RAG (generateAnswer). Preserva a
    // semântica atual: `topK` chunks (vários por documento) alimentando o LLM,
    // com o ramo de metadados mesclado em memória.
    // -----------------------------------------------------------------------

    const filterDocumentIds = await resolveFilteredDocumentIds(
      sql,
      singleTenantId,
      multiTenantIds,
      allowedDepartmentIds,
      structuredFilter,
    );

    if (filterDocumentIds !== null && filterDocumentIds.length === 0) {
      if (generateAnswer) return sendEmptySSE(reply, log);
      log.info({ page, pageSize, total: 0 }, 'busca sem documentos após filtros estruturados');
      return reply.status(200).send(emptySearchResponse(page, pageSize));
    }

    // Busca por metadados em paralelo
    const metadataSearchPromise = documentMetadataSearch(sql, {
      ...(singleTenantId !== undefined ? { tenantId: singleTenantId } : {}),
      ...(multiTenantIds !== undefined ? { tenantIds: multiTenantIds } : {}),
      allowedDepartmentIds,
      ...(filterDocumentIds !== null ? { filterDocumentIds } : {}),
      queryText: query,
    });

    let embeddingCostUsd = 0;
    let queryEmbedding: number[] | null = null;

    if (searchMode === 'vector' || searchMode === 'hybrid') {
      const result = await embedQuery(query, openaiClient, config.EMBEDDING_MODEL, log);
      queryEmbedding = result.embedding;
      embeddingCostUsd = result.costUsd;
    }

    const baseParams = {
      ...(singleTenantId !== undefined ? { tenantId: singleTenantId } : {}),
      ...(multiTenantIds !== undefined ? { tenantIds: multiTenantIds } : {}),
      allowedDepartmentIds,
      topK,
      ...(filterDocumentIds !== null ? { filterDocumentIds } : {}),
    };

    let searchResults: ChunkSearchResult[];

    if (searchMode === 'lexical') {
      searchResults = await lexicalSearch(sql, { ...baseParams, queryText: query });
    } else if (searchMode === 'vector') {
      searchResults = await vectorSearch(sql, {
        ...baseParams,
        queryEmbedding: queryEmbedding as number[],
      });
    } else {
      // Hybrid — PostgreSQL usa RRF nativo, sem fallback necessário
      searchResults = await hybridSearch(sql, {
        ...baseParams,
        queryText: query,
        queryEmbedding: queryEmbedding as number[],
      });
    }

    log.info({ returned: searchResults.length, topK, searchMode }, 'busca por conteúdo concluída');

    // Mescla com resultados de busca por metadados
    const metadataDocIds = await metadataSearchPromise;
    const contentDocIds = new Set(searchResults.map((r) => r.documentId));
    const metadataOnlyDocIds = metadataDocIds.filter((id) => !contentDocIds.has(id)).slice(0, 5);

    let metadataChunks: ChunkSearchResult[] = [];
    if (metadataOnlyDocIds.length > 0) {
      // Busca chunks da tabela SQL para documentos encontrados por metadado
      type RawChunkRow = {
        document_id: string;
        tenant_id: string;
        department_id: string;
        document_type_name: string | null;
        page_number: number | null;
        chunk_index: number;
        text: string;
        token_count: number;
      };

      let chunkRows: RawChunkRow[];

      if (multiTenantIds !== undefined) {
        if (allowedDepartmentIds !== null) {
          chunkRows = await sql<RawChunkRow[]>`
            SELECT document_id, tenant_id, department_id, document_type_name, page_number, chunk_index, text, token_count
            FROM chunks
            WHERE document_id = ANY(${metadataOnlyDocIds}::uuid[])
              AND tenant_id = ANY(${multiTenantIds}::uuid[])
              AND department_id = ANY(${allowedDepartmentIds}::uuid[])
            ORDER BY chunk_index ASC
          `;
        } else {
          chunkRows = await sql<RawChunkRow[]>`
            SELECT document_id, tenant_id, department_id, document_type_name, page_number, chunk_index, text, token_count
            FROM chunks
            WHERE document_id = ANY(${metadataOnlyDocIds}::uuid[])
              AND tenant_id = ANY(${multiTenantIds}::uuid[])
            ORDER BY chunk_index ASC
          `;
        }
      } else if (singleTenantId !== undefined) {
        if (allowedDepartmentIds !== null) {
          chunkRows = await sql<RawChunkRow[]>`
            SELECT document_id, tenant_id, department_id, document_type_name, page_number, chunk_index, text, token_count
            FROM chunks
            WHERE document_id = ANY(${metadataOnlyDocIds}::uuid[])
              AND tenant_id = ${singleTenantId}
              AND department_id = ANY(${allowedDepartmentIds}::uuid[])
            ORDER BY chunk_index ASC
          `;
        } else {
          chunkRows = await sql<RawChunkRow[]>`
            SELECT document_id, tenant_id, department_id, document_type_name, page_number, chunk_index, text, token_count
            FROM chunks
            WHERE document_id = ANY(${metadataOnlyDocIds}::uuid[])
              AND tenant_id = ${singleTenantId}
            ORDER BY chunk_index ASC
          `;
        }
      } else {
        chunkRows = await sql<RawChunkRow[]>`
          SELECT document_id, tenant_id, department_id, document_type_name, page_number, chunk_index, text, token_count
          FROM chunks
          WHERE document_id = ANY(${metadataOnlyDocIds}::uuid[])
          ORDER BY chunk_index ASC
        `;
      }

      const seenDocIds = new Set<string>();
      metadataChunks = chunkRows
        .filter((c) => {
          if (seenDocIds.has(c.document_id)) return false;
          seenDocIds.add(c.document_id);
          return true;
        })
        .map((c) => ({
          documentId: c.document_id,
          tenantId: c.tenant_id,
          departmentId: c.department_id,
          documentTypeName: c.document_type_name,
          pageNumber: c.page_number,
          chunkIndex: c.chunk_index,
          text: c.text,
          tokenCount: c.token_count,
          score: 0,
        }));

      if (metadataChunks.length > 0) {
        log.info({ metadataMatched: metadataChunks.length }, 'chunks adicionados via busca por metadados');
      }
    }

    const allSearchResults = [...searchResults, ...metadataChunks];

    const chunks: SearchChunk[] = await enrichResultsToChunks(
      sql,
      allSearchResults,
      { singleTenantId, multiTenantIds },
      log,
    );

    if (!generateAnswer || chunks.length === 0) {
      // Este caminho não pagina: devolve o conjunto ranqueado inteiro (truncado
      // pelo `topK`, não por `pageSize`). Para o contrato de resposta continuar
      // uniforme, ele se apresenta como PÁGINA ÚNICA — `pageSize` ecoa o que foi
      // efetivamente devolvido, de modo que `pageCount` nunca prometa uma página
      // 2 que a guarda (b) recusaria.
      const total = chunks.length;
      log.info(
        { generateAnswer, searchMode, page: 1, pageSize: total, total },
        'busca sem geração de resposta',
      );
      return reply.status(200).send({
        answer: null,
        citations: [],
        chunks,
        page: 1,
        pageSize: total > 0 ? total : pageSize,
        total,
        pageCount: total > 0 ? 1 : 0,
        costUsd: embeddingCostUsd,
      });
    }

    return generateSSEResponse(reply, {
      query,
      chunks,
      llmProvider,
      embeddingCostUsd,
      log,
    });
  });
};

// ---------------------------------------------------------------------------
// Helpers SSE
// ---------------------------------------------------------------------------

function formatSSEEvent(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function sendEmptySSE(reply: FastifyReply, log: FastifyBaseLogger): Promise<void> {
  log.info('busca SSE sem resultados — nenhum chunk acessível');

  // Assume o controle do socket ANTES de escrever em `reply.raw`, igual a
  // `generateSSEResponse`. Sem o hijack o Fastify tenta responder de novo ao
  // fim do handler, sobre um socket já encerrado.
  reply.hijack();

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  reply.raw.write(
    formatSSEEvent('done', { type: 'done', citations: [], chunks: [], costUsd: 0 }),
  );

  reply.raw.end();
}

async function generateSSEResponse(
  reply: FastifyReply,
  params: {
    query: string;
    chunks: SearchChunk[];
    llmProvider: LLMProvider;
    embeddingCostUsd: number;
    log: FastifyBaseLogger;
  },
): Promise<void> {
  const { query, chunks, llmProvider, embeddingCostUsd, log } = params;

  reply.hijack();

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const chatParams = {
    messages: [
      { role: 'system' as const, content: RAG_ANSWER_PROMPT.systemPrompt },
      {
        role: 'user' as const,
        content: RAG_ANSWER_PROMPT.buildUserMessage(query, chunks),
      },
    ],
    maxTokens: 2048,
    temperature: 0.2,
  };

  let accumulatedAnswer = '';

  try {
    const startMs = Date.now();

    for await (const fragment of llmProvider.chatStream(chatParams)) {
      accumulatedAnswer += fragment;
      reply.raw.write(formatSSEEvent('chunk', { type: 'chunk', text: fragment }));
    }

    const durationMs = Date.now() - startMs;
    log.info({ durationMs, answerLength: accumulatedAnswer.length }, 'resposta RAG gerada via SSE');

    const citations: Citation[] = parseCitations(accumulatedAnswer);

    reply.raw.write(
      formatSSEEvent('done', {
        type: 'done',
        citations,
        chunks,
        costUsd: embeddingCostUsd,
      }),
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erro ao gerar resposta';
    log.error({ err }, 'falha na geração de resposta RAG via SSE');
    reply.raw.write(formatSSEEvent('error', { type: 'error', message }));
  } finally {
    reply.raw.end();
  }
}
