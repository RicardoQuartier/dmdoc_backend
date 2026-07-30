import type { Sql } from 'postgres';
import {
  parseSecretKey,
  resolveStorageDriver,
  resolveStorageDriverForConfig,
  type S3Config,
  type StorageDriver,
  type StorageResolverDeps,
} from '@dmdoc/storage';
import type { Config } from './config.js';

/**
 * O que o worker precisa de um resolvedor de armazenamento.
 *
 * São DUAS perguntas, e confundi-las é o defeito que a ADR-1 do E-11 corrigiu:
 *
 * - `forTenant` — destino ATIVO da empresa. Só serve a quem opera sobre a
 *   empresa inteira sem um documento em mãos (a purga de tenant varre por
 *   prefixo).
 * - `forStorageConfig` — destino DAQUELE documento (`documents.storage_config_id`,
 *   `null` = S3 da plataforma). É o que o pipeline usa: reprocessar um documento
 *   que ficou num destino aposentado precisa buscá-lo LÁ, não onde a empresa
 *   grava hoje.
 *
 * Interface própria (em vez de `StorageResolver` do pacote) porque nada aqui
 * invalida cache — e um contrato enxuto é o que um teste consegue dublar sem
 * construir meio pacote.
 */
export interface StorageForTenant {
  forTenant(tenantId: string): Promise<StorageDriver>;
  forStorageConfig(tenantId: string, storageConfigId: string | null): Promise<StorageDriver>;
}

/**
 * Monta o resolvedor de armazenamento do worker a partir da config validada.
 *
 * Usa as funções sem cache (`resolveStorageDriver` /
 * `resolveStorageDriverForConfig`) e não `createStorageResolver`: o worker
 * resolve uma vez por JOB, e um job dura de segundos a minutos — reler uma linha
 * de `tenant_storage_configs` por job é ruído perto de extrair, embeddar e
 * classificar um documento. Em troca, uma troca de destino ou rotação de
 * credencial vale no job seguinte, sem TTL para esperar nem cache para invalidar
 * entre réplicas.
 *
 * Nenhum `process.env` é lido aqui — só `config` (validada por Zod no boot).
 */
export function createWorkerStorage(sql: Sql, cfg: Config): StorageForTenant {
  const deps: StorageResolverDeps = {
    sql,
    platformS3Config: buildPlatformS3Config(cfg),
    secretKey: parseSecretKey(cfg.STORAGE_SECRET_KEY),
  };

  return {
    forTenant: (tenantId: string): Promise<StorageDriver> =>
      resolveStorageDriver(deps, tenantId),
    forStorageConfig: (
      tenantId: string,
      storageConfigId: string | null
    ): Promise<StorageDriver> => resolveStorageDriverForConfig(deps, tenantId, storageConfigId),
  };
}

/**
 * Monta a S3Config do bucket DA PLATAFORMA a partir da Config do worker — o
 * destino de toda empresa sem linha em `tenant_storage_configs`.
 *
 * Diferente da API, as credenciais são opcionais no schema do worker: quando
 * ausentes, o SDK cai na cadeia de credenciais padrão da AWS (útil quando o
 * contêiner roda com role IAM em vez de chave estática).
 */
export function buildPlatformS3Config(cfg: Config): S3Config {
  return {
    region: cfg.AWS_REGION,
    bucket: cfg.AWS_S3_BUCKET,
    accessKeyId: cfg.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: cfg.AWS_SECRET_ACCESS_KEY ?? '',
    ...(cfg.S3_ENDPOINT !== undefined ? { endpoint: cfg.S3_ENDPOINT } : {}),
    forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
  };
}
