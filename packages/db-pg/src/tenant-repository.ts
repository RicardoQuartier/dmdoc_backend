import type { Sql } from 'postgres';
import { newId, normalizeLimit, toSnakeCase, type Page, type PaginationOptions } from './helpers.js';
import { hasTenant, type RepositoryContext } from './tenant-context.js';

/**
 * Forma mínima de todo documento armazenado pelo wrapper.
 *
 * - `id`: UUID lógico de negócio (PK da linha no PostgreSQL).
 * - `tenantId`: empresa dona do recurso. Injetado pelo wrapper — quem chama
 *   nunca o informa em `insertOne`.
 * - `deleted`: marca de exclusão lógica. Injetado como `false` em todo insert
 *   e filtrado como `false` em toda leitura.
 */
export interface TenantDocument {
  id: string;
  tenantId: string;
  deleted: boolean;
}

/**
 * Dados de criação aceitos pelo wrapper: o documento sem os campos que o
 * próprio wrapper gerencia (`id`, `tenantId`, `deleted`). O `id` pode ser
 * fornecido (idempotência/seed); se ausente, é gerado.
 */
export type CreateInput<T extends TenantDocument> = Omit<T, 'id' | 'tenantId' | 'tenant_id' | 'deleted'> & {
  id?: string;
};

/**
 * Campos atualizáveis: tudo exceto os gerenciados pelo wrapper e o `id`.
 */
export type UpdateInput<T extends TenantDocument> = Partial<Omit<T, 'id' | 'tenantId' | 'tenant_id' | 'deleted'>>;

/**
 * Wrapper central de isolamento multi-tenant + exclusão lógica — PostgreSQL.
 *
 * Garante, sem depender da disciplina de quem chama (spec §5.4 e §10):
 *
 * 1. **tenantId automático.** Toda leitura injeta `tenant_id` no WHERE; todo
 *    insert grava `tenant_id`. Um recurso de outra empresa é INALCANÇÁVEL:
 *    `findById` de um id de outro tenant retorna `null` (a rota traduz em 404,
 *    nunca 403 — não vaza existência).
 *
 * 2. **deleted=false automático.** Toda LEITURA (find/findOne/count) injeta
 *    `AND deleted = false`. `softDelete` apenas marca `deleted = true` — a linha
 *    permanece no banco para auditoria e integridade referencial.
 *
 * 3. **SUPER_ADMIN explícito.** Construído com contexto `null`, o repositório
 *    NÃO opera sem um `tenantId` passado explicitamente em cada chamada (via
 *    `forTenant(tenantId)`). Acesso cross-empresa é sempre intencional. Tentar
 *    operar em modo SUPER_ADMIN sem escopo lança erro — falha fechada.
 *
 * Implementação com postgres.js
 * --------------------------------
 * Toda query usa sql`...` parametrizado. Identificadores dinâmicos (nome de
 * tabela, coluna) passam por sql(identifier) — postgres.js os trata como
 * identificadores escapados, nunca como valores. Os valores do filtro
 * transitam como parâmetros $N automaticamente.
 *
 * O postgres.js suporta `sql(object)` para INSERT/UPDATE (converte chaves para
 * snake_case automaticamente quando `transform.column.to` está configurado, mas
 * como usamos o cliente sem transform, convertemos explicitamente via toSnakeCase
 * antes de passar o objeto).
 *
 * Para WHERE dinâmico (filtros opcionais), construímos a condição usando
 * `sql.unsafe` com parâmetros explícitos — o padrão recomendado pelo
 * postgres.js para cláusulas WHERE construídas programaticamente.
 */
export class TenantRepository<T extends TenantDocument> {
  private readonly sql: Sql;
  private readonly tableName: string;
  private readonly context: RepositoryContext;

  /**
   * @param sql        Instância postgres.js (pool de conexões).
   * @param tableName  Nome da tabela PostgreSQL (snake_case, ex: 'documents').
   * @param context    `{ tenantId }` para operação normal, ou `null` para
   *                   SUPER_ADMIN (que deve escopar via `forTenant`).
   */
  constructor(sql: Sql, tableName: string, context: RepositoryContext) {
    this.sql = sql;
    this.tableName = tableName;
    this.context = context;
  }

  /**
   * Deriva um repositório escopado a uma empresa específica. É o ÚNICO caminho
   * para um SUPER_ADMIN (contexto `null`) operar sobre dados: ele seleciona a
   * empresa-alvo explicitamente. Também pode ser usado para trocar de escopo.
   */
  forTenant(tenantId: string): TenantRepository<T> {
    return new TenantRepository<T>(this.sql, this.tableName, { tenantId });
  }

