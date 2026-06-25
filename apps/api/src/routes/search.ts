import OpenAI from 'openai';
import { z } from 'zod';
import type { FastifyPluginAsync, FastifyReply, FastifyBaseLogger } from 'fastify';
import type { Sql } from '@dmdoc/db-pg';
import { SearchRequestSchema } from '@dmdoc/shared-types';
import type { SearchChunk, Citation } from '@dmdoc/shared-types';
import { hybridSearch, lexicalSearch, vectorSearch, documentMetadataSearch } from '@dmdoc/db-pg';
import type { ChunkSearchResult } from '@dmdoc/db-pg';
import { createLLMProvider } from '@dmdoc/llm-provider';
import type { LLMProvider } from '@dmdoc/llm-provider';
import type { Config } from '../config.js';
import { embedQuery } from '../services/embedding.js';
import { parseCitations } from '../services/citation-parser.js';
import { RAG_ANSWER_PROMPT } from '../prompts/rag-answer.js';
import { resolveTenantContext } from '../auth/resolve-tenant.js';
import { resolveAccessibleDepartmentIds } from '../auth/department-access.js';

// ---------------------------------------------------------------------------
// Tipos locais
// ---------------------------------------------------------------------------

type DocRow = {
  id: string;
  tenant_id: string;
  department_id: string;
  document_type_id: string | null;
  tags: string[];
  index_values: Record<string, string | number | null> | null;
  status: string;
  deleted: boolean;
};

// ---------------------------------------------------------------------------
// Helpers de filtros estruturados
// ---------------------------------------------------------------------------

interface StructuredFilters {
  departmentIds?: string[] | undefined;
  documentTypeIds?: string[] | undefined;
  tags?: string[] | undefined;
  indexFilters?:
    | Record<
        string,
        {
          gte?: string | number | undefined;
          lte?: string | number | undefined;
          eq?: string | number | undefined;
        }
      >
    | undefined;
}

/**
 * Aplica filtros estruturados na tabela `documents` e retorna os documentIds
 * que passam. Retorna `null` quando não há filtros (sem restrição por documentId).
 *
 * Filtros JSONB para indexValues (spec §9 etapa 4 + §7 search):
 *   - TEXT/eq:   index_values->>'campo' = $val
 *   - NUMBER/gte: (index_values->>'campo')::numeric >= $val
 *   - NUMBER/lte: (index_values->>'campo')::numeric <= $val
 *   - DATE/gte:  (index_values->>'campo')::timestamptz >= $val
 *   - DATE/lte:  (index_values->>'campo')::timestamptz <= $val
 *   - tags:      tags @> $tags::text[]
 *   - documentTypeIds: document_type_id = ANY($ids::uuid[])
 */
