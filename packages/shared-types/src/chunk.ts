import { z } from 'zod';

/**
 * Chunk de texto de um documento, com embedding vetorial.
 *
 * Um documento é dividido em chunks de ~500 tokens com overlap de 50 tokens.
 * Cada chunk gera um embedding com `text-embedding-3-small` (1536 dimensões).
 *
 * Campos para filtros na busca vetorial e lexical:
 * - `tenantId` e `departmentId` isolam resultados por empresa/departamento.
 * - `documentTypeName` filtra por tipo de documento (desnormalizado para
 *   evitar lookup extra no pipeline de busca — ver spec §5.3).
 * - `documentId` permite recuperar todos os chunks de um documento.
 *
 * `embedding` é `z.array(z.number())` sem validar o tamanho aqui — a dimensão
 * (1536) é garantida pelo adaptador de embeddings em `packages/llm-provider`.
 *
 * Spec §5.3 (coleção `chunks`).
 */
export const ChunkSchema = z.object({
  documentId: z.string().uuid(),
  tenantId: z.string().uuid(),
  documentTypeName: z.string().nullable(),
  departmentId: z.string().uuid(),
  pageNumber: z.number().int().nonnegative().nullable(),
  chunkIndex: z.number().int().nonnegative(),
  text: z.string().min(1),
  embedding: z.array(z.number()),
  tokenCount: z.number().int().nonnegative(),
  createdAt: z.date(),
});

export type Chunk = z.infer<typeof ChunkSchema>;
