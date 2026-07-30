export type {
  DownloadUrlOptions,
  PutParams,
  StorageDriver,
  StorageProvider,
  UrlAudience,
} from './driver.js';

export { S3Driver, createS3Driver, type S3Config } from './s3-driver.js';

export {
  SharePointDriver,
  createSharePointDriver,
  type FetchLike,
  type SharePointConfig,
  type SharePointDriverDeps,
} from './sharepoint-driver.js';

export {
  StorageAuthError,
  StorageConfigError,
  StorageError,
  StorageInvalidKeyError,
  StorageNotFoundError,
  StorageRateLimitError,
  StorageTargetError,
  type StorageErrorDetails,
} from './errors.js';

export {
  buildStorageDriver,
  createStorageResolver,
  parseStorageTarget,
  resolveStorageDriver,
  resolveStorageDriverForConfig,
  type ResolvedStorageTarget,
  type StorageDestination,
  type StorageResolver,
  type StorageResolverDeps,
  type StorageSql,
  type TenantStorageConfigRow,
} from './resolve.js';

export { storageLocationKey } from './location.js';

export {
  StorageCryptoError,
  decryptSecret,
  encryptSecret,
  parseSecretKey,
  secretsMatch,
} from './crypto.js';
