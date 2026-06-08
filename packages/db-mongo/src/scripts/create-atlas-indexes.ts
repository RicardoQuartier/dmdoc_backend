import { pathToFileURL } from 'node:url';
import type { SearchIndexDescription } from 'mongodb';
import { MongoDbClient } from '../client.js';
import { createScriptLogger, readMongoConfig } from './script-env.js';

/**
 * Script de bootstrap: cria os índices de Atlas Search (lexical) e Vector Search
 * (vetorial) na coleção `chunks` (spec §5.3, entregável 25 da Fase 3).
 *
 * Executar: `pnpm --filter @dmdoc/db-mongo create-atlas-indexes`
 *
 * ## Estratégia de criação
 *
 * O driver MongoDB Node.js (>=6.x) expõe `collection.createSearchIndexes()` e
 * `collection.listSearchIndexes()`, que delegam ao servidor via protocolo de
 * comandos. Em dev (imagem `mongodb/mongodb-atlas-local`) e em produção (Atlas
 * cloud >=7.0) os mesmos métodos funcionam sem configuração adicional.
 *
 * ## Idempotência
 *
 * Antes de criar cada índice, o script lista os search indexes existentes.
 * Se o índice já existir (comparação por nome), a criação é pulada — o script
 * pode ser executado múltiplas vezes sem efeito colateral.
 *
 * ## Variáveis de ambiente
 *
 * | Variável            | Obrigatória | Padrão dev          | Descrição                       |
 * |---------------------|-------------|---------------------|---------------------------------|
 * | MONGO_URI           | sim         | mongodb://localhost  | URI de conexão MongoDB           |
 * | MONGO_DB            | não         | dmdoc               | Nome do banco                    |
 * | LOG_LEVEL           | não         | info                | Nível de log Pino                |
 *
 * Em produção, `MONGO_URI` deve ser a connection string do Atlas. Não são
 * necessárias chaves de Admin API: o driver usa o protocolo nativo do Atlas.
 *
 * ## Definição dos índices (spec §5.3)
 *
 * ### Vector Search — `chunks_vector_search`
 * ```json
 * {
 *   "fields": [
 *     { "type": "vector", "path": "embedding", "numDimensions": 1536, "similarity": "cosine" },
 *     { "type": "filter", "path": "tenantId" },
 *     { "type": "filter", "path": "departmentId" },
 *     { "type": "filter", "path": "documentTypeName" },
 *     { "type": "filter", "path": "documentId" }
 *   ]
 * }
 * ```
 *
 * ### Atlas Search — `chunks_text_search`
 * ```json
 * {
 *   "mappings": {
 *     "dynamic": false,
 *     "fields": {
 *       "text":             { "type": "string", "analyzer": "lucene.portuguese" },
 *       "tenantId":         { "type": "token" },
 *       "departmentId":     { "type": "token" },
 *       "documentTypeName": { "type": "token" }
 *     }
 *   }
 * }
 * ```
 */

const COLLECTION = 'chunks';

/** Definições dos índices Atlas Search e Vector Search (spec §5.3). */
const ATLAS_INDEX_DEFINITIONS: readonly SearchIndexDescription[] = [
  {
    name: 'chunks_vector_search',
    type: 'vectorSearch',
    definition: {
      fields: [
        {
          type: 'vector',
          path: 'embedding',
          numDimensions: 1536,
          similarity: 'cosine',
        },
        { type: 'filter', path: 'tenantId' },
        { type: 'filter', path: 'departmentId' },
        { type: 'filter', path: 'documentTypeName' },
        { type: 'filter', path: 'documentId' },
      ],
    },
  },
  {
    name: 'chunks_text_search',
    type: 'search',
    definition: {
      mappings: {
        dynamic: false,
        fields: {
          text: { type: 'string', analyzer: 'lucene.portuguese' },
          tenantId: { type: 'token' },
          departmentId: { type: 'token' },
          documentTypeName: { type: 'token' },
        },
      },
    },
  },
] as const;

/**
 * Retorna o conjunto de nomes dos search indexes já existentes na coleção.
 * Usa `listSearchIndexes()` do driver (disponível no Atlas >=7.0 e no
 * `mongodb-atlas-local`).
 */
async function fetchExistingIndexNames(
  client: MongoDbClient,
  collection: string,
): Promise<Set<string>> {
  const db = client.getDb();
  const cursor = db.collection(collection).listSearchIndexes();
  const existing = new Set<string>();

  for await (const index of cursor) {
    const name = (index as { name?: unknown }).name;
    if (typeof name === 'string') {
      existing.add(name);
    }
  }

  return existing;
}

/**
 * Cria os índices Atlas Search e Vector Search na coleção `chunks`.
 *
 * @returns Número de índices efetivamente criados (os já existentes são pulados).
 */
export async function createAtlasIndexes(client: MongoDbClient): Promise<number> {
  const log = createScriptLogger('create-atlas-indexes');
  const db = client.getDb();
  const collection = db.collection(COLLECTION);

  log.info({ collection: COLLECTION }, 'consultando search indexes existentes');

  const existing = await fetchExistingIndexNames(client, COLLECTION);
  log.info({ existingIndexes: [...existing] }, 'indexes existentes encontrados');

  const toCreate = ATLAS_INDEX_DEFINITIONS.filter((def) => {
    const name = def.name ?? '(sem nome)';
    if (existing.has(name)) {
      log.info({ index: name, type: def.type }, 'índice já existe — pulando');
      return false;
    }
    return true;
  });

  if (toCreate.length === 0) {
    log.info('todos os search indexes já existem — nenhuma ação necessária');
    return 0;
  }

  log.info(
    { toCreate: toCreate.map((d) => d.name) },
    `criando ${toCreate.length} search index(es)`,
  );

  const createdNames = await collection.createSearchIndexes([...toCreate]);

  for (const name of createdNames) {
    log.info({ index: name }, 'search index criado');
  }

  log.info(
    { created: createdNames.length, skipped: existing.size },
    'criação de search indexes concluída',
  );

  return createdNames.length;
}

async function main(): Promise<void> {
  const log = createScriptLogger('create-atlas-indexes');
  const { uri, dbName } = readMongoConfig();

  log.info({ uri, dbName }, 'conectando ao MongoDB');

  const client = await MongoDbClient.connect(uri, dbName);
  try {
    await createAtlasIndexes(client);
  } finally {
    await client.close();
  }
}

// Executa quando rodado como script (via tsx), não quando importado.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    createScriptLogger('create-atlas-indexes').error({ err }, 'falha ao criar search indexes');
    process.exitCode = 1;
  });
}
