import { backfillEventDocumentType as run } from '@dmdoc/db-pg';
import { withConnection } from '../lib/with-connection.js';
import type { ArtisanCommand } from '../types.js';

export const command: ArtisanCommand = {
  name: 'backfill:event-document-type',
  description:
    'Preenche document_type_id/document_type_name ausentes em document_events a partir de documents',
  run: async () => withConnection(run),
};
