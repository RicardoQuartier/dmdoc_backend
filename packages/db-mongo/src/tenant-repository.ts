import type { Collection, Filter, OptionalUnlessRequiredId, WithId } from 'mongodb';
import { newId, normalizeLimit, type Page, type PaginationOptions } from './helpers.js';
import { hasTenant, type RepositoryContext } from './tenant-context.js';

/**
 * Forma mínima de todo documento armazenado pelo wrapper.
 *
 * - `id`: uuid lógico de negócio (não confundir com `_id` do Mongo).
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
export type CreateInput<T extends TenantDocument> = Omit<T, 'id' | 'tenantId' | 'deleted'> & {
  id?: string;
};

/**
 * Campos atualizáveis: tudo exceto os gerenciados pelo wrapper e o `id`.
 */
export type UpdateInput<T extends TenantDocument> = Partial<Omit<T, 'id' | 'tenantId' | 'deleted'>>;

/**
 * Wrapper central de isolamento multi-tenant + exclusão lógica.
 *
 * Garante, sem depender da disciplina de quem chama (spec §5.4 e §10):
 *
 * 1. **tenantId automático.** Toda leitura injeta `tenantId` no filtro; todo
 *    insert grava `tenantId`. Um recurso de outra empresa é INALCANÇÁVEL:
 *    `findById` de um id de outro tenant retorna `null` (a rota traduz em 404,
 *    nunca 403 — não vaza existência).
 *
 * 2. **deleted:false automático.** Toda LEITURA (find/findOne/count) injeta
 *    `deleted: false`. `softDelete` apenas marca `deleted: true` — o documento
 *    permanece no banco para auditoria e integridade referencial.
 *
 * 3. **SUPER_ADMIN explícito.** Construído com contexto `null`, o repositório
 *    NÃO opera sem um `tenantId` passado explicitamente em cada chamada (via
 *    `forTenant(tenantId)`). Acesso cross-empresa é sempre intencional. Tentar
 *    operar em modo SUPER_ADMIN sem escopo lança erro — falha fechada.
 */
export class TenantRepository<T extends TenantDocument> {
  private readonly collection: Collection<T>;
  private readonly context: RepositoryContext;

  /**
   * @param collection Coleção tipada do Mongo.
   * @param context    `{ tenantId }` para operação normal, ou `null` para
   *                   SUPER_ADMIN (que deve escopar via `forTenant`).
   */
  constructor(collection: Collection<T>, context: RepositoryContext) {
    this.collection = collection;
    this.context = context;
  }

