import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { resolveTestRunDatabaseUrl } from '../../packages/db-pg/src/test-database.js';

/**
 * Os pacotes do workspace (`@dmdoc/*`) declaram `exports` apontando para `dist`,
 * que nem sempre está buildado em ambiente de teste. Para os testes do worker,
 * resolvemos esses pacotes direto do `src` — mesma estratégia do `apps/api`.
 *
 * A suíte usa um banco EXCLUSIVO por execução (`dmdoc_test_<chave>`), criado e
 * dropado pelo `globalSetup` — o mesmo mecanismo de `apps/api` e `@dmdoc/db-pg`
 * (ver `packages/db-pg/src/test-database.ts` para o porquê). A URL base
 * (host/porta/credenciais) vem de `TEST_DATABASE_URL` se definida, senão do
 * `DATABASE_URL` do ambiente; o nome do banco é SEMPRE reescrito para
 * `dmdoc_test_*`, então o banco de desenvolvimento é inalcançável por
 * construção.
 */
const runDatabaseUrl = resolveTestRunDatabaseUrl();

export default defineConfig({
  resolve: {
    alias: {
      '@dmdoc/shared-types': path.resolve(
        import.meta.dirname,
        '../../packages/shared-types/src/index.ts'
      ),
      '@dmdoc/db-pg': path.resolve(
        import.meta.dirname,
        '../../packages/db-pg/src/index.ts'
      ),
      '@dmdoc/extractor': path.resolve(
        import.meta.dirname,
        '../../packages/extractor/src/index.ts'
      ),
    },
  },
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Todos os arquivos rodam contra o MESMO banco desta execução; serializar
    // elimina corrida entre arquivos que semeiam e apagam as mesmas tabelas.
    fileParallelism: false,
    globalSetup: ['./src/test/global-setup.ts'],
    env: {
      // Os arquivos resolvem `TEST_DATABASE_URL ?? DATABASE_URL`; fixamos as
      // duas no banco desta execução para não sobrar caminho que caia num banco
      // compartilhado.
      DATABASE_URL: runDatabaseUrl,
      TEST_DATABASE_URL: runDatabaseUrl,
    },
  },
});
