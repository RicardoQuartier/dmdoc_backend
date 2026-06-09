import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@dmdoc/shared-types': path.resolve(
        import.meta.dirname,
        '../../packages/shared-types/src/index.ts'
      ),
      '@dmdoc/db-mongo': path.resolve(
        import.meta.dirname,
        '../../packages/db-mongo/src/index.ts'
      ),
      '@dmdoc/llm-provider': path.resolve(
        import.meta.dirname,
        '../../packages/llm-provider/src/index.ts'
      ),
    },
  },
  test: {
    // mongodb-memory-server baixa um binário do mongod no primeiro run.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
