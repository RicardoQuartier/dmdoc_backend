import { migrateFresh } from '@dmdoc/db-pg';
import type { ArtisanCommand } from '../types.js';

export const command: ArtisanCommand = {
  name: 'db:migrate-fresh',
  description:
    'Dropa o schema público e reaplica todas as migrations via drizzle-kit (destrutivo, sem seed)',
  run: async () => migrateFresh(),
};