  /**
   * Resolve o `tenantId` efetivo da operação. Falha fechada se SUPER_ADMIN
   * tentar operar sem escopo explícito.
   */
  private requireTenantId(): string {
    if (!hasTenant(this.context)) {
      throw new Error(
        'Operação sem tenant: contexto SUPER_ADMIN exige seleção explícita de empresa via forTenant(tenantId).'
      );
    }
    return this.context.tenantId;
  }

  /**
   * Constrói pares de condição WHERE a partir de um filtro parcial.
   *
   * Remove os campos gerenciados pelo wrapper (`id`, `tenantId`, `deleted`) — eles
   * são adicionados explicitamente pelas queries. Converte chaves camelCase para
   * snake_case. Retorna array de `{ col: string; value: unknown }` pronto para
   * ser montado via `sql.unsafe`.
   */
  private filterToPairs(
    filter: Record<string, unknown>
  ): Array<{ col: string; value: unknown }> {
    const managed = new Set(['tenantId', 'tenant_id', 'deleted']);
    return Object.entries(filter)
      .filter(([k]) => !managed.has(k))
      .map(([k, v]) => ({ col: toSnakeCase(k), value: v }));
  }

  /**
   * Busca um recurso pelo `id` de negócio. Retorna `null` se não existir,
   * se pertencer a outra empresa, ou se estiver excluído logicamente.
   */
  async findById(id: string): Promise<T | null> {
    const tenantId = this.requireTenantId();

    const rows = await this.sql<T[]>`
      SELECT *
      FROM ${this.sql(this.tableName)}
      WHERE id = ${id}
        AND tenant_id = ${tenantId}
        AND deleted = false
      LIMIT 1
    `;

    return rows[0] ?? null;
  }

  /**
   * Busca o primeiro recurso que casa o filtro, dentro do escopo de empresa
   * e ignorando excluídos.
   */
  async findOne(filter: Partial<T> = {}): Promise<T | null> {
    const tenantId = this.requireTenantId();
    const pairs = this.filterToPairs(filter as Record<string, unknown>);

    if (pairs.length === 0) {
      const rows = await this.sql<T[]>`
        SELECT *
        FROM ${this.sql(this.tableName)}
        WHERE tenant_id = ${tenantId}
          AND deleted = false
        LIMIT 1
      `;
      return rows[0] ?? null;
    }

    // Construir cláusula AND extra com sql.unsafe para colunas dinâmicas.
    // Os valores são passados como parâmetros posicionais ($1, $2...) pelo postgres.js.
    const extraWhere = pairs
      .map((p) => `${p.col} = $${p.col}`)
      .join(' AND ');
    const extraValues = Object.fromEntries(pairs.map((p) => [p.col, p.value]));

    const query = `
      SELECT *
      FROM "${this.tableName}"
      WHERE tenant_id = $1
        AND deleted = false
        AND ${extraWhere}
      LIMIT 1
    `;

    // Usar unsafe é necessário aqui pois os nomes de coluna são dinâmicos.
    // Os VALUES são todos parâmetros — nunca interpolação de dados do usuário.
    const allValues: unknown[] = [tenantId, ...pairs.map((p) => extraValues[p.col])];
    const parameterizedQuery = query.replace(
      /\$(\w+)/g,
      (_, name: string) => {
        const idx = pairs.findIndex((p) => p.col === name);
        return `$${idx + 2}`;
      }
    );

    const rows = await this.sql.unsafe<T[]>(parameterizedQuery, allValues as Parameters<Sql['unsafe']>[1]);
    return rows[0] ?? null;
  }

  /**
   * Lista recursos com paginação por cursor estável (ordenada por `id` ASC).
   * Nunca retorna recursos de outra empresa nem excluídos.
   *
   * Paginação cursor-based: `WHERE id > $lastId ORDER BY id LIMIT n+1`.
   * Busca n+1 para detectar se há página seguinte sem COUNT(*).
   */
  async findMany(
    filter: Partial<T> = {},
    pagination: PaginationOptions = { limit: 20 }
  ): Promise<Page<T>> {
    const tenantId = this.requireTenantId();
    const limit = normalizeLimit(pagination.limit);
    const pairs = this.filterToPairs(filter as Record<string, unknown>);

    let paramIdx = 1;
    const params: unknown[] = [];

    const addParam = (value: unknown): string => {
      params.push(value);
      return `$${paramIdx++}`;
    };

    const tenantParam = addParam(tenantId);
    let whereExtra = '';

    if (pagination.cursor !== undefined) {
      const cursorParam = addParam(pagination.cursor);
      whereExtra += ` AND id > ${cursorParam}`;
    }

    for (const { col, value } of pairs) {
      const p = addParam(value);
      whereExtra += ` AND "${col}" = ${p}`;
    }

    const limitParam = addParam(limit + 1);

    const query = `
      SELECT *
      FROM "${this.tableName}"
      WHERE tenant_id = ${tenantParam}
        AND deleted = false
        ${whereExtra}
      ORDER BY id ASC
      LIMIT ${limitParam}
    `;

    const rows = await this.sql.unsafe<T[]>(query, params as Parameters<Sql['unsafe']>[1]);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    const nextCursor = hasMore && last !== undefined ? last.id : null;

    return { items: page, nextCursor };
  }

