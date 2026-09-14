import type { Sql, TransactionSql } from 'postgres';
import { normalizeLimit } from './helpers.js';
import { hasTenant, type RepositoryContext } from './tenant-context.js';
import type { EvaluatedDocumentEntry } from './schema.js';

/** Data pura no formato `YYYY-MM-DD` (coluna `date`, sem hora e sem fuso). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** UUID canônico (qualquer versão) — `id` fora do formato nunca é consultado. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Conexão aceita pelo repositório: o pool (`Sql`) ou o `tx` recebido em
 * `sql.begin(async (tx) => …)`. Ver "Uso transacional" na classe.
 */
export type EvaluatedDocumentEntriesSql = Sql | TransactionSql;

/**
 * No postgres.js, `savepoint` só existe no escopo de transação (`tx`); o pool
 * não tem. É o que distingue as duas formas em tempo de execução.
 */
function isTransaction(q: EvaluatedDocumentEntriesSql): q is TransactionSql {
  return typeof (q as Partial<TransactionSql>).savepoint === 'function';
}

/**
 * Input de criação. O repositório injeta `id`, `tenant_id`, `created_at` e
 * `updated_at`; quem chama nunca informa esses campos.
 */
export interface CreateEvaluatedDocumentEntryInput {
  /**
   * Usuário a quem as páginas são atribuídas. O banco só garante que ele
   * EXISTE (FK simples); "da mesma empresa" é validado pela API.
   */
  userId: string;
  /** Dia da avaliação, `YYYY-MM-DD`. */
  evaluatedOn: string;
  /** Inteiro > 0 (garantido pelo CHECK do banco). */
  pageCount: number;
  /** Ator que fez o lançamento. `null` só em rotinas de sistema. */
  createdById: string | null;
}

/**
 * Patch de edição. Campos ausentes (`undefined`) ficam como estão;
 * `updatedById` é obrigatório porque toda edição tem autor.
 */
export interface UpdateEvaluatedDocumentEntryInput {
  userId?: string;
  evaluatedOn?: string;
  pageCount?: number;
  updatedById: string | null;
}

/** Resultado de `update`: estado antes e depois, para o audit log da API. */
export interface EvaluatedDocumentEntryUpdateResult {
  before: EvaluatedDocumentEntry;
  after: EvaluatedDocumentEntry;
}

/**
 * Filtro comum de `summary` e `listPaged`. Todos os campos são opcionais.
 *
 * - `dateFrom`/`dateTo`: `YYYY-MM-DD`, bordas INCLUSIVAS (`evaluated_on`
 *   entre as duas datas, as duas contando).
 * - `userIds`: `undefined` = sem filtro de usuário. **Array vazio = nenhum
 *   usuário = resultado vazio** (falha fechada: um escopo de usuários vazio
 *   calculado pela API nunca vira "todos").
 */
export interface EvaluatedDocumentEntriesFilter {
  dateFrom?: string;
  dateTo?: string;
  userIds?: string[];
}

/** Agregado de um usuário no `summary`. `userId` nulo = usuário purgado. */
export interface EvaluatedDocumentEntriesByUserRow {
  userId: string | null;
  entries: number;
  pages: number;
}

/** Resultado de `summary`: totais do filtro + quebra por usuário (páginas DESC). */
export interface EvaluatedDocumentEntriesSummary {
  totals: { entries: number; pages: number };
  byUser: EvaluatedDocumentEntriesByUserRow[];
}

/** Paginação por página/tamanho (a lista do relatório exibe "página X de Y"). */
export interface EvaluatedDocumentEntriesPageOptions extends EvaluatedDocumentEntriesFilter {
  /** 1-based. Valores < 1 ou não inteiros viram 1. */
  page?: number;
  /** 1..100 (padrão 20), normalizado por `normalizeLimit`. */
  pageSize?: number;
}

