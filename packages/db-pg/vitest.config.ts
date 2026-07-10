import { defineConfig } from 'vitest/config';

/**
 * Os testes de `@dmdoc/db-pg` exercitam a integração real com PostgreSQL
 * (sem mocks de banco). Apontam para o banco de teste `dmdoc_test`, criado e
 * migrado com o mesmo schema do ambiente de desenvolvimento. Em CI, uma
 * instância PostgreSQL com esse banco deve estar disponível.
 */
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Arquivos de teste rodam contra o MESMO banco `dmdoc_test`. Alguns (ex.:
    // tenant-deletion.test.ts) fazem limpeza total de tabelas compartilhadas
    // (`DELETE FROM tenants` sem WHERE) em beforeEach — rodar arquivos em
    // paralelo causa condição de corrida entre eles (um arquivo apaga linhas
    // que outro estava usando). Serializar os arquivos elimina o flake sem
    // exigir isolamento por schema/transação em cada teste.
    fileParallelism: false,
    env: {
      DATABASE_URL: 'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test',
    },
  },
});
