import postgres from 'postgres';
import type { Sql } from 'postgres';
import { applyMigrations } from './migrate-fresh.js';
import {
  RUN_DATABASE_LIKE_PATTERN,
  TEST_RUN_LOCK_NAMESPACE,
  databaseNameOf,
  maintenanceDatabaseUrl,
  resolveTestRunDatabaseUrl,
  testRunLockKeyOf,
} from './test-database.js';

/**
 * globalSetup do Vitest para a suíte de `@dmdoc/db-pg`.
 *
 * Roda UMA vez, antes de qualquer arquivo de teste, e dá a esta execução um
 * banco EXCLUSIVO — `dmdoc_test_<chave>` — criado do zero e migrado com todas
 * as migrations. No teardown o banco é dropado.
 *
 * ## Por que banco por execução
 *
 * Antes, todas as suítes (deste pacote e de `apps/api`) rodavam contra o mesmo
 * `dmdoc_test`, e o `migrate:fresh` do setup faz `DROP SCHEMA public CASCADE`.
 * Duas execuções sobrepostas se destruíam mutuamente: a que chegava depois
 * dropava o schema no meio da outra, que passava a falhar com
 * `relation "..." does not exist` em arquivos aleatórios — sintoma que parece
 * bug do código sob teste. Com um banco por execução não há mais estado
 * compartilhado: rodar `db-pg` e `api` em paralelo, ou dois `db-pg` ao mesmo
 * tempo, é seguro.
 *
 * ## Advisory lock = marca de "execução viva"
 *
 * A chave numérica no nome do banco é usada em `pg_advisory_lock` numa conexão
 * ao banco `postgres` mantida aberta durante TODA a execução. Serve só para
 * coleta de lixo: se um run for morto (SIGKILL, CI cancelado), o teardown não
 * roda e o banco fica órfão — o próximo run identifica órfãos justamente por
 * conseguir adquirir o lock deles (locks morrem junto com a sessão) e os dropa.
 * Bancos de execuções vivas nunca são tocados. O lock NÃO serializa nada: cada
 * execução tranca uma chave diferente.
 *
 * ## Segurança
 *
 * O único banco dropado é o desta execução (mais órfãos comprovadamente sem
 * dono). O banco de desenvolvimento `dmdoc` nunca é alcançado: o nome é sempre
 * reescrito para `dmdoc_test_<chave>` (ver `test-database.ts`).
 */

/** DDL de banco não é parametrizável; o nome vem de `dmdoc_test_<dígitos>`, nunca de input externo. */
async function dropDatabase(sql: Sql, databaseName: string): Promise<void> {
  await sql.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
}

/**
 * Dropa bancos `dmdoc_test_*` deixados para trás por execuções que morreram sem
 * teardown. Um banco só é considerado órfão quando o advisory lock da sua chave
 * pode ser adquirido — ou seja, nenhuma execução viva o está usando.
 */
async function dropOrphanRunDatabases(sql: Sql, ownDatabaseName: string): Promise<void> {
  const rows = await sql<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE datname LIKE ${RUN_DATABASE_LIKE_PATTERN}
  `;

  for (const { datname } of rows) {
    if (datname === ownDatabaseName) continue;
    const key = testRunLockKeyOf(datname);
    if (key === undefined) continue;

    const [locked] = await sql<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(${TEST_RUN_LOCK_NAMESPACE}, ${key}) AS acquired
    `;
    if (locked?.acquired !== true) continue;

    try {
      await dropDatabase(sql, datname);
      console.log(`🧹 banco de teste órfão removido: ${datname}`);
    } catch (err: unknown) {
      // Coleta de lixo é best-effort: nunca derruba a execução atual.
      console.warn(`⚠️  não foi possível remover o banco órfão ${datname}: ${String(err)}`);
    } finally {
      await sql`SELECT pg_advisory_unlock(${TEST_RUN_LOCK_NAMESPACE}, ${key})`;
    }
  }
}

export async function setup(): Promise<() => Promise<void>> {
  const runUrl = resolveTestRunDatabaseUrl();
  const runDatabase = databaseNameOf(runUrl);
  const runKey = testRunLockKeyOf(runDatabase);
  if (runKey === undefined) {
    throw new Error(`test-global-setup: nome de banco de execução inesperado: "${runDatabase}"`);
  }

  // `max: 1` + `idle_timeout: 0`: uma única sessão, que precisa continuar viva
  // (é ela que segura o advisory lock desta execução) até o teardown.
  // `onnotice` silencioso: os `DROP ... IF EXISTS` daqui geram NOTICEs
  // ("database ... does not exist, skipping") que só confundem quem lê o log de
  // uma suíte procurando por erro de schema.
  const maintenance = postgres(maintenanceDatabaseUrl(runUrl), {
    max: 1,
    idle_timeout: 0,
    onnotice: () => {},
  });

  try {
    await maintenance`SELECT pg_advisory_lock(${TEST_RUN_LOCK_NAMESPACE}, ${runKey})`;
    await dropOrphanRunDatabases(maintenance, runDatabase);
    await dropDatabase(maintenance, runDatabase);
    await maintenance.unsafe(`CREATE DATABASE "${runDatabase}"`);
    console.log(`🧪 banco desta execução: ${runDatabase}`);

    // Banco recém-criado: nada a dropar, basta aplicar as migrations. Os testes
    // leem a URL de `test.env` (vitest.config.ts); DATABASE_URL do processo
    // principal é fixada por coerência com quem rodar código de app no setup.
    process.env['DATABASE_URL'] = runUrl;
    applyMigrations(runUrl);
  } catch (err: unknown) {
    await maintenance.end();
    throw err;
  }

  return async () => {
    try {
      await dropDatabase(maintenance, runDatabase);
    } finally {
      // Fecha a sessão do lock — o lock cai junto.
      await maintenance.end();
    }
  };
}
