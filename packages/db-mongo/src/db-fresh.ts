import { pathToFileURL } from 'node:url';
import { MongoDbClient } from './client.js';
import { createIndexes } from './create-indexes.js';
import { seed } from './seed.js';
import { createScriptLogger, readMongoConfig } from './scripts/script-env.js';

/**
 * Script de reset completo do banco — equivalente ao `migrate:fresh --seed` do Laravel.
 *
 * Executar: `pnpm --filter @dmdoc/db-mongo db:fresh`
 *
 * Fluxo:
 *   1. Dropa o banco inteiro (todas as coleções e índices)
 *   2. Recria os índices regulares (create-indexes)
 *   3. Popula os dados iniciais (seed)
 *
 * ATENÇÃO: destrói todos os dados. Use apenas em desenvolvimento.
 */
async function main(): Promise<void> {
  const log = createScriptLogger('db-fresh');
  const { uri, dbName } = readMongoConfig();
  log.warn({ uri, dbName }, 'db:fresh — APAGANDO banco e recriando do zero');

  const client = await MongoDbClient.connect(uri, dbName);
  try {
    await client.getDb().dropDatabase();
    log.info({ dbName }, 'banco apagado');

    await createIndexes(client);
    await seed(client);

    log.info('db:fresh concluído — banco pronto para uso');
  } finally {
    await client.close();
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    createScriptLogger('db-fresh').error({ err }, 'falha no db:fresh');
    process.exitCode = 1;
  });
}
