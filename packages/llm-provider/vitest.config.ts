import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  cacheDir: path.resolve(import.meta.dirname, '/tmp/vitest-cache/llm-provider'),
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
