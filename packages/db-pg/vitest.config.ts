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
    env: {
      DATABASE_URL: 'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test',
    },
  },
});
