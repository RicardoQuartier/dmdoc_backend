export * from './schema.js';
export * from './client.js';
export * from './tenant-context.js';
export * from './helpers.js';
export * from './tenant-repository.js';
export * from './document-events-repository.js';
export * from './search.js';
export * from './user-write-validation.js';
export * from './tenant-deletion.js';
export * from './ai-feature-flags.js';
export * from './document-type-catalog.js';
export { dbFresh } from './db-fresh.js';
export { seed } from './seed.js';
export { migrateFresh } from './migrate-fresh.js';
export { run as backfillEventDocumentType } from './backfill-event-document-type.js';
export { run as backfillMissingDocumentEvents } from './backfill-missing-document-events.js';

/** Constante para compatibilidade com código que usava DOCUMENT_EVENTS_COLLECTION do db-mongo. */
export const DOCUMENT_EVENTS_COLLECTION = 'document_events';