  /**
   * Deriva um repositório escopado a uma empresa específica. É o ÚNICO caminho
   * para um SUPER_ADMIN (contexto `null`) operar sobre dados: ele seleciona a
   * empresa-alvo explicitamente. Também pode ser usado para trocar de escopo.
   */
  forTenant(tenantId: string): TenantRepository<T> {
    return new TenantRepository<T>(this.collection, { tenantId });
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
   * Monta o filtro base aplicado a TODA leitura: tenantId + deleted:false,
   * combinado com o filtro fornecido pelo chamador.
   */
  private scopedReadFilter(filter: Filter<T> = {}): Filter<T> {
    const tenantId = this.requireTenantId();
    return {
      ...filter,
      tenantId,
      deleted: false,
    } as Filter<T>;
  }

  /**
   * Remove o `_id` interno do Mongo, devolvendo o documento de negócio puro.
   * Os tipos do DMDoc usam o `id` (uuid) como identidade — `_id` é detalhe
   * de armazenamento e não faz parte do contrato dos repositórios.
   */
  private strip(doc: WithId<T> | null): T | null {
    if (doc === null) {
      return null;
    }
    const { _id: _ignored, ...rest } = doc;
    return rest as unknown as T;
  }

  /**
   * Busca um recurso pelo `id` de negócio. Retorna `null` se não existir,
   * se pertencer a outra empresa, ou se estiver excluído logicamente.
   */
  async findById(id: string): Promise<T | null> {
    return this.strip(await this.collection.findOne(this.scopedReadFilter({ id } as Filter<T>)));
  }

  /**
   * Busca o primeiro recurso que casa o filtro, dentro do escopo de empresa
   * e ignorando excluídos.
   */
  async findOne(filter: Filter<T> = {}): Promise<T | null> {
    return this.strip(await this.collection.findOne(this.scopedReadFilter(filter)));
  }

  /**
   * Lista recursos com paginação por cursor estável (ordenada por `id`).
   * Nunca retorna recursos de outra empresa nem excluídos.
   */
  async findMany(
    filter: Filter<T> = {},
    pagination: PaginationOptions = { limit: 20 }
  ): Promise<Page<T>> {
    const limit = normalizeLimit(pagination.limit);
    const scoped = this.scopedReadFilter(filter);

    const cursorFilter: Filter<T> =
      pagination.cursor !== undefined
        ? ({ ...scoped, id: { $gt: pagination.cursor } } as Filter<T>)
        : scoped;

    const docs = await this.collection
      .find(cursorFilter)
      .sort({ id: 1 })
      .limit(limit + 1)
      .toArray();

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;
    const last = page.at(-1);
    const nextCursor = hasMore && last ? last.id : null;
    const items = page.map((doc) => this.strip(doc)).filter((doc): doc is T => doc !== null);

    return { items, nextCursor };
  }

  /**
   * Conta recursos do escopo (empresa + não excluídos) que casam o filtro.
   * Usado, por exemplo, na validação de cota de usuários por empresa.
   */
  async count(filter: Filter<T> = {}): Promise<number> {
    return this.collection.countDocuments(this.scopedReadFilter(filter));
  }

  /**
   * Insere um recurso. O wrapper grava `tenantId` (da empresa em escopo),
   * `deleted: false` e gera `id` se ausente. Retorna o documento completo.
   */
  async insertOne(data: CreateInput<T>): Promise<T> {
    const tenantId = this.requireTenantId();
    const id = data.id ?? newId();

    const doc = {
      ...data,
      id,
      tenantId,
      deleted: false,
    } as unknown as T;

    await this.collection.insertOne(doc as OptionalUnlessRequiredId<T>);
    return doc;
  }

  /**
   * Atualiza campos de um recurso pelo `id`, restrito à empresa em escopo e
   * a recursos não excluídos. Não permite alterar `id`, `tenantId` nem
   * `deleted` (este último só muda via `softDelete`). Retorna o documento
   * atualizado, ou `null` se não encontrado no escopo.
   */
  async updateById(id: string, data: UpdateInput<T>): Promise<T | null> {
    const filter = this.scopedReadFilter({ id } as Filter<T>);

    const updated = await this.collection.findOneAndUpdate(
      filter,
      { $set: data as Partial<T> },
      { returnDocument: 'after' }
    );
    return this.strip(updated);
  }

  /**
   * Exclusão lógica: marca `deleted: true`. O documento NÃO é removido
   * fisicamente — permanece para auditoria e integridade referencial.
   * Após isto, todas as leituras do wrapper deixam de retorná-lo.
   * Retorna `true` se algo foi marcado (existia, no escopo, não excluído).
   */
  async softDelete(id: string): Promise<boolean> {
    const filter = this.scopedReadFilter({ id } as Filter<T>);
    const result = await this.collection.updateOne(filter, {
      $set: { deleted: true } as Partial<T>,
    });
    return result.modifiedCount > 0;
  }
}

/**
 * Atalho para criar um repositório a partir de uma coleção e um contexto.
 */
export function createTenantRepository<T extends TenantDocument>(
  collection: Collection<T>,
  context: RepositoryContext
): TenantRepository<T> {
  return new TenantRepository<T>(collection, context);
}