/** Página de lançamentos + total do filtro (sem paginação). */
export interface EvaluatedDocumentEntriesPage {
  items: EvaluatedDocumentEntry[];
  total: number;
  page: number;
  pageSize: number;
}

/** Linha crua (snake_case) devolvida pelo postgres.js. */
interface EntryRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  evaluated_on: string;
  page_count: number;
  created_by_id: string | null;
  updated_by_id: string | null;
  deleted_by_id: string | null;
  created_at: Date;
  updated_at: Date;
  deleted: boolean;
  deleted_at: Date | null;
}

function toEntry(row: EntryRow): EvaluatedDocumentEntry {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    evaluatedOn: row.evaluated_on,
    pageCount: row.page_count,
    createdById: row.created_by_id,
    updatedById: row.updated_by_id,
    deletedById: row.deleted_by_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deleted: row.deleted,
    deletedAt: row.deleted_at,
  };
}

function assertIsoDate(value: string, field: string): void {
  if (!ISO_DATE.test(value)) {
    throw new Error(`${field} precisa estar no formato YYYY-MM-DD (recebido: "${value}")`);
  }
}

/**
 * Repositório de `evaluated_document_entries` — lançamentos MANUAIS de páginas
 * avaliadas (épico E-13), fonte da seção "Documentos avaliados" do relatório
 * de Uso e Cobrança.
 *
 * Diferente de `document_events` (automático e append-only), aqui o lançamento
 * é corrigível: tem `update` e `softDelete`, e TODA leitura filtra
 * `deleted = false` — lançamento excluído sai dos totais, mas a linha fica.
 *
 * Invariantes:
 * - **Isolamento.** Toda query carrega `tenant_id` do contexto. Id de outra
 *   empresa se comporta como inexistente (`null`), nunca como erro de acesso.
 *   O contexto SUPER_ADMIN (`null`) é recusado: a operação exige empresa.
 * - **Sem SQL concatenado.** Filtros opcionais são fragmentos parametrizados
 *   do postgres.js; não há `sql.unsafe`.
 * - **Datas como texto `YYYY-MM-DD`.** `evaluated_on` é lida via `to_char` —
 *   o parser padrão do postgres.js converteria `date` em `Date` à meia-noite
 *   UTC, e no fuso de Brasília isso vira o dia anterior na tela.
 *
 * Fora do escopo daqui: regra de hierarquia (quem pode ver/lançar para quem),
 * "usuário da mesma empresa", nomes de usuário e audit log com justificativa —
 * tudo isso é da API.
 *
 * ## Uso transacional (escrita + audit log na MESMA transação)
 *
 * A justificativa de edição/exclusão só existe no audit log; portanto a API
 * deve gravar `update`/`softDelete`/`create` e o audit log numa transação só —
 * se o audit falhar, a correção não pode ficar gravada sem justificativa.
 * Construa o repositório com o `tx` do `sql.begin`:
 *
 * ```ts
 * const result = await sql.begin(async (tx) => {
 *   const repo = new EvaluatedDocumentEntriesRepository(tx, { tenantId });
 *   const changed = await repo.update(id, { pageCount, updatedById: actorId });
 *   if (changed === null) return null;              // → 404 depois do begin
 *   await tx`INSERT INTO audit_logs ...`;           // mesmo tx (sql.json no metadata)
 *   return changed;
 * });
 * ```
 *
 * - Com `tx`, todas as operações rodam dentro da transação externa: rollback
 *   dela desfaz tudo, commit grava tudo.
 * - `update` precisa de atomicidade própria (lê `before` com `FOR UPDATE` e
 *   grava `after`). Com o pool, abre `begin`; com `tx`, abre um SAVEPOINT —
 *   erro dentro do `update` (CHECK, FK) volta só até o savepoint e é
 *   relançado, sem envenenar a transação externa. A trava `FOR UPDATE` dura
 *   até o fim da transação EXTERNA.
 * - O `AuditLogger` da API hoje recebe `Sql`; para usá-lo com o `tx` o
 *   construtor dele precisa aceitar `Sql | TransactionSql` (território da API).
 */
