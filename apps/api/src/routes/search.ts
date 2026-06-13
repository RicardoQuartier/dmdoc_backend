import OpenAI from 'openai';
import { z } from 'zod';
import type { FastifyPluginAsync, FastifyReply, FastifyBaseLogger } from 'fastify';
import type { Db } from 'mongodb';
import { SearchRequestSchema } from '@dmdoc/shared-types';
import type { SearchChunk, Citation } from '@dmdoc/shared-types';
import { hybridSearch, lexicalSearch, vectorSearch, documentMetadataSearch } from '@dmdoc/db-mongo';
import type { ChunkSearchResult } from '@dmdoc/db-mongo';
import { createLLMProvider } from '@dmdoc/llm-provider';
import type { LLMProvider } from '@dmdoc/llm-provider';
import type { Config } from '../config.js';
import { embedQuery } from '../services/embedding.js';
import { parseCitations } from '../services/citation-parser.js';
import { RAG_ANSWER_PROMPT } from '../prompts/rag-answer.js';
import { resolveTenantContext } from '../auth/resolve-tenant.js';

// ---------------------------------------------------------------------------
// Tipos locais
// ---------------------------------------------------------------------------

interface DepartmentPermissionDoc {
  userId: string;
  departmentId: string;
  tenantId: string;
  canRead: boolean;
}

interface DocumentDoc {
  id: string;
  tenantId: string;
  departmentId: string;
  documentTypeId: string | null;
  tags: string[];
  indexValues: Record<string, string | number | Date | null>;
  status: string;
  deleted: boolean;
}

// ---------------------------------------------------------------------------
// Helpers de permissão
// ---------------------------------------------------------------------------

/**
 * Resolve os departmentIds que o usuário pode LER.
 * TENANT_ADMIN / SUPER_ADMIN / MULTI_TENANT_ADMIN: null (sem restrição de ACL).
 *   Para MTA, os tenants já estão restritos pelo filtro $in de tenantIds — não
 *   há matriz de permissões por departamento adicional (o MTA é um admin de empresa).
 * UPLOADER / USER: somente onde canRead: true no tenant do JWT.
 */
async function resolveReadableDepartmentIds(
  db: Db,
  userId: string,
  tenantId: string,
  role: string
): Promise<string[] | null> {
  if (role === 'TENANT_ADMIN' || role === 'SUPER_ADMIN' || role === 'MULTI_TENANT_ADMIN') {
    return null;
  }
  const perms = await db
    .collection<DepartmentPermissionDoc>('department_permissions')
    .find({ userId, tenantId, canRead: true })
    .toArray();
  return perms.map((p) => p.departmentId);
}

/**
 * Parâmetros de filtros estruturados (tipagem alinhada com exactOptionalPropertyTypes).
 */
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
 * Aplica filtros estruturados na coleção `documents` e retorna os documentIds
 * que passam. Retorna `null` quando não há filtros (sem restrição por documentId).
 *
 * Aceita `tenantId` (string — mode 'single') ou `tenantIds` (string[] — mode
 * 'allowed', MULTI_TENANT_ADMIN). Para mode 'all' ambos são undefined.
 *
 * spec §9 etapa 4.
 */
