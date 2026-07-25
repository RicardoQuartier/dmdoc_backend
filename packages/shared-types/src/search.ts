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
 * `searchMode` (PostgreSQL 16 + pgvector):
 *   - `lexical`  → full-text search (tsvector/tsquery) — sem embedding, sem API externa
 *   - `vector`   → similaridade de embeddings via pgvector — requer embedding
 *   - `hybrid`   → Reciprocal Rank Fusion em SQL (lexical + vetorial) — requer embedding
 *
 * `generateAnswer`: se true, passa os chunks para o LLM e retorna
 *   resposta gerada + citações. Requer LLM_API_KEY configurado.
 *
 * `page` / `pageSize`: paginação server-side da lista de resultados (E-5).
 *   O teto de `pageSize` é 100 — deliberadamente menor que os 500 de
 *   `ListDocumentsQuerySchema` (apps/api/src/routes/documents.ts), porque cada
 *   item da busca carrega o `text` completo de um chunk.
 *
 * ESCOPO DA PAGINAÇÃO (decisão E-5): a paginação exata — `total`/`pageCount`
 *   confiáveis e navegação estável entre páginas — vale apenas para
 *   `searchMode: 'lexical'`, onde o motor consegue contar o universo completo de
 *   resultados. Nos modos `vector` e `hybrid` o conjunto candidato é truncado
 *   pelo ranqueador (ver wiki "Busca híbrida PostgreSQL: parâmetros RRF"), então
 *   `total` reflete apenas o que foi ranqueado, não o universo do tenant.
 *
 * `topK`: NÃO rege o tamanho da lista de resultados (isso é `pageSize`). Rege
 *   quantos chunks — os mais relevantes — alimentam o LLM quando
 *   `generateAnswer: true`. Padrão 10, máx 50. O caminho RAG depende dele.
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
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
  topK: z.number().int().min(1).max(50).default(10),
  generateAnswer: z.boolean().default(false),
});

export type SearchRequest = z.infer<typeof SearchRequestSchema>;

/**
 * Um valor de índice de um documento exposto na resposta da busca.
 *
 * Só entram os campos cujo `IndexField.showOnSearch` está ligado (flag
 * "aparece na busca") e que possuem valor preenchido no documento. Os itens
 * vêm na ordem de exibição do campo (`sortOrder`).
 *
 * `label` reflete o rótulo do campo (`IndexField.name`, também usado como
 * chave em `documents.indexValues`); `fieldName` é essa mesma chave.
 */
export const SearchChunkIndexValueSchema = z.object({
  fieldName: z.string(),
  label: z.string(),
  fieldType: z.string(),
  value: z.union([z.string(), z.number()]),
});

export type SearchChunkIndexValue = z.infer<typeof SearchChunkIndexValueSchema>;

/**
 * Um chunk retornado na resposta da busca.
 *
 * `score` é a relevância calculada pelo motor (rankFusion, vector ou lexical).
 * `pageNumber` pode ser null quando não determinável (ex.: DOCX sem paginação).
 *
 * `title` é o título de exibição CONFIRMADO do documento (`documents.title`).
 * Vem `null` quando não há confirmação — o fallback para `documentName`
 * (nome do arquivo) é responsabilidade do front. A sugestão bruta da IA
 * (`suggestedTitle`) NUNCA é exposta aqui (invariante da wiki "Título de
 * exibição sugerido por IA").
 *
 * `indexValues` traz apenas os índices "que aparecem na busca" (showOnSearch)
 * do documento, com rótulo, tipo e valor, na ordem de exibição do campo.
 *
 * `tags` são as tags CONFIRMADAS do documento (`documents.tags`) — usadas para
 * renderizar os chips coloridos no card de resultado (Fase 9 / E-3). As tags
 * SUGERIDAS pela IA (`document_content.suggested_tags`) nunca aparecem aqui: só
 * o confirmado pelo usuário vale na busca. Array vazio quando o documento não
 * tem tags.
 */
export const SearchChunkSchema = z.object({
  documentId: z.string(),
  documentName: z.string().nullable(),
  title: z.string().nullable(),
  indexValues: z.array(SearchChunkIndexValueSchema),
  tags: z.array(z.string()),
  tenantId: z.string().nullable(),
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
 *
 * `chunks` mantém o nome histórico por compatibilidade com os consumidores
 * atuais, mas passa a conter a PÁGINA de resultados (1 item por documento),
 * recortada por `page`/`pageSize` — não mais os `topK` chunks brutos.
 *
 * `page`/`pageSize` ecoam o que foi efetivamente aplicado; `total` é a
 * quantidade de resultados que casam com a busca e `pageCount` o número de
 * páginas (`ceil(total / pageSize)`; 0 quando `total` é 0).
 *
 * Atenção ao escopo (E-5): `total` e `pageCount` só são exatos em
 * `searchMode: 'lexical'`. Em `vector`/`hybrid` refletem o conjunto ranqueado,
 * não o universo de documentos elegíveis — ver o comentário do
 * `SearchRequestSchema`.
 */
export const SearchResponseSchema = z.object({
  answer: z.string().nullable(),
  citations: z.array(CitationSchema),
  chunks: z.array(SearchChunkSchema),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  total: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative(),
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
