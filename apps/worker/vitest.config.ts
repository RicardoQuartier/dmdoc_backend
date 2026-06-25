import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Os pacotes do workspace (`@dmdoc/*`) declaram `exports` apontando para `dist`,
 * que nem sempre está buildado em ambiente de teste. Para os testes do worker,
 * resolvemos esses pacotes direto do `src` — mesma estratégia do `apps/api`.
 */
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
      '@dmdoc/extractor': path.resolve(
        import.meta.dirname,
        '../../packages/extractor/src/index.ts'
      ),
    },
  },
  test: {
    env: {
      DATABASE_URL: 'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test',
    },
  },
});
