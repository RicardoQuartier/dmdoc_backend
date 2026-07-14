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
    // Aplica migrate:fresh uma vez no banco de teste (schema limpo e completo,
    // incluindo 0004/0005) antes de qualquer arquivo — garante que testes de
    // ai-feature-flags/platform-settings não falhem por "relation does not
    // exist" quando o dmdoc_test está atrás do repositório.
    globalSetup: ['./src/test-global-setup.ts'],
    env: {
      DATABASE_URL: 'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test',
    },
  },
});