async function resolveFilteredDocumentIds(
  sql: Sql,
  tenantId: string | undefined,
  tenantIds: string[] | undefined,
  allowedDepartmentIds: string[] | null,
  filters: StructuredFilters | undefined,
): Promise<string[] | null> {
  const hasStructuredFilters =
    filters !== undefined &&
    (filters.departmentIds !== undefined ||
      filters.documentTypeIds !== undefined ||
      (filters.tags !== undefined && filters.tags.length > 0) ||
      (filters.indexFilters !== undefined && Object.keys(filters.indexFilters).length > 0));

  if (!hasStructuredFilters) {
    return null;
  }

  // Construção dinâmica de WHERE com sql.unsafe + parâmetros
  const conditions: string[] = [`d.deleted = false`, `d.status = 'READY'`];
  const params: unknown[] = [];
  let paramIdx = 1;

  const addParam = (val: unknown): string => {
    params.push(val);
    return `$${paramIdx++}`;
  };

  // Filtro de tenant
  if (tenantIds !== undefined && tenantIds.length > 0) {
    conditions.push(`d.tenant_id = ANY(${addParam(tenantIds)}::uuid[])`);
  } else if (tenantId !== undefined) {
    conditions.push(`d.tenant_id = ${addParam(tenantId)}`);
  }

  // Filtro de departamentos
  if (filters?.departmentIds !== undefined) {
    const requested = filters.departmentIds;
    let effective: string[];
    if (allowedDepartmentIds !== null) {
      effective = requested.filter((id) => allowedDepartmentIds.includes(id));
      if (effective.length === 0) return [];
    } else {
      effective = requested;
    }
    conditions.push(`d.department_id = ANY(${addParam(effective)}::uuid[])`);
  } else if (allowedDepartmentIds !== null) {
    conditions.push(`d.department_id = ANY(${addParam(allowedDepartmentIds)}::uuid[])`);
  }

  // Filtro de documentTypeIds: = ANY($ids::uuid[])
  if (filters?.documentTypeIds !== undefined && filters.documentTypeIds.length > 0) {
    conditions.push(`d.document_type_id = ANY(${addParam(filters.documentTypeIds)}::uuid[])`);
  }

  // Filtro de tags: tags @> $tags::text[] (contém TODOS)
  if (filters?.tags !== undefined && filters.tags.length > 0) {
    conditions.push(`d.tags @> ${addParam(filters.tags)}::text[]`);
  }

  // Filtros de indexValues (JSONB)
  if (filters?.indexFilters !== undefined) {
    for (const [fieldName, conditions_] of Object.entries(filters.indexFilters)) {
      if (conditions_.eq !== undefined) {
        conditions.push(`d.index_values->>${addParam(fieldName)} = ${addParam(String(conditions_.eq))}`);
      }
      if (conditions_.gte !== undefined) {
        const val = conditions_.gte;
        if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val)) {
          // DATE
          conditions.push(`(d.index_values->>${addParam(fieldName)})::timestamptz >= ${addParam(val)}::timestamptz`);
        } else {
          // NUMBER
          conditions.push(`(d.index_values->>${addParam(fieldName)})::numeric >= ${addParam(val)}`);
        }
      }
      if (conditions_.lte !== undefined) {
        const val = conditions_.lte;
        if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val)) {
          // DATE
          conditions.push(`(d.index_values->>${addParam(fieldName)})::timestamptz <= ${addParam(val)}::timestamptz`);
        } else {
          // NUMBER
          conditions.push(`(d.index_values->>${addParam(fieldName)})::numeric <= ${addParam(val)}`);
        }
      }
    }
  }

  const whereClause = conditions.join(' AND ');
  const query = `SELECT d.id FROM documents d WHERE ${whereClause}`;

  const rows = await sql.unsafe<Array<{ id: string }>>(query, params as Parameters<typeof sql.unsafe>[1]);
  return rows.map((r) => r.id);
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

    const body = SearchRequestSchema.parse(request.body);

    const { tenantId: tenantIdParam } = z
      .object({ tenantId: z.string().uuid().optional() })
      .parse(request.query);
    const context = resolveTenantContext(request, { explicitTenantId: tenantIdParam, write: false });
    const { query, searchMode, filters, topK, generateAnswer } = body;

    const singleTenantId = context.mode === 'single' ? context.tenantId : undefined;
    const multiTenantIds = context.mode === 'allowed' ? context.tenantIds : undefined;

    const logTenantId =
      singleTenantId ?? (multiTenantIds ? `[${multiTenantIds.join(',')}]` : 'all');
    const log = request.log.child({ tenantId: logTenantId, userId, traceId: request.id });

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
          if (generateAnswer) return sendEmptySSE(reply, log);
          return reply.status(200).send({ answer: null, citations: [], chunks: [], costUsd: 0 });
        }
        allowedDepartmentIds = intersection;
      } else {
        allowedDepartmentIds = filters.departmentIds;
      }
    }

    const filterDocumentIds = await resolveFilteredDocumentIds(
      sql,
      singleTenantId,
      multiTenantIds,
      allowedDepartmentIds,
      filters as StructuredFilters | undefined,
    );

    if (filterDocumentIds !== null && filterDocumentIds.length === 0) {
      if (generateAnswer) return sendEmptySSE(reply, log);
      return reply.status(200).send({ answer: null, citations: [], chunks: [], costUsd: 0 });
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

    // Enriquece chunks com o nome original do documento
    const uniqueDocIds = [...new Set(allSearchResults.map((r) => r.documentId))];

    const docNameMap = new Map<string, string>();
    if (uniqueDocIds.length > 0) {
      const docRows = await sql<Array<{ id: string; original_filename: string }>>`
        SELECT id, original_filename
        FROM documents
        WHERE id = ANY(${uniqueDocIds}::uuid[])
          AND deleted = false
      `;
      for (const d of docRows) docNameMap.set(d.id, d.original_filename);
    }

    const chunks: SearchChunk[] = allSearchResults.map((r) => ({
      documentId: r.documentId,
      documentName: docNameMap.get(r.documentId) ?? null,
      tenantId: r.tenantId,
      documentTypeName: r.documentTypeName,
      pageNumber: r.pageNumber,
      chunkIndex: r.chunkIndex,
      text: r.text,
      score: r.score,
    }));

    if (!generateAnswer || chunks.length === 0) {
      log.info({ generateAnswer, chunksFound: chunks.length }, 'busca sem geração de resposta');
      return reply.status(200).send({
        answer: null,
        citations: [],
        chunks,
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
