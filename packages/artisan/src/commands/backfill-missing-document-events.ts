import { backfillMissingDocumentEvents as run } from '@dmdoc/db-pg';
import { withConnection } from '../lib/with-connection.js';
import type { ArtisanCommand } from '../types.js';

export const command: ArtisanCommand = {
  name: 'backfill:missing-document-events',
  description:
    'Cria document_events ausentes para documents que nunca geraram evento de upload',
  run: async () => withConnection(run),
};
