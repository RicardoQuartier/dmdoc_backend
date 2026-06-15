import type { Collection, Filter, OptionalUnlessRequiredId, Document as MongoDocument } from 'mongodb';
import type { DocumentEvent, CreateDocumentEventInput } from '@dmdoc/shared-types';
import { newId } from './helpers.js';
import { hasTenant, type RepositoryContext } from './tenant-context.js';

/**
 * Repositório APPEND-ONLY da coleção `document_events`.
 *
 * Por que esta coleção NÃO usa o `TenantRepository`
 * --------------------------------------------------
 * O `TenantRepository` injeta `deleted: false` em toda leitura e marca
 * `deleted: true` no soft-delete. `document_events` é, por regra de negócio, um
 * registro IMUTÁVEL do que FOI ENVIADO — não do que existe no acervo agora
 * (spec §5.4, wiki "Histórico de eventos de upload e relatório de uso").
 *
 * O upload **aconteceu** e deve continuar contando para cobrança/auditoria
 * mesmo depois que o documento for excluído logicamente. Portanto:
 *
 * - O documento de evento **não carrega o campo `deleted`** e **nunca** é
 *   filtrado por `deleted:false`. Aplicar o filtro do wrapper esconderia
 *   eventos cujo documento foi deletado — exatamente os que precisamos contar.
 * - **Não existe `update` genérico, `softDelete` nem `delete`.** Um evento é
 *   gravado uma vez. A ÚNICA mutação permitida é o backfill de `pageCount`,
 *   exposto explicitamente em `backfillPageCount` (o worker preenche quando a
 *   extração conclui).
 *
 * O que continua valendo (isolamento inegociável)
 * ------------------------------------------------
 * Toda escrita grava `tenantId` do contexto; toda leitura/agregação injeta
 * `tenantId` no filtro/`$match`. Uma empresa NUNCA vê eventos de outra
 * (spec §5.4, §10 invariante 1). O contexto SUPER_ADMIN (sem empresa) é
 * recusado — operar nesta coleção exige uma empresa explícita.
 */
export class DocumentEventsRepository {
  private readonly collection: Collection<DocumentEvent>;
  private readonly context: RepositoryContext;

  /**
   * @param collection Coleção `document_events` tipada.
   * @param context    `{ tenantId }` da empresa em escopo. `null` (SUPER_ADMIN
   *                   sem empresa) é recusado em qualquer operação — esta
   *                   coleção sempre exige uma empresa explícita.
   */
  constructor(collection: Collection<DocumentEvent>, context: RepositoryContext) {
    this.collection = collection;
    this.context = context;
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
   * Monta o filtro de leitura: injeta SEMPRE `tenantId` (isolamento) e NUNCA
   * `deleted:false` (eventos sobrevivem à exclusão do documento).
   */
  private scopedReadFilter(filter: Filter<DocumentEvent> = {}): Filter<DocumentEvent> {
    const tenantId = this.requireTenantId();
    return { ...filter, tenantId } as Filter<DocumentEvent>;
  }

  /**
   * Grava um novo evento de upload. O repositório gera `id` (se ausente),
   * injeta `tenantId` do contexto e carimba `createdAt = agora`. NÃO grava
   * `deleted`. Retorna o evento completo persistido.
   */
  async insertOne(data: CreateDocumentEventInput): Promise<DocumentEvent> {
    const tenantId = this.requireTenantId();
    const id = data.id ?? newId();

    const event: DocumentEvent = {
      ...data,
      id,
      tenantId,
      createdAt: new Date(),
    };

    await this.collection.insertOne(event as OptionalUnlessRequiredId<DocumentEvent>);
    return event;
  }

  /**
   * Lista eventos da empresa que casam o filtro, ordenados por `createdAt`
   * decrescente (mais recentes primeiro). SEM filtro de `deleted` — inclui
   * eventos de documentos já excluídos. O `tenantId` é sempre aplicado.
   *
   * Despoja o `_id` interno do Mongo do resultado.
   */
  async findMany(filter: Filter<DocumentEvent> = {}): Promise<DocumentEvent[]> {
    const docs = await this.collection
      .find(this.scopedReadFilter(filter))
      .sort({ createdAt: -1 })
      .toArray();
    return docs.map(({ _id: _ignored, ...rest }) => rest as DocumentEvent);
  }

  /**
   * Executa um pipeline de agregação SEMPRE prefixado por um `$match` com o
   * `tenantId` da empresa em escopo — o chamador não consegue burlar o
   * isolamento. Usado pelo relatório de uso (totais por formato/tipo/período).
   *
   * Não injeta `deleted:false`: a agregação opera sobre todos os eventos da
   * empresa, inclusive os de documentos excluídos (que devem ser contados).
   */
  async aggregate<TResult extends MongoDocument = MongoDocument>(
    pipeline: MongoDocument[]
  ): Promise<TResult[]> {
    const tenantId = this.requireTenantId();
    return this.collection
      .aggregate<TResult>([{ $match: { tenantId } }, ...pipeline])
      .toArray();
  }

  /**
   * ÚNICA mutação permitida sobre um evento já gravado: preenche `pageCount`
   * quando o worker conclui a extração (documento `READY`). Atualiza apenas o
   * campo `pageCount`, escopado por `tenantId` + `documentId`.
   *
   * Retorna `true` se algum evento foi atualizado. Pode atualizar mais de um
   * evento quando o mesmo documento foi alvo de reenvios deduplicados — todos
   * referenciam o mesmo `documentId` e compartilham a mesma contagem.
   */
  async backfillPageCount(documentId: string, pageCount: number): Promise<boolean> {
    const tenantId = this.requireTenantId();
    const result = await this.collection.updateMany(
      { tenantId, documentId } as Filter<DocumentEvent>,
      { $set: { pageCount } }
    );
    return result.modifiedCount > 0;
  }
}

/**
 * Atalho para criar um repositório de eventos a partir de uma coleção e contexto.
 */
export function createDocumentEventsRepository(
  collection: Collection<DocumentEvent>,
  context: RepositoryContext
): DocumentEventsRepository {
  return new DocumentEventsRepository(collection, context);
}

/** Nome da coleção append-only de eventos de upload. */
export const DOCUMENT_EVENTS_COLLECTION = 'document_events';