export class EvaluatedDocumentEntriesRepository {
  private readonly sql: EvaluatedDocumentEntriesSql;
  private readonly context: RepositoryContext;

  static readonly TABLE = 'evaluated_document_entries';

  /**
   * @param sql     Pool postgres.js ou `tx` de `sql.begin` (ver "Uso
   *                transacional").
   * @param context `{ tenantId }` da empresa em escopo. `null` (SUPER_ADMIN
   *                sem empresa) é recusado em qualquer operação.
   */
  constructor(sql: EvaluatedDocumentEntriesSql, context: RepositoryContext) {
    this.sql = sql;
    this.context = context;
  }

  /** Deriva um repositório escopado a uma empresa específica. */
  forTenant(tenantId: string): EvaluatedDocumentEntriesRepository {
    return new EvaluatedDocumentEntriesRepository(this.sql, { tenantId });
  }

  /** Falha fechada: lançamento sempre pertence a uma empresa explícita. */
  private requireTenantId(): string {
    if (!hasTenant(this.context)) {
      throw new Error(
        'evaluated_document_entries exige empresa explícita: operação sem tenant não é permitida.',
      );
    }
    return this.context.tenantId;
  }

  /**
   * Lista de colunas de leitura (com `evaluated_on` já como texto). Recebe a
   * conexão/transação em uso para o fragmento nascer da mesma instância.
   */
  private columns(q: EvaluatedDocumentEntriesSql = this.sql) {
    return q`
      id, tenant_id, user_id,
      to_char(evaluated_on, 'YYYY-MM-DD') AS evaluated_on,
      page_count, created_by_id, updated_by_id, deleted_by_id,
      created_at, updated_at, deleted, deleted_at
    `;
  }

  /**
   * Predicado comum de leitura: empresa + não excluído + filtros opcionais.
   * Cada filtro ausente vira fragmento vazio — nada é concatenado como texto.
   */
  private filterClause(tenantId: string, filter: EvaluatedDocumentEntriesFilter) {
    const sql = this.sql;
    if (filter.dateFrom !== undefined) assertIsoDate(filter.dateFrom, 'dateFrom');
    if (filter.dateTo !== undefined) assertIsoDate(filter.dateTo, 'dateTo');

    return sql`
      tenant_id = ${tenantId}
      AND deleted = false
      ${filter.dateFrom !== undefined ? sql`AND evaluated_on >= ${filter.dateFrom}::date` : sql``}
      ${filter.dateTo !== undefined ? sql`AND evaluated_on <= ${filter.dateTo}::date` : sql``}
      ${
        filter.userIds !== undefined
          ? sql`AND user_id = ANY(${sql.array(filter.userIds)}::uuid[])`
          : sql``
      }
    `;
  }

