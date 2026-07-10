import type { Sql } from 'postgres';
import { newId, toSnakeCase } from './helpers.js';
import { hasTenant, type RepositoryContext } from './tenant-context.js';
import type { DocumentEvent, NewDocumentEvent } from './schema.js';

/**
 * Input de criação para o repositório PG. O repositório injeta `id`
 * (se ausente), `tenant_id` e `created_at`. Quem chama nunca informa esses
 * campos.
 */
export type CreateDocumentEventPgInput = Omit<NewDocumentEvent, 'id' | 'tenantId' | 'createdAt'> & {
  id?: string;
};

/**
 * Resultado de uso agrupado por mime_type.
 */
export interface UsageByMimeTypeRow {
  mimeType: string;
  count: number;
  totalBytes: bigint;
}

/**
 * Resultado de uso agrupado por período (dia ou mês).
 */
export interface UsageByPeriodRow {
  period: string;
  count: number;
}

/**
 * Repositório APPEND-ONLY da tabela `document_events` — PostgreSQL.
 *
 * Por que esta tabela NÃO usa o TenantRepository
 * -----------------------------------------------
 * O `TenantRepository` injeta `deleted = false` em toda leitura e permite
 * `softDelete`. `document_events` é um registro IMUTÁVEL do que foi enviado —
 * não do que existe no acervo agora (spec §5.4).
 *
 * O upload **aconteceu** e deve continuar contando para cobrança/auditoria
 * mesmo depois que o documento for excluído logicamente. Portanto:
 *
 * - A tabela **não carrega a coluna `deleted`** e **nunca** é filtrada por
 *   `deleted = false`. Filtrar esconderia eventos cujo documento foi deletado —
 *   exatamente os que precisamos contar.
 * - **Não existe `updateById`, `softDelete` nem `delete`.** Um evento é gravado
 *   uma vez. A ÚNICA mutação permitida é o backfill de `page_count`, exposto
 *   explicitamente em `backfillPageCount`.
 *
 * O que continua valendo (isolamento inegociável)
 * ------------------------------------------------
 * Toda escrita grava `tenant_id` do contexto; toda leitura/agregação injeta
 * `tenant_id` no filtro. Uma empresa NUNCA vê eventos de outra (spec §5.4,
 * §10 invariante 1). O contexto SUPER_ADMIN (null) é recusado — operação
 * nesta tabela sempre exige empresa explícita.
 */
export class DocumentEventsRepository {
  private readonly sql: Sql;
  private readonly context: RepositoryContext;

  /** Nome fixo da tabela — append-only, sem soft-delete. */
  static readonly TABLE = 'document_events';

  /**
   * @param sql     Instância postgres.js.
   * @param context `{ tenantId }` da empresa em escopo. `null` (SUPER_ADMIN
   *                sem empresa) é recusado em qualquer operação.
   */
  constructor(sql: Sql, context: RepositoryContext) {
    this.sql = sql;
    this.context = context;
  }

  /**
   * Deriva um repositório escopado a uma empresa específica.
   * Necessário para SUPER_ADMIN que precisa operar sobre uma empresa concreta.
   */
  forTenant(tenantId: string): DocumentEventsRepository {
    return new DocumentEventsRepository(this.sql, { tenantId });
  }

  /**
   * Resolve o `tenantId` da operação. Falha fechada se o contexto for
   * SUPER_ADMIN (sem empresa) — eventos sempre pertencem a uma empresa.
   */
  private requireTenantId(): string {
    if (!hasTenant(this.context)) {
      throw new Error(
        'document_events exige empresa explícita: operação sem tenant não é permitida.'
      );
    }
    return this.context.tenantId;
  }

  /**
   * Grava um novo evento de upload. O repositório gera `id` (se ausente),
   * injeta `tenant_id` do contexto e deixa o banco preencher `created_at`
   * via DEFAULT `now()`. NÃO grava `deleted` (coluna não existe).
   * Retorna o evento completo persistido.
   */
  async insertOne(data: CreateDocumentEventPgInput): Promise<DocumentEvent> {
    const tenantId = this.requireTenantId();

    const id = data.id ?? newId();

    // Converter chaves camelCase para snake_case para o INSERT
    const snakeCaseRecord: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (key === 'id') continue;
      snakeCaseRecord[toSnakeCase(key)] = value;
    }
    snakeCaseRecord['id'] = id;
    snakeCaseRecord['tenant_id'] = tenantId;
    // NÃO gravar deleted — tabela não tem essa coluna

    const rows = await this.sql<DocumentEvent[]>`
      INSERT INTO ${this.sql(DocumentEventsRepository.TABLE)} ${this.sql(snakeCaseRecord)}
      RETURNING *
    `;

