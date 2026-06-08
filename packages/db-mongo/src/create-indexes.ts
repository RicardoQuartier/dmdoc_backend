import { pathToFileURL } from 'node:url';
import { MongoDbClient } from './client.js';
import { createScriptLogger, readMongoConfig } from './scripts/script-env.js';
import { REGULAR_INDEXES } from './scripts/index-definitions.js';

/**
 * Script de bootstrap: cria todos os índices REGULARES do MongoDB (spec §5.3/§5.4).
 *
 * Executar: `pnpm --filter @dmdoc/db-mongo create-indexes`
 * Lê `MONGO_URI` / `MONGO_DB` do ambiente (defaults de dev em `script-env.ts`).
 *
 * Idempotente: `createIndex` é no-op quando o índice já existe com a mesma
 * definição, então o script pode ser executado quantas vezes for preciso.
 *
 * FORA DO ESCOPO: os índices de Vector Search e Atlas Search (coleção `chunks`,
 * spec §5.3) NÃO são criados aqui — o driver MongoDB não os suporta. Eles são
 * criados na Fase 3 (entregável 25) via Atlas Management API.
 */
export async function createIndexes(client: MongoDbClient): Promise<number> {
  const log = createScriptLogger('create-indexes');
  const db = client.getDb();
  let created = 0;

  for (const [collection, indexes] of Object.entries(REGULAR_INDEXES)) {
    for (const index of indexes) {
      const name = await db.collection(collection).createIndex(index.keys, index.options);
      created += 1;
      log.info(
        { collection, index: name, unique: index.options.unique ?? false, keys: index.keys },
        'índice garantido',
      );
    }
  }

  log.info({ totalIndexes: created }, 'todos os índices regulares garantidos');
  log.warn(
    'Vector Search e Atlas Search NÃO são criados aqui — Fase 3 (entregável 25) via Atlas API.',
  );
  return created;
}

async function main(): Promise<void> {
  const log = createScriptLogger('create-indexes');
  const { uri, dbName } = readMongoConfig();
  log.info({ uri, dbName }, 'conectando ao MongoDB');

  const client = await MongoDbClient.connect(uri, dbName);
  try {
    await createIndexes(client);
  } finally {
    await client.close();
  }
}

// Executa quando rodado como script (via tsx), não quando importado.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    createScriptLogger('create-indexes').error({ err }, 'falha ao criar índices');
    process.exitCode = 1;
  });
}
