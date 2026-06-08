import { ObjectId } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';

/**
 * Gera um UUID v4 — o `id` lógico de todo recurso do DMDoc.
 * IDs de negócio são uuid (string); `_id` (ObjectId) é interno do Mongo.
 */
export function newId(): string {
  return uuidv4();
}

/**
 * Converte uma string em ObjectId. Lança erro tipado se inválida.
 * Usado apenas para os poucos campos que referenciam `_id` (ex.: `mongoContentId`).
 * IDs de negócio do DMDoc são uuid string — para esses não use isto.
 */
export function toObjectId(id: string): ObjectId {
  if (!ObjectId.isValid(id)) {
    throw new Error(`ObjectId inválido: ${id}`);
  }
  return new ObjectId(id);
}

/**
 * Opções de paginação por cursor. A paginação do DMDoc é estável e ordenada
 * por `createdAt` ascendente desempatado por `id`, evitando offset (que degrada
 * em coleções grandes e pula/duplica itens sob escrita concorrente).
 *
 * - `limit`: número máximo de itens (1..100).
 * - `cursor`: `id` do último item da página anterior (opcional na primeira página).
 */
export interface PaginationOptions {
  limit: number;
  cursor?: string;
}

/**
 * Resultado paginado. `nextCursor` é o `id` a passar na próxima chamada,
 * ou `null` quando não há mais páginas.
 */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Normaliza o limite de paginação para a faixa permitida [1, 100].
 */
export function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_LIMIT;
  }
  const truncated = Math.trunc(limit);
  if (truncated < 1) {
    return 1;
  }
  if (truncated > MAX_LIMIT) {
    return MAX_LIMIT;
  }
  return truncated;
}
