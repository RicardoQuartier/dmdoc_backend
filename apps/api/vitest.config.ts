import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // mongodb-memory-server baixa um binário do mongod no primeiro run.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