async function resolveFilteredDocumentIds(
  db: Db,
  tenantId: string | undefined,
  tenantIds: string[] | undefined,
  allowedDepartmentIds: string[] | null,
  filters: StructuredFilters | undefined
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

  type DocFilter = Record<string, unknown>;
  const filter: DocFilter = { deleted: false, status: 'READY' };

  // Injeta filtro de tenant conforme o modo de contexto
  if (tenantIds !== undefined && tenantIds.length > 0) {
    filter['tenantId'] = { $in: tenantIds };
  } else if (tenantId !== undefined) {
    filter['tenantId'] = tenantId;
  }

  if (filters?.departmentIds !== undefined) {
    const requested = filters.departmentIds;
    if (allowedDepartmentIds !== null) {
      const allowed = requested.filter((id) => allowedDepartmentIds.includes(id));
      if (allowed.length === 0) return [];
      filter['departmentId'] = { $in: allowed };
    } else {
      filter['departmentId'] = { $in: requested };
    }
  } else if (allowedDepartmentIds !== null) {
    filter['departmentId'] = { $in: allowedDepartmentIds };
  }

  if (filters?.documentTypeIds !== undefined && filters.documentTypeIds.length > 0) {
    filter['documentTypeId'] = { $in: filters.documentTypeIds };
  }

  if (filters?.tags !== undefined && filters.tags.length > 0) {
    filter['tags'] = { $all: filters.tags };
  }

  if (filters?.indexFilters !== undefined) {
    for (const [fieldName, conditions] of Object.entries(filters.indexFilters)) {
      const fieldConditions: Record<string, unknown> = {};
      if (conditions.gte !== undefined) fieldConditions['$gte'] = conditions.gte;
      if (conditions.lte !== undefined) fieldConditions['$lte'] = conditions.lte;
      if (conditions.eq !== undefined) fieldConditions['$eq'] = conditions.eq;
      if (Object.keys(fieldConditions).length > 0) {
        filter[`indexValues.${fieldName}`] = fieldConditions;
      }
    }
  }

  const docs = await db
    .collection<DocumentDoc>('documents')
    .find(filter)
    .project<{ id: string }>({ id: 1 })
    .toArray();

  return docs.map((d) => d.id);
}

// ---------------------------------------------------------------------------
// Plugin de rotas
// ---------------------------------------------------------------------------

export interface SearchRoutesOptions {
  config: Config;
}

/**
 * Rotas de Busca RAG — Fase 4.
 *
 * `POST /search` — busca híbrida (lexical + vetorial) com geração opcional
 * de resposta via LLM. Suporta dois modos de resposta:
 *
 * - `generateAnswer: false` → resposta JSON síncrona com chunks relevantes.
 * - `generateAnswer: true`  → resposta SSE com streaming de texto + metadados
 *   finais (citações, custo, chunks) no evento `done`.
 *
 * Recebe `config` por opção para não chamar `getConfig()` no momento do
 * registro — isso permite que os testes injetem config sem variáveis reais.
 *
 * Spec §9 — Pipeline de busca RAG.
 */
