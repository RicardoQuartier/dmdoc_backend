export { MongoDbClient } from './client.js';
export {
  type TenantContext,
  type RepositoryContext,
  hasTenant,
} from './tenant-context.js';
export {
  TenantRepository,
  createTenantRepository,
  type TenantDocument,
  type CreateInput,
  type UpdateInput,
} from './tenant-repository.js';
export {
  newId,
  toObjectId,
  normalizeLimit,
  type PaginationOptions,
  type Page,
} from './helpers.js';
export {
  assertUserScopeInvariant,
  validateUserDocument,
  UserScopeInvariantError,
  type UserScopeCandidate,
} from './user-write-validation.js';
export {
  lexicalSearch,
  vectorSearch,
  hybridSearch,
  documentMetadataSearch,
  type ChunkSearchResult,
  type SearchParams,
  type LexicalSearchParams,
  type VectorSearchParams,
  type HybridSearchParams,
  type MetadataSearchParams,
  ChunkSearchResultSchema,
} from './search.js';
