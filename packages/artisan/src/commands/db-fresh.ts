import { dbFresh, seed } from '@dmdoc/db-pg';
import { withConnection } from '../lib/with-connection.js';
import type { ArtisanCommand } from '../types.js';

export const command: ArtisanCommand = {
  name: 'db:fresh',
  description:
    'Trunca todas as tabelas e repopula com os dados de seed (equivalente a migrate:fresh --seed do Laravel)',
  run: async () =>
    withConnection(async (sql) => {
      await dbFresh(sql);
      await seed(sql);
    }),
};
