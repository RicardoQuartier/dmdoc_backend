import { defineConfig } from 'vitest/config';
import { resolveTestRunDatabaseUrl } from './src/test-database.js';

/**
 * Os testes de `@dmdoc/db-pg` exercitam a integração real com PostgreSQL
 * (sem mocks de banco).
 *
 * Cada execução usa um banco EXCLUSIVO — `dmdoc_test_<chave>` — criado e
 * dropado pelo `globalSetup`. A URL é sorteada aqui, na carga do config (no
 * processo principal do Vitest), e injetada em `test.env` para que os workers
 * usem exatamente o mesmo banco; o `globalSetup` recupera o mesmo valor pelo
 * cache em `process.env`. Ver `src/test-database.ts` para o porquê.
 *
 * A URL base (host/porta/credenciais) vem de `TEST_DATABASE_URL` se definida,
 * senão do `DATABASE_URL` do ambiente — o que faz a suíte funcionar dentro do
 * container sem precisar passar `-e TEST_DATABASE_URL=...`. O nome do banco é
 * sempre reescrito para `dmdoc_test_*`, então o banco de dev nunca é tocado.
 */
const runDatabaseUrl = resolveTestRunDatabaseUrl();

export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Arquivos de teste rodam contra o MESMO banco da execução. Alguns (ex.:
    // tenant-deletion.test.ts) fazem limpeza total de tabelas compartilhadas
    // (`DELETE FROM tenants` sem WHERE) em beforeEach — rodar arquivos em
    // paralelo causa condição de corrida entre eles (um arquivo apaga linhas
    // que outro estava usando). Serializar os arquivos elimina o flake sem
    // exigir isolamento por schema/transação em cada teste.
    fileParallelism: false,
    // Cria o banco desta execução e aplica todas as migrations nele antes de
    // qualquer arquivo rodar; dropa o banco no teardown.
    globalSetup: ['./src/test-global-setup.ts'],
    env: {
      // Os arquivos de teste resolvem `TEST_DATABASE_URL ?? DATABASE_URL`;
      // fixamos as duas no banco desta execução para não sobrar caminho que
      // caia no `dmdoc_test` compartilhado.
      DATABASE_URL: runDatabaseUrl,
      TEST_DATABASE_URL: runDatabaseUrl,
    },
  },
});