export const searchRoutes: FastifyPluginAsync<SearchRoutesOptions> = async (app, options) => {
  const { config } = options;

  // Cliente OpenAI para embeddings (sempre OpenAI, não OpenRouter)
  const openaiClient = new OpenAI({
    apiKey: config.OPENAI_API_KEY || 'sk-placeholder',
    baseURL: 'https://api.openai.com/v1',
  });

  // LLM provider para geração de resposta (pode ser OpenAI ou OpenRouter)
  const llmProvider = createLLMProvider(
    {
      provider: config.LLM_PROVIDER,
      baseURL: config.LLM_BASE_URL,
      apiKey: config.LLM_API_KEY || 'placeholder',
      model: config.LLM_MODEL,
    },
    app.log
  );

  // =========================================================================
  // POST /search
  // =========================================================================
  app.post('/search', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.user!.sub;
    const role = request.user!.role;
    const db = app.db;

    // ------------------------------------------------------------------
    // 1. Validar body e resolver contexto de tenant
    // ------------------------------------------------------------------
    const body = SearchRequestSchema.parse(request.body);

    const { tenantId: tenantIdParam } = z.object({ tenantId: z.string().uuid().optional() }).parse(request.query);
    const context = resolveTenantContext(request, { explicitTenantId: tenantIdParam, write: false });
    const { query, searchMode, filters, topK, generateAnswer } = body;

    // tenantId / tenantIds para os pipelines de busca conforme o mode
    const singleTenantId = context.mode === 'single' ? context.tenantId : undefined;
    const multiTenantIds = context.mode === 'allowed' ? context.tenantIds : undefined;

    // Para logs: usa o tenantId singular quando disponível
    const logTenantId = singleTenantId ?? (multiTenantIds ? `[${multiTenantIds.join(',')}]` : 'all');
    const log = request.log.child({ tenantId: logTenantId, userId, traceId: request.id });

    // ------------------------------------------------------------------
    // 2. Resolver departamentos acessíveis (permissões ACL)
    //    spec §9 etapa 1 — TENANT_ADMIN/SUPER_ADMIN/MTA: sem restrição (null)
    //    UPLOADER/USER: somente onde canRead: true no tenant do JWT
    // ------------------------------------------------------------------
    let allowedDepartmentIds = await resolveReadableDepartmentIds(
      db,
      userId,
      singleTenantId ?? '',
      role
    );

    // Se o request filtra por departamentos específicos, interseccionar
    if (filters?.departmentIds !== undefined && filters.departmentIds.length > 0) {
      if (allowedDepartmentIds !== null) {
        const intersection = filters.departmentIds.filter((id) =>
          (allowedDepartmentIds as string[]).includes(id)
        );
        if (intersection.length === 0) {
          if (generateAnswer) {
            return sendEmptySSE(reply, log);
          }
          return reply.status(200).send({ answer: null, citations: [], chunks: [], costUsd: 0 });
        }
        allowedDepartmentIds = intersection;
      } else {
        allowedDepartmentIds = filters.departmentIds;
      }
    }

    // ------------------------------------------------------------------
    // 3. Aplicar filtros estruturados → documentIds (spec §9 etapa 4)
    // ------------------------------------------------------------------
    const filterDocumentIds = await resolveFilteredDocumentIds(
      db,
      singleTenantId,
      multiTenantIds,
      allowedDepartmentIds,
      filters
    );

    if (filterDocumentIds !== null && filterDocumentIds.length === 0) {
      if (generateAnswer) {
        return sendEmptySSE(reply, log);
      }
      return reply.status(200).send({ answer: null, citations: [], chunks: [], costUsd: 0 });
    }

    // ------------------------------------------------------------------
    // 4. Inicia busca por metadados em paralelo (não bloqueia o embedding)
    //    Busca originalFilename e tags na coleção documents.
    // ------------------------------------------------------------------
    const metadataSearchPromise = documentMetadataSearch(db, {
      ...(singleTenantId !== undefined ? { tenantId: singleTenantId } : {}),
      ...(multiTenantIds !== undefined ? { tenantIds: multiTenantIds } : {}),
      allowedDepartmentIds,
      ...(filterDocumentIds !== null ? { filterDocumentIds } : {}),
      queryText: query,
    });

    // ------------------------------------------------------------------
    // 5. Embedding da query — apenas quando searchMode exige vetorial
    // ------------------------------------------------------------------
    let embeddingCostUsd = 0;
    let queryEmbedding: number[] | null = null;

    if (searchMode === 'vector' || searchMode === 'hybrid') {
      const result = await embedQuery(query, openaiClient, config.EMBEDDING_MODEL, log);
      queryEmbedding = result.embedding;
      embeddingCostUsd = result.costUsd;
    }

    // ------------------------------------------------------------------
    // 6. Busca por conteúdo — modo selecionado via searchMode (spec §9 etapa 3)
    // ------------------------------------------------------------------
    const baseParams = {
      ...(singleTenantId !== undefined ? { tenantId: singleTenantId } : {}),
      ...(multiTenantIds !== undefined ? { tenantIds: multiTenantIds } : {}),
      allowedDepartmentIds,
      topK,
      ...(filterDocumentIds !== null ? { filterDocumentIds } : {}),
    };

    let searchResults;

    if (searchMode === 'lexical') {
      searchResults = await lexicalSearch(db, { ...baseParams, queryText: query });
    } else if (searchMode === 'vector') {
      searchResults = await vectorSearch(db, {
        ...baseParams,
        queryEmbedding: queryEmbedding as number[],
      });
    } else {
      try {
        searchResults = await hybridSearch(db, {
          ...baseParams,
          queryText: query,
          queryEmbedding: queryEmbedding as number[],
        });
      } catch (err: unknown) {
        // $rankFusion / rankFusionScore não disponível neste MongoDB — degrada para lexical
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('rankFusionScore') || msg.includes('$rankFusion') || msg.includes('Unsupported $meta')) {
          log.warn({ err: msg }, '$rankFusion indisponível, usando lexical como fallback');
          searchResults = await lexicalSearch(db, { ...baseParams, queryText: query });
        } else {
          throw err;
        }
      }
    }

    log.info({ returned: searchResults.length, topK, searchMode }, 'busca por conteúdo concluída');

    // ------------------------------------------------------------------
    // 7. Mescla com resultados de busca por metadados (nome + tags)
    //    Documentos encontrados por metadado que já aparecem nos chunks
    //    de conteúdo são ignorados (sem duplicatas).
    // ------------------------------------------------------------------
    const metadataDocIds = await metadataSearchPromise;
    const contentDocIds = new Set(searchResults.map((r) => r.documentId));
    const metadataOnlyDocIds = metadataDocIds.filter((id) => !contentDocIds.has(id)).slice(0, 5);

    let metadataChunks: ChunkSearchResult[] = [];
    if (metadataOnlyDocIds.length > 0) {
      const chunkFilter: Record<string, unknown> = { documentId: { $in: metadataOnlyDocIds } };
      if (multiTenantIds !== undefined) {
        chunkFilter['tenantId'] = { $in: multiTenantIds };
      } else if (singleTenantId !== undefined) {
        chunkFilter['tenantId'] = singleTenantId;
      }
      if (allowedDepartmentIds !== null) {
        chunkFilter['departmentId'] = { $in: allowedDepartmentIds };
      }

      interface RawChunkDoc {
        documentId: string;
        tenantId: string;
        departmentId: string;
        documentTypeName: string | null;
        pageNumber: number | null;
        chunkIndex: number;
        text: string;
        tokenCount: number;
      }

      const rawChunks = await db
        .collection<RawChunkDoc>('chunks')
        .find(chunkFilter)
        .sort({ chunkIndex: 1 })
        .project<RawChunkDoc>({
          _id: 0,
          documentId: 1,
          tenantId: 1,
          departmentId: 1,
          documentTypeName: 1,
          pageNumber: 1,
          chunkIndex: 1,
          text: 1,
          tokenCount: 1,
        })
        .toArray();

      const seenDocIds = new Set<string>();
      metadataChunks = rawChunks
        .filter((c) => {
          if (seenDocIds.has(c.documentId)) return false;
          seenDocIds.add(c.documentId);
          return true;
        })
        .map((c) => ({ ...c, score: 0 }));

      if (metadataChunks.length > 0) {
        log.info({ metadataMatched: metadataChunks.length }, 'chunks adicionados via busca por metadados');
      }
    }

    const allSearchResults = [...searchResults, ...metadataChunks];

    // Enriquece chunks com o nome original do documento (originalFilename)
    const uniqueDocIds = [...new Set(allSearchResults.map((r) => r.documentId))];
    const docDocs = uniqueDocIds.length > 0
      ? await db.collection('documents')
          .find({ id: { $in: uniqueDocIds } })
          .project<{ id: string; originalFilename: string }>({ _id: 0, id: 1, originalFilename: 1 })
          .toArray()
      : [];
    const docNameMap = new Map(docDocs.map((d) => [d.id, d.originalFilename]));

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

    // ------------------------------------------------------------------
    // 8. Sem geração de resposta → retorno JSON síncrono
    // ------------------------------------------------------------------
    if (!generateAnswer || chunks.length === 0) {
      log.info({ generateAnswer, chunksFound: chunks.length }, 'busca sem geração de resposta');
      return reply.status(200).send({
        answer: null,
        citations: [],
        chunks,
        costUsd: embeddingCostUsd,
      });
    }

    // ------------------------------------------------------------------
    // 9. Com geração de resposta → SSE streaming (spec §9 etapas 6-7)
    // ------------------------------------------------------------------
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
    formatSSEEvent('done', { type: 'done', citations: [], chunks: [], costUsd: 0 })
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
  }
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
      })
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erro ao gerar resposta';
    log.error({ err }, 'falha na geração de resposta RAG via SSE');
    reply.raw.write(formatSSEEvent('error', { type: 'error', message }));
  } finally {
    reply.raw.end();
  }
}
