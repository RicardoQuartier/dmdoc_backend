/**
 * Utilitários de paginação e geração de IDs — pacote db-pg.
 *
 * Preserva os mesmos tipos e contrato de packages/db-mongo/src/helpers.ts,
 * sem dependência cruzada entre os dois pacotes.
 */

/**
 * Opções de paginação por cursor. A paginação do DMDoc é estável e ordenada
 * por `id` ascendente, evitando offset (que degrada em tabelas grandes e
 * pula/duplica linhas sob escrita concorrente).
 *
 * - `limit`: número máximo de itens (1..100).
 * - `cursor`: `id` do último item da página anterior (omitir na primeira página).
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

/**
 * Gera um UUID v4 via Web Crypto API (disponível nativamente no Node.js 18+).
 * Não depende de uuid/nanoid externos — elimina a dependência de npm para esta
 * função simples.
 */
export function newId(): string {
  return crypto.randomUUID();
}

/**
 * Converte uma chave camelCase para snake_case.
 * Usado internamente para mapear campos TypeScript para colunas SQL.
 *
 * Exemplos:
 *   tenantId     → tenant_id
 *   uploadedById → uploaded_by_id
 *   mimeType     → mime_type
 *   createdAt    → created_at
 *   id           → id
 */
export function toSnakeCase(key: string): string {
  return key.replace(/([A-Z])/g, '_$1').toLowerCase();
}
