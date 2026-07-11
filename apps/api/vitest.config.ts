import { defineConfig } from 'vitest/config';
import path from 'node:path';

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
    // Todos os arquivos rodam contra o MESMO Postgres `dmdoc_test`. Serializar
    // os arquivos (sem paralelismo) elimina corridas em que um arquivo apaga/
    // insere dados que outro está usando. O isolamento por arquivo é reforçado
    // pelo setupFile `reset-each-file.ts`, que zera as tabelas antes de cada um.
    fileParallelism: false,
    // Aplica migrate:fresh uma vez no banco de teste (schema limpo e completo,
    // incluindo 0004/0005) antes de qualquer arquivo rodar.
    globalSetup: ['./src/test/global-setup.ts'],
    // Zera as tabelas de domínio antes de cada arquivo de teste.
    setupFiles: ['./src/test/reset-each-file.ts'],
    env: {
      DATABASE_URL: 'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test',
    },
  },
});