  /**
   * Cria um lançamento. `tenant_id` vem do contexto. Retorna a linha
   * persistida. Violações do banco sobem como erro do postgres.js:
   * `23514` (CHECK `evaluated_doc_entries_page_count_positive`) para
   * `pageCount <= 0` e `23503` (FK `evaluated_document_entries_user_id_fkey`)
   * para usuário inexistente. Usuário de OUTRA empresa NÃO é barrado pelo
   * banco — a API valida antes de chamar.
   */
  async create(input: CreateEvaluatedDocumentEntryInput): Promise<EvaluatedDocumentEntry> {
    const tenantId = this.requireTenantId();
    assertIsoDate(input.evaluatedOn, 'evaluatedOn');

    const rows = await this.sql<EntryRow[]>`
      INSERT INTO evaluated_document_entries
        (tenant_id, user_id, evaluated_on, page_count, created_by_id)
      VALUES
        (${tenantId}, ${input.userId}, ${input.evaluatedOn}::date, ${input.pageCount}, ${input.createdById})
      RETURNING ${this.columns()}
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new Error('create de evaluated_document_entries falhou silenciosamente');
    }
    return toEntry(row);
  }

  /**
   * Busca um lançamento ativo da empresa. `null` quando não existe, é de
   * outra empresa, está excluído ou o `id` nem é um UUID.
   */
  async findById(id: string): Promise<EvaluatedDocumentEntry | null> {
    const tenantId = this.requireTenantId();
    if (!UUID.test(id)) return null;

    const rows = await this.sql<EntryRow[]>`
      SELECT ${this.columns()}
        FROM evaluated_document_entries
       WHERE id = ${id}
         AND tenant_id = ${tenantId}
         AND deleted = false
    `;
    const row = rows[0];
    return row === undefined ? null : toEntry(row);
  }

  /**
   * Edita um lançamento ativo da empresa, gravando `updated_by_id` e
   * `updated_at = now()`. Devolve `{ before, after }` lidos na MESMA transação
   * (linha travada com `FOR UPDATE`), para a API auditar a diferença sem
   * corrida. `null` quando o lançamento não existe, é de outra empresa ou está
   * excluído.
   *
   * Com o pool, roda em `begin` próprio; com `tx`, em SAVEPOINT dentro da
   * transação externa (ver "Uso transacional" na classe).
   */
  async update(
    id: string,
    patch: UpdateEvaluatedDocumentEntryInput,
  ): Promise<EvaluatedDocumentEntryUpdateResult | null> {
    const tenantId = this.requireTenantId();
    if (!UUID.test(id)) return null;
    if (patch.evaluatedOn !== undefined) assertIsoDate(patch.evaluatedOn, 'evaluatedOn');

    // Só as colunas presentes no patch entram no SET (via helper parametrizado
    // `sql(objeto)` do postgres.js); `updated_by_id` sempre.
    const values: Record<string, unknown> = { updated_by_id: patch.updatedById };
    if (patch.userId !== undefined) values['user_id'] = patch.userId;
    if (patch.evaluatedOn !== undefined) values['evaluated_on'] = patch.evaluatedOn;
    if (patch.pageCount !== undefined) values['page_count'] = patch.pageCount;

    const run = async (tx: TransactionSql): Promise<EvaluatedDocumentEntryUpdateResult | null> => {
      const beforeRows = await tx<EntryRow[]>`
        SELECT ${this.columns(tx)}
          FROM evaluated_document_entries
         WHERE id = ${id}
           AND tenant_id = ${tenantId}
           AND deleted = false
         FOR UPDATE
      `;
      const before = beforeRows[0];
      if (before === undefined) return null;

      const afterRows = await tx<EntryRow[]>`
        UPDATE evaluated_document_entries
           SET ${tx(values)}, updated_at = now()
         WHERE id = ${id}
           AND tenant_id = ${tenantId}
           AND deleted = false
        RETURNING ${this.columns(tx)}
      `;
      const after = afterRows[0];
      if (after === undefined) {
        throw new Error('update de evaluated_document_entries falhou silenciosamente');
      }
      return { before: toEntry(before), after: toEntry(after) };
    };

    // Já dentro de transação → SAVEPOINT (o `tx` do postgres.js não abre
    // `begin` aninhado); no pool → transação própria.
    const q = this.sql;
    return isTransaction(q) ? q.savepoint(run) : q.begin(run);
  }

  /**
   * Exclusão lógica: grava `deleted = true`, `deleted_at = now()` e
   * `deleted_by_id`. Devolve a linha já marcada como excluída — os campos de
   * negócio (`userId`, `evaluatedOn`, `pageCount`) são o estado que a API
   * audita como `before`. `null` quando não existe, é de outra empresa ou já
   * estava excluído (idempotente do ponto de vista do chamador: segunda
   * chamada → 404).
   */
  async softDelete(id: string, deletedById: string | null): Promise<EvaluatedDocumentEntry | null> {
    const tenantId = this.requireTenantId();
    if (!UUID.test(id)) return null;

    const rows = await this.sql<EntryRow[]>`
      UPDATE evaluated_document_entries
         SET deleted = true,
             deleted_at = now(),
             deleted_by_id = ${deletedById}
       WHERE id = ${id}
         AND tenant_id = ${tenantId}
         AND deleted = false
      RETURNING ${this.columns()}
    `;
    const row = rows[0];
    return row === undefined ? null : toEntry(row);
  }

  /**
   * Totais do filtro (lançamentos e páginas) + quebra por `user_id`, numa
   * única varredura (`GROUPING SETS ((user_id), ())`). Sem nenhum lançamento,
   * devolve totais zerados e `byUser` vazio. `byUser` vem ordenado por páginas
   * DESC; `userId` nulo (usuário purgado) fica por último no empate.
   */
  async summary(
    filter: EvaluatedDocumentEntriesFilter = {},
  ): Promise<EvaluatedDocumentEntriesSummary> {
    const tenantId = this.requireTenantId();

    const rows = await this.sql<
      Array<{ is_total: number; user_id: string | null; entries: number; pages: string | null }>
    >`
      SELECT GROUPING(user_id)     AS is_total,
             user_id,
             COUNT(*)::int         AS entries,
             SUM(page_count)::text AS pages
        FROM evaluated_document_entries
       WHERE ${this.filterClause(tenantId, filter)}
       GROUP BY GROUPING SETS ((user_id), ())
       ORDER BY is_total DESC, SUM(page_count) DESC, user_id NULLS LAST
    `;

    // `SUM(integer)` é bigint no Postgres; vem como texto e é convertido aqui
    // (seguro até 2^53 páginas).
    const toPages = (v: string | null): number => (v === null ? 0 : Number(v));

    const totalRow = rows.find((r) => r.is_total === 1);
    return {
      totals: {
        entries: totalRow?.entries ?? 0,
        pages: toPages(totalRow?.pages ?? null),
      },
      byUser: rows
        .filter((r) => r.is_total === 0)
        .map((r) => ({ userId: r.user_id, entries: r.entries, pages: toPages(r.pages) })),
    };
  }

  /**
   * Página de lançamentos ativos do filtro, ordenada por
   * `evaluated_on DESC, created_at DESC, id DESC` (o `id` só desempata, para
   * a paginação por OFFSET não duplicar nem pular linha), + total do filtro.
   */
  async listPaged(
    options: EvaluatedDocumentEntriesPageOptions = {},
  ): Promise<EvaluatedDocumentEntriesPage> {
    const tenantId = this.requireTenantId();
    const pageSize = normalizeLimit(options.pageSize);
    const page =
      options.page !== undefined && Number.isFinite(options.page) && options.page >= 1
        ? Math.trunc(options.page)
        : 1;
    const offset = (page - 1) * pageSize;

    // Um fragmento por query: fragmentos do postgres.js não são compartilhados
    // entre duas queries em voo.
    const [items, totalRows] = await Promise.all([
      this.sql<EntryRow[]>`
        SELECT ${this.columns()}
          FROM evaluated_document_entries
         WHERE ${this.filterClause(tenantId, options)}
         ORDER BY evaluated_on DESC, created_at DESC, id DESC
         LIMIT ${pageSize} OFFSET ${offset}
      `,
      this.sql<Array<{ total: number }>>`
        SELECT COUNT(*)::int AS total
          FROM evaluated_document_entries
         WHERE ${this.filterClause(tenantId, options)}
      `,
    ]);

    return {
      items: items.map(toEntry),
      total: totalRows[0]?.total ?? 0,
      page,
      pageSize,
    };
  }
}

/** Atalho para criar o repositório a partir de uma conexão e contexto. */
export function createEvaluatedDocumentEntriesRepository(
  sql: Sql,
  context: RepositoryContext,
): EvaluatedDocumentEntriesRepository {
  return new EvaluatedDocumentEntriesRepository(sql, context);
}
