import { randomInt } from 'node:crypto';

/**
 * Resolução do banco de teste **por execução** (`dmdoc_test_<chave>`).
 *
 * ## Por que existe
 *
 * O `globalSetup` da suíte aplica `migrate:fresh`, que faz `DROP SCHEMA public
 * CASCADE`. Enquanto todos os pacotes (`@dmdoc/db-pg` e `apps/api`) apontavam
 * para o MESMO banco `dmdoc_test`, duas execuções sobrepostas se destruíam
 * mutuamente: a segunda dropava o schema no meio da primeira, que passava a
 * falhar com `relation "chunks" does not exist` em arquivos aleatórios.
 * Reproduzido de forma determinística rodando duas suítes com 1s de defasagem.
 *
 * A correção é isolar por execução: cada `vitest run` cria e usa um banco
 * próprio, `dmdoc_test_<chave>`, e o dropa no teardown. Dois runs concorrentes
 * — do mesmo pacote ou de pacotes diferentes — deixam de compartilhar estado, e
 * a classe inteira do problema desaparece (inclusive em CI com jobs paralelos).
 *
 * ## Como a chave é propagada
 *
 * A URL da execução é sorteada UMA vez e memorizada em `process.env`
 * (`DMDOC_TEST_RUN_DATABASE_URL`). O `vitest.config.ts` a resolve no processo
 * principal (na carga do config), injeta o valor em `test.env` — de onde os
 * workers a leem — e o `globalSetup`, rodando no mesmo processo, recupera o
 * valor memorizado. Assim config, setup e workers concordam sem depender de
 * ordem de importação de módulos.
 *
 * O nome do banco carrega a chave numérica usada no advisory lock que marca a
 * execução como viva (ver `test-global-setup.ts`) — o nome é a única fonte de
 * verdade, não há segundo canal a sincronizar.
 */

/** Banco base; o banco de cada execução é `${BASE_TEST_DATABASE_NAME}_<chave>`. */
const BASE_TEST_DATABASE_NAME = 'dmdoc_test';

/** Env var que memoriza a URL sorteada para esta execução. */
const RUN_DATABASE_URL_ENV = 'DMDOC_TEST_RUN_DATABASE_URL';

/** Usado quando não há `TEST_DATABASE_URL` nem `DATABASE_URL` (rodando no host). */
const FALLBACK_BASE_URL = `postgresql://dmdoc:dmdoc@localhost:5432/${BASE_TEST_DATABASE_NAME}`;

/**
 * `classid` dos advisory locks de execução de teste. Valor arbitrário, só
 * precisa ser estável e não colidir com outros usos de advisory lock no projeto
 * (hoje não há nenhum).
 */
export const TEST_RUN_LOCK_NAMESPACE = 4102;

/** Bancos de execução: `dmdoc_test_` seguido só de dígitos. */
const RUN_DATABASE_NAME_PATTERN = new RegExp(`^${BASE_TEST_DATABASE_NAME}_(\\d+)$`);

function replaceDatabaseName(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

/** Nome do banco de uma connection string (`.../dmdoc_test_42` → `dmdoc_test_42`). */
export function databaseNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

/**
 * URL do banco **base** de teste, antes do sufixo da execução.
 *
 * Ordem de resolução:
 *  1. `TEST_DATABASE_URL` explícita — precisa apontar para `dmdoc_test`;
 *  2. `DATABASE_URL` (dentro do container aponta para o banco de dev `dmdoc`):
 *     aproveita host/porta/credenciais e TROCA o nome do banco para
 *     `dmdoc_test`. É o que dispensa passar `-e TEST_DATABASE_URL=...` no
 *     `docker compose exec`;
 *  3. localhost, para quem roda no host.
 *
 * O banco de dev nunca é tocado: o nome é sempre reescrito para `dmdoc_test*`.
 */
function resolveBaseTestDatabaseUrl(): string {
  const explicit = process.env['TEST_DATABASE_URL']?.trim();
  if (explicit !== undefined && explicit !== '') {
    const name = databaseNameOf(explicit);
    if (name !== BASE_TEST_DATABASE_NAME) {
      throw new Error(
        `TEST_DATABASE_URL precisa apontar para o banco "${BASE_TEST_DATABASE_NAME}" ` +
          `(recebido: "${name}"). A suíte cria um banco próprio por execução ` +
          `("${BASE_TEST_DATABASE_NAME}_<chave>") a partir dessa URL.`,
      );
    }
    return explicit;
  }

  const runtime = process.env['DATABASE_URL']?.trim();
  if (runtime !== undefined && runtime !== '') {
    return replaceDatabaseName(runtime, BASE_TEST_DATABASE_NAME);
  }

  return FALLBACK_BASE_URL;
}

/**
 * URL do banco desta execução (`dmdoc_test_<chave>`), sorteada na primeira
 * chamada do processo e memorizada em `process.env` — chamadas seguintes, aqui
 * ou em processos filhos que herdaram o env, devolvem exatamente a mesma URL.
 */
export function resolveTestRunDatabaseUrl(): string {
  const cached = process.env[RUN_DATABASE_URL_ENV]?.trim();
  if (cached !== undefined && cached !== '') return cached;

  // int32 positivo: cabe nos dois argumentos int4 de pg_advisory_lock.
  const runKey = randomInt(1, 2 ** 31);
  const url = replaceDatabaseName(
    resolveBaseTestDatabaseUrl(),
    `${BASE_TEST_DATABASE_NAME}_${runKey}`,
  );
  process.env[RUN_DATABASE_URL_ENV] = url;
  return url;
}

/** URL do banco de manutenção (`postgres`) no mesmo servidor — onde se faz CREATE/DROP DATABASE. */
export function maintenanceDatabaseUrl(url: string): string {
  return replaceDatabaseName(url, 'postgres');
}

/** Chave de advisory lock embutida no nome do banco de execução. */
export function testRunLockKeyOf(databaseName: string): number | undefined {
  const digits = RUN_DATABASE_NAME_PATTERN.exec(databaseName)?.[1];
  if (digits === undefined) return undefined;
  const key = Number(digits);
  return Number.isSafeInteger(key) && key > 0 && key < 2 ** 31 ? key : undefined;
}

/** Predicado `LIKE` que casa com todos os bancos de execução de teste. */
export const RUN_DATABASE_LIKE_PATTERN = `${BASE_TEST_DATABASE_NAME}\\_%`;
