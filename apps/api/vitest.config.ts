import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { resolveTestRunDatabaseUrl } from '../../packages/db-pg/src/test-database.js';

/**
 * A suíte de `apps/api` bate em PostgreSQL real e cada execução usa um banco
 * EXCLUSIVO — `dmdoc_test_<chave>` — criado e dropado pelo `globalSetup`
 * (mecanismo compartilhado com `@dmdoc/db-pg`, ver `src/test-database.ts` lá).
 *
 * A URL é sorteada aqui, na carga do config (processo principal do Vitest), e
 * injetada em `test.env` para que os workers usem exatamente o mesmo banco; o
 * `globalSetup`, rodando no mesmo processo, recupera o valor memorizado em
 * `process.env`. Não há segundo canal a sincronizar.
 *
 * Antes, todas as suítes apontavam para o mesmo `dmdoc_test` e o `globalSetup`
 * aplicava `migrate:fresh` (`DROP SCHEMA public CASCADE`) nele: duas execuções
 * sobrepostas se destruíam mutuamente, e a que chegava depois dropava o schema
 * no meio da outra — sintoma `relation "tenants" does not exist` em arquivos
 * aleatórios, que parece bug do código sob teste e não é.
 *
 * A URL base (host/porta/credenciais) vem de `TEST_DATABASE_URL` se definida,
 * senão do `DATABASE_URL` do ambiente — por isso não é mais preciso passar
 * `-e TEST_DATABASE_URL=...` no `docker compose exec`. O nome do banco é
 * SEMPRE reescrito para `dmdoc_test_*`, então o banco de desenvolvimento
 * (`dmdoc`) é inalcançável por construção.
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
      '@dmdoc/llm-provider': path.resolve(
        import.meta.dirname,
        '../../packages/llm-provider/src/index.ts'
      ),
    },
  },
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Todos os arquivos rodam contra o MESMO banco desta execução. Serializar
    // os arquivos (sem paralelismo) elimina corridas em que um arquivo apaga/
    // insere dados que outro está usando. O isolamento por arquivo é reforçado
    // pelo setupFile `reset-each-file.ts`, que zera as tabelas antes de cada um.
    fileParallelism: false,
    // Cria o banco desta execução e aplica todas as migrations nele antes de
    // qualquer arquivo rodar; dropa o banco no teardown.
    globalSetup: ['./src/test/global-setup.ts'],
    // Zera as tabelas de domínio antes de cada arquivo de teste.
    setupFiles: ['./src/test/reset-each-file.ts'],
    env: {
      // Os arquivos de teste resolvem `TEST_DATABASE_URL ?? DATABASE_URL`;
      // fixamos as duas no banco desta execução para não sobrar caminho que
      // caia num banco compartilhado.
      DATABASE_URL: runDatabaseUrl,
      TEST_DATABASE_URL: runDatabaseUrl,
    },
  },
});
