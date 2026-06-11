import { pathToFileURL } from 'node:url';
import { MongoDbClient } from '../client.js';
import { createIndexes } from '../create-indexes.js';
import { createAtlasIndexes } from './create-atlas-indexes.js';
import { createScriptLogger, readMongoConfig } from './script-env.js';

/**
 * Script unificado de bootstrap de índices.
 *
 * Executar: `pnpm --filter @dmdoc/db-mongo setup-indexes`
 *
 * Cria em sequência:
 * 1. Índices regulares em todas as coleções (via `createIndex` — idempotente)
 * 2. Atlas Search (lexical, `chunks_text_search`) e Vector Search
 *    (`chunks_vector_search`) na coleção `chunks` (via `createSearchIndexes`)
 *
 * Pode ser executado quantas vezes for preciso: índices já existentes são pulados.
 *
 * Variáveis de ambiente:
 *   MONGO_URI  — connection string (default: mongodb://localhost:27017)
 *   MONGO_DB   — nome do banco    (default: dmdoc)
 *   LOG_LEVEL  — nível de log     (default: info)
 */
async function main(): Promise<void> {
  const log = createScriptLogger('setup-all-indexes');
  const { uri, dbName } = readMongoConfig();

  log.info({ uri, dbName }, 'conectando ao MongoDB');
  const client = await MongoDbClient.connect(uri, dbName);

  try {
    log.info('--- [1/2] índices regulares ---');
    const regularCount = await createIndexes(client);
    log.info({ created: regularCount }, 'índices regulares concluídos');

    log.info('--- [2/2] Atlas Search + Vector Search ---');
    const atlasCount = await createAtlasIndexes(client);
    log.info({ created: atlasCount }, 'search indexes concluídos');

    log.info({ regularCount, atlasCount }, 'setup de índices finalizado');
  } finally {
    await client.close();
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    createScriptLogger('setup-all-indexes').error({ err }, 'falha ao criar índices');
    process.exitCode = 1;
  });
}
