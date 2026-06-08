import { MongoClient, type Db, type MongoClientOptions } from 'mongodb';

/**
 * Conexão MongoDB para o DMDoc.
 *
 * Configuração é SEMPRE injetada por quem chama (`connect(uri, dbName)`).
 * Este pacote nunca lê `process.env` — a API e o worker carregam a config
 * via seus respectivos `config.ts` (Zod) e passam os valores aqui.
 *
 * Mantém uma única conexão por instância (`MongoDbClient`), reusável em toda
 * a aplicação. Não há singleton de módulo global: isso facilita testes
 * herméticos (cada teste cria e fecha sua própria instância).
 */
export class MongoDbClient {
  private readonly client: MongoClient;
  private db: Db | null = null;

  private constructor(client: MongoClient) {
    this.client = client;
  }

  /**
   * Conecta ao MongoDB e seleciona o banco. Retorna uma instância pronta.
   *
   * @param uri    URI de conexão (injetada pela config do chamador).
   * @param dbName Nome do banco (injetado pela config do chamador).
   * @param options Opções adicionais do driver (opcional).
   */
  static async connect(
    uri: string,
    dbName: string,
    options?: MongoClientOptions
  ): Promise<MongoDbClient> {
    const client = options ? new MongoClient(uri, options) : new MongoClient(uri);
    await client.connect();
    const instance = new MongoDbClient(client);
    instance.db = client.db(dbName);
    return instance;
  }

  /**
   * Retorna o `Db` conectado. Lança se chamado antes de `connect`.
   */
  getDb(): Db {
    if (!this.db) {
      throw new Error('MongoDbClient não está conectado. Chame MongoDbClient.connect primeiro.');
    }
    return this.db;
  }

  /**
   * Acesso ao driver bruto, para operações administrativas (ex.: criar índices).
   */
  getClient(): MongoClient {
    return this.client;
  }

  /**
   * Encerra a conexão. Idempotente o suficiente para uso em teardown de testes.
   */
  async close(): Promise<void> {
    this.db = null;
    await this.client.close();
  }
}
