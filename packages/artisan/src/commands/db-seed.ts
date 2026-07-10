import { seed } from '@dmdoc/db-pg';
import { withConnection } from '../lib/with-connection.js';
import type { ArtisanCommand } from '../types.js';

export const command: ArtisanCommand = {
  name: 'db:seed',
  description: 'Popula o banco com dados de seed (tenants, usuários, tipos de documento de teste)',
  run: async () => withConnection(seed),
};
