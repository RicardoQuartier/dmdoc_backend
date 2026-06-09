import { z } from 'zod';

/**
 * Filtros estruturados para busca por valores de índice.
 *
 * `gte` e `lte` aceitam strings ISO 8601 (datas), números ou strings.
 * O serviço de busca converte os tipos conforme o campo indexado.
 *
 * Spec §7 (POST /search, campo `filters.indexFilters`).
 */
export const IndexFilterValueSchema = z.object({
  gte: z.union([z.string(), z.number()]).optional(),
  lte: z.union([z.string(), z.number()]).optional(),
  eq: z.union([z.string(), z.number()]).optional(),
});

export type IndexFilterValue = z.infer<typeof IndexFilterValueSchema>;

/**
 * Body do POST /search (spec §7 — Busca RAG).
 *
 * `searchMode`:
 *   - `lexical`  → Atlas Search ($search) — sem embedding, sem API externa
 *   - `vector`   → Atlas Vector Search ($vectorSearch) — requer embedding
 *   - `hybrid`   → $rankFusion (lexical + vetorial) — requer embedding
 *
 * `generateAnswer`: se true, passa os chunks para o LLM e retorna
 *   resposta gerada + citações. Requer LLM_API_KEY configurado.
 *
 * `topK`: número de chunks mais relevantes a retornar (padrão 10, máx 50).
 *
 * `filters.departmentIds`: restringe a busca a departamentos específicos.
 *   Se ausente, usa todos os departamentos que o usuário pode ler.
 */
export const SearchRequestSchema = z.object({
  query: z.string().min(1).max(2000),
  searchMode: z.enum(['lexical', 'vector', 'hybrid']).default('hybrid'),
  filters: z
    .object({
      departmentIds: z.array(z.string().uuid()).optional(),
      documentTypeIds: z.array(z.string().uuid()).optional(),
      tags: z.array(z.string()).optional(),
      indexFilters: z.record(IndexFilterValueSchema).optional(),
    })
    .optional(),
  topK: z.number().int().min(1).max(50).default(10),
  generateAnswer: z.boolean().default(false),
});

export type SearchRequest = z.infer<typeof SearchRequestSchema>;

/**
 * Um chunk retornado na resposta da busca.
 *
 * `score` é a relevância calculada pelo motor (rankFusion, vector ou lexical).
 * `pageNumber` pode ser null quando não determinável (ex.: DOCX sem paginação).
 */
export const SearchChunkSchema = z.object({
  documentId: z.string(),
  documentTypeName: z.string().nullable(),
  pageNumber: z.number().nullable(),
  chunkIndex: z.number(),
  text: z.string(),
  score: z.number(),
});

export type SearchChunk = z.infer<typeof SearchChunkSchema>;

/**
 * Uma citação na resposta RAG — referência a um documento/página específica.
 *
 * Gerada pelo parsing da resposta do LLM: o prompt instrui o modelo a
 * referenciar os documentos que embasaram cada afirmação.
 */
export const CitationSchema = z.object({
  documentId: z.string(),
  pageNumber: z.number().nullable(),
  excerpt: z.string(),
});

export type Citation = z.infer<typeof CitationSchema>;

/**
 * Resposta do POST /search.
 *
 * `answer` é null quando `generateAnswer: false` (busca sem LLM).
 * `citations` é vazio quando `generateAnswer: false`.
 * `costUsd` acumula embedding da query + geração de resposta (se ativada).
 */
export const SearchResponseSchema = z.object({
  answer: z.string().nullable(),
  citations: z.array(CitationSchema),
  chunks: z.array(SearchChunkSchema),
  costUsd: z.number().nonnegative(),
});

export type SearchResponse = z.infer<typeof SearchResponseSchema>;

/**
 * Evento SSE emitido durante o streaming da resposta RAG.
 *
 * Tipos de evento:
 * - `chunk`: fragmento de texto da resposta do LLM.
 * - `done`: sinaliza fim do stream com dados finais (citações, custo, chunks).
 * - `error`: erro durante a geração (stream encerrado com falha).
 */
export const SSEChunkEventSchema = z.object({
  type: z.literal('chunk'),
  text: z.string(),
});

export const SSEDoneEventSchema = z.object({
  type: z.literal('done'),
  citations: z.array(CitationSchema),
  chunks: z.array(SearchChunkSchema),
  costUsd: z.number().nonnegative(),
});

export const SSEErrorEventSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
});

export const SSEEventSchema = z.discriminatedUnion('type', [
  SSEChunkEventSchema,
  SSEDoneEventSchema,
  SSEErrorEventSchema,
]);

export type SSEChunkEvent = z.infer<typeof SSEChunkEventSchema>;
export type SSEDoneEvent = z.infer<typeof SSEDoneEventSchema>;
export type SSEErrorEvent = z.infer<typeof SSEErrorEventSchema>;
export type SSEEvent = z.infer<typeof SSEEventSchema>;