  /**
   * Conta recursos do escopo (empresa + não excluídos) que casam o filtro.
   * Usado, por exemplo, na validação de cota de usuários por empresa.
   */
  async count(filter: Partial<T> = {}): Promise<number> {
    const tenantId = this.requireTenantId();
    const pairs = this.filterToPairs(filter as Record<string, unknown>);

    let paramIdx = 1;
    const params: unknown[] = [];

    const addParam = (value: unknown): string => {
      params.push(value);
      return `$${paramIdx++}`;
    };

    const tenantParam = addParam(tenantId);
    let whereExtra = '';

    for (const { col, value } of pairs) {
      const p = addParam(value);
      whereExtra += ` AND "${col}" = ${p}`;
    }

    const query = `
      SELECT COUNT(*) AS count
      FROM "${this.tableName}"
      WHERE tenant_id = ${tenantParam}
        AND deleted = false
        ${whereExtra}
    `;

    const rows = await this.sql.unsafe<Array<{ count: string }>>(
      query,
      params as Parameters<Sql['unsafe']>[1]
    );

    return parseInt(rows[0]?.count ?? '0', 10);
  }

  /**
   * Insere um recurso. O wrapper grava `tenant_id` (da empresa em escopo),
   * `deleted = false` e gera `id` se ausente. Retorna o documento completo
   * com os dados conforme retornados pelo banco (incluindo defaults do DB).
   *
   * O objeto passado para `sql(record)` deve ter chaves em snake_case — o
   * postgres.js não aplica nenhuma transformação de nomes quando o cliente
   * foi criado sem `transform.column.to`.
   */
  async insertOne(data: CreateInput<T>): Promise<T> {
    const tenantId = this.requireTenantId();

    const id = (data as { id?: string }).id ?? newId();

    // Construir o record em snake_case para o INSERT
    const snakeCaseRecord: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (key === 'id') continue; // adicionado explicitamente abaixo
      snakeCaseRecord[toSnakeCase(key)] = value;
    }
    snakeCaseRecord['id'] = id;
    snakeCaseRecord['tenant_id'] = tenantId;
    snakeCaseRecord['deleted'] = false;

    const rows = await this.sql<T[]>`
      INSERT INTO ${this.sql(this.tableName)} ${this.sql(snakeCaseRecord)}
      RETURNING *
    `;

    const inserted = rows[0];
    if (inserted === undefined) {
      throw new Error(`insertOne falhou silenciosamente na tabela ${this.tableName}`);
    }
    return inserted;
  }

  /**
   * Atualiza campos de um recurso pelo `id`, restrito à empresa em escopo e
   * a recursos não excluídos. Não permite alterar `id`, `tenantId` nem
   * `deleted` (este último só muda via `softDelete`). Retorna o documento
   * atualizado, ou `null` se não encontrado no escopo.
   */
  async updateById(id: string, data: UpdateInput<T>): Promise<T | null> {
    const tenantId = this.requireTenantId();

    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) {
      return this.findById(id);
    }

    // Converter chaves camelCase para snake_case
    const snakeCaseData: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      snakeCaseData[toSnakeCase(key)] = value;
    }

    const rows = await this.sql<T[]>`
      UPDATE ${this.sql(this.tableName)}
      SET ${this.sql(snakeCaseData)}
      WHERE id = ${id}
        AND tenant_id = ${tenantId}
        AND deleted = false
      RETURNING *
    `;

    return rows[0] ?? null;
  }

  /**
   * Exclusão lógica: marca `deleted = true`. A linha NÃO é removida
   * fisicamente — permanece para auditoria e integridade referencial.
   * Após isto, todas as leituras do wrapper deixam de retorná-la.
   * Retorna `true` se algo foi marcado (existia, no escopo, não excluído).
   */
  async softDelete(id: string): Promise<boolean> {
    const tenantId = this.requireTenantId();

    const result = await this.sql`
      UPDATE ${this.sql(this.tableName)}
      SET deleted = true
      WHERE id = ${id}
        AND tenant_id = ${tenantId}
        AND deleted = false
    `;

    return result.count > 0;
  }
}

/**
 * Atalho para criar um repositório a partir de uma conexão, tabela e contexto.
 */
export function createTenantRepository<T extends TenantDocument>(
  sql: Sql,
  tableName: string,
  context: RepositoryContext
): TenantRepository<T> {
  return new TenantRepository<T>(sql, tableName, context);
}
