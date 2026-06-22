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
    env: {
      DATABASE_URL: 'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test',
    },
  },
});