    const inserted = rows[0];
    if (inserted === undefined) {
      throw new Error('insertOne de document_events falhou silenciosamente');
    }
    return inserted;
  }

  /**
   * Lista eventos da empresa que casam o filtro opcional, ordenados por
   * `created_at` decrescente (mais recentes primeiro).
   *
   * SEM filtro de `deleted` — inclui eventos de documentos já excluídos.
   * O `tenant_id` é sempre aplicado (isolamento inegociável).
   *
   * @param filter Filtro opcional em snake_case (ex: `{ document_id: 'uuid' }`).
   *               Suporta apenas igualdade simples.
   */
  async findMany(
    filter: Partial<Omit<DocumentEvent, 'tenantId'>> = {}
  ): Promise<DocumentEvent[]> {
    const tenantId = this.requireTenantId();

    // Remover tenantId do filtro (sempre adicionado automaticamente)
    const { tenantId: _t, ...rest } = filter as Record<string, unknown>;

    const pairs = Object.entries(rest)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => ({ col: toSnakeCase(k), value: v }));

    if (pairs.length === 0) {
      const rows = await this.sql<DocumentEvent[]>`
        SELECT *
        FROM ${this.sql(DocumentEventsRepository.TABLE)}
        WHERE tenant_id = ${tenantId}
        ORDER BY created_at DESC
      `;
      return rows;
    }

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
      SELECT *
      FROM "${DocumentEventsRepository.TABLE}"
      WHERE tenant_id = ${tenantParam}
        ${whereExtra}
      ORDER BY created_at DESC
    `;

    return this.sql.unsafe<DocumentEvent[]>(query, params as Parameters<Sql['unsafe']>[1]);
  }

  /**
   * ÚNICA mutação imutável permitida sobre um evento já gravado: preenche
   * `page_count` quando o worker conclui a extração (documento `READY`).
   * Atualiza apenas o campo `page_count`, escopado por `tenant_id` +
   * `document_id`.
   *
   * Retorna `true` se ao menos um evento foi atualizado. Pode atualizar mais
   * de um evento quando o mesmo documento foi alvo de reenvios deduplicados —
   * todos referenciam o mesmo `documentId` e compartilham a mesma contagem.
   */
  async backfillPageCount(documentId: string, pageCount: number): Promise<boolean> {
    const tenantId = this.requireTenantId();

    const result = await this.sql`
      UPDATE ${this.sql(DocumentEventsRepository.TABLE)}
      SET page_count = ${pageCount}
      WHERE document_id = ${documentId}
        AND tenant_id = ${tenantId}
    `;

    return result.count > 0;
  }

  /**
   * Sincroniza o tipo de documento em todos os eventos do documento.
   *
   * Chamado quando o usuário edita o tipo via PATCH /documents/:id, para que
   * o relatório de uploads reflita a classificação atual. Campos derivados do
   * arquivo (mime_type, size_bytes, page_count, uploaded_by_id, created_at)
   * não são alterados.
   *
   * Retorna `true` se ao menos um evento foi atualizado.
   */
  async syncDocumentType(
    documentId: string,
    documentTypeId: string | null,
    documentTypeName: string | null,
  ): Promise<boolean> {
    const tenantId = this.requireTenantId();

    const result = await this.sql`
      UPDATE ${this.sql(DocumentEventsRepository.TABLE)}
      SET document_type_id = ${documentTypeId},
          document_type_name = ${documentTypeName}
      WHERE document_id = ${documentId}
        AND tenant_id = ${tenantId}
    `;

    return result.count > 0;
  }

  /**
   * Relatório de uso agrupado por `mime_type` no período [from, to].
   *
   * Substitui o `aggregate(pipeline)` genérico do MongoDB com SQL tipado.
   * Inclui eventos de documentos excluídos — eles aconteceram e devem ser
   * contados (spec §5.4).
   *
   * @returns Array com `mimeType`, `count` (número de uploads) e
   *          `totalBytes` (soma de `size_bytes` como bigint).
   */
  async usageByMimeType(from: Date, to: Date): Promise<UsageByMimeTypeRow[]> {
    const tenantId = this.requireTenantId();

    const rows = await this.sql<Array<{ mime_type: string; count: string; total_bytes: string }>>`
      SELECT
        mime_type,
        COUNT(*) AS count,
        SUM(size_bytes) AS total_bytes
      FROM ${this.sql(DocumentEventsRepository.TABLE)}
      WHERE tenant_id = ${tenantId}
        AND created_at >= ${from}
        AND created_at <= ${to}
      GROUP BY mime_type
      ORDER BY total_bytes DESC
    `;

    return rows.map((r) => ({
      mimeType: r.mime_type,
      count: parseInt(r.count, 10),
      totalBytes: BigInt(r.total_bytes ?? '0'),
    }));
  }

  /**
   * Relatório de uso agrupado por período (dia ou mês) no intervalo [from, to].
   *
   * Substitui o `aggregate(pipeline)` genérico do MongoDB com SQL tipado.
   * A truncagem temporal é feita no banco (date_trunc) para consistência
   * com o timezone configurado na sessão PostgreSQL.
   *
   * @param groupBy 'day' — agrupa por `YYYY-MM-DD`; 'month' — por `YYYY-MM`.
   * @returns Array com `period` (string formatada) e `count` (número de uploads).
   */
  async usageByPeriod(
    from: Date,
    to: Date,
    groupBy: 'day' | 'month'
  ): Promise<UsageByPeriodRow[]> {
    const tenantId = this.requireTenantId();

    const truncUnit = groupBy === 'day' ? 'day' : 'month';
    const dateFormat = groupBy === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM';

    const rows = await this.sql<Array<{ period: string; count: string }>>`
      SELECT
        TO_CHAR(DATE_TRUNC(${truncUnit}, created_at), ${dateFormat}) AS period,
        COUNT(*) AS count
      FROM ${this.sql(DocumentEventsRepository.TABLE)}
      WHERE tenant_id = ${tenantId}
        AND created_at >= ${from}
        AND created_at <= ${to}
      GROUP BY DATE_TRUNC(${truncUnit}, created_at)
      ORDER BY DATE_TRUNC(${truncUnit}, created_at) ASC
    `;

    return rows.map((r) => ({
      period: r.period,
      count: parseInt(r.count, 10),
    }));
  }
}

/**
 * Atalho para criar um repositório de eventos a partir de uma conexão e contexto.
 */
export function createDocumentEventsRepository(
  sql: Sql,
  context: RepositoryContext
): DocumentEventsRepository {
  return new DocumentEventsRepository(sql, context);
}
