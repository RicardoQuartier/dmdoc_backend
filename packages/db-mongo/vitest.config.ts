import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  cacheDir: path.resolve(import.meta.dirname, '/tmp/vitest-cache/db-mongo'),
  resolve: {
    alias: {
      '@dmdoc/shared-types': path.resolve(
        import.meta.dirname,
        '../shared-types/src/index.ts'
      ),
    },
  },
  test: {
    // mongodb-memory-server baixa um binário do mongod no primeiro run.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
