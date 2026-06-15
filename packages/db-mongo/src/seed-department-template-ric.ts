import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CreateDepartmentTemplateBodySchema } from '@dmdoc/shared-types';
import { MongoDbClient } from './client.js';
import { newId } from './helpers.js';
import { createScriptLogger, readMongoConfig } from './scripts/script-env.js';

/**
 * Seeder EXCLUSIVO do template de departamentos "Ricardo".
 *
 * Executar: `pnpm --filter @dmdoc/db-mongo seed:department-template-ric`
 *
 * Origem dos dados: dump da máquina de testes (coleção `departments`),
 * convertido para o formato de template em `data/department-template-ric.json`.
 * A conversão preserva a árvore: cada `id` real do dump virou um `refId`
 * INTERNO do template e cada `parentId` virou `parentRefId`. Esses refIds nunca
 * vazam para um tenant — ao aplicar o template, `apply-template-to-tenant` gera
 * ids novos. Departamentos `deleted: true` foram descartados na conversão.
 *
 * IDEMPOTENTE: upsert pela chave natural `name` ("Ricardo"). Rodar N vezes não
 * duplica nem altera o `id`/`createdAt` já existentes — apenas re-sincroniza os
 * nodes/description e `updatedAt`.
 *
 * A coleção `department_templates` é GLOBAL (sem `tenantId`, sem soft-delete);
 * ver *Templates de departamentos: estrutura e aplicação na criação de empresa*.
 */

const dataPath = fileURLToPath(
  new URL('./data/department-template-ric.json', import.meta.url),
);

/**
 * Lê e valida o arquivo de dados do template com o mesmo schema das rotas
 * (`CreateDepartmentTemplateBodySchema`): garante refIds uuid, parentRefs
 * íntegros e no máximo 200 nós ANTES de tocar o banco.
 */
function loadTemplate(): ReturnType<typeof CreateDepartmentTemplateBodySchema.parse> {
  const raw: unknown = JSON.parse(readFileSync(dataPath, 'utf-8'));
  return CreateDepartmentTemplateBodySchema.parse(raw);
}

export async function seedDepartmentTemplateRic(client: MongoDbClient): Promise<void> {
  const log = createScriptLogger('seed:department-template-ric');
  const db = client.getDb();

  const template = loadTemplate();

  const res = await db.collection('department_templates').findOneAndUpdate(
    { name: template.name },
    {
      $setOnInsert: { id: newId(), createdAt: new Date() },
      $set: {
        name: template.name,
        ...(template.description !== undefined ? { description: template.description } : {}),
        nodes: template.nodes,
        updatedAt: new Date(),
      },
    },
    { upsert: true, returnDocument: 'after' },
  );

  const doc = res as { id: string } | null;
  log.info(
    { templateId: doc?.id ?? '', name: template.name, nodes: template.nodes.length },
    'template de departamentos "Ricardo" garantido',
  );
}

async function main(): Promise<void> {
  const log = createScriptLogger('seed:department-template-ric');
  const { uri, dbName } = readMongoConfig();
  log.info({ uri, dbName }, 'conectando ao MongoDB');

  const client = await MongoDbClient.connect(uri, dbName);
  try {
    await seedDepartmentTemplateRic(client);
  } finally {
    await client.close();
  }
}

// Executa quando rodado como script (via tsx), não quando importado.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    createScriptLogger('seed:department-template-ric').error(
      { err },
      'falha ao semear template "Ricardo"',
    );
    process.exitCode = 1;
  });
}
