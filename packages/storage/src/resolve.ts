import { createHash } from 'node:crypto';

import { decryptSecret, StorageCryptoError } from './crypto.js';
import type { StorageDriver } from './driver.js';
import { StorageTargetError } from './errors.js';
import { createS3Driver as defaultCreateS3Driver, type S3Config } from './s3-driver.js';
import {
  createSharePointDriver as defaultCreateSharePointDriver,
  type SharePointConfig,
} from './sharepoint-driver.js';

/**
 * Resolução do destino de armazenamento — por CONFIGURAÇÃO, não por empresa.
 *
 * Espelha `resolveAiFeatureFlags` (`packages/db-pg/src/ai-feature-flags.ts:92`)
 * na forma da consulta, mas acrescenta cache — e é o cache que justifica um
 * módulo próprio: o `SharePointDriver` guarda um token OAuth com validade de
 * ~1 h e uma requisição de token em voo; reconstruí-lo a cada upload jogaria
 * fora esse estado e pediria um token novo ao Entra ID por requisição.
 *
 * ## Duas perguntas diferentes (ADR-1 do épico E-11)
 *
 * | Pergunta | Entrada |
 * |---|---|
 * | "para ONDE gravo um arquivo novo desta empresa?" | `forTenant` / `activeDestination` — a linha `active` |
 * | "de ONDE leio ESTE arquivo?" | `forStorageConfig(tenantId, documento.storage_config_id)` |
 *
 * As duas coincidem enquanto ninguém trocou de destino, e é justamente por isso
 * que confundi-las passa despercebido. Assim que uma empresa troca (e mais
 * ainda no meio de uma migração de acervo), o acervo antigo continua morando na
 * configuração APOSENTADA — resolver pelo destino corrente leria o bucket
 * errado, e, no caso S3→S3, leria um bucket que existe e simplesmente não tem o
 * objeto. Por isso a leitura é sempre pela configuração DO DOCUMENTO.
 *
 * ## As três origens de configuração
 *
 * | Linha em `tenant_storage_configs` | Driver |
 * |---|---|
 * | ausente, ou `('s3','platform')`   | `S3Driver` com a config da PLATAFORMA (o `.env`) |
 * | `('s3','tenant')`                 | `S3Driver` com o jsonb + `encrypted_secret` decifrado |
 * | `('sharepoint','tenant')`         | `SharePointDriver` com o jsonb + `encrypted_secret` decifrado |
 *
 * `documents.storage_config_id IS NULL` ≡ linha ausente ≡ `('s3','platform')` —
 * é o que faz todo o acervo anterior ao épico continuar no bucket de sempre sem
 * nenhum backfill (ver migration `0017_tenant_storage.sql`).
 *
 * ## O que este módulo NÃO faz
 *
 * Não lê `process.env` (spec §12): a config da plataforma e a chave mestra
 * chegam injetadas em `StorageResolverDeps`. Quem monta essas dependências é o
 * `config.ts` da app (API ou worker), único autorizado a ler o ambiente.
 *
 * Não decide o driver a partir de `documents.storage_provider`: essa coluna é
 * DENORMALIZAÇÃO (rótulo para tela e para `SELECT DISTINCT`) e não distingue
 * dois destinos do mesmo provider. A autoridade é `storage_config_id`.
 */

// ---------------------------------------------------------------------------
// Cliente SQL — tipo estrutural
// ---------------------------------------------------------------------------

/**
 * Subconjunto do cliente postgres.js usado aqui: só a tag de template.
 *
 * Declarado estruturalmente, em vez de importar `Sql` de `postgres`, para não
 * arrastar o driver do banco (nem `@dmdoc/db-pg`) para dentro de um pacote que
 * só fala de arquivo. O `Sql` de verdade é atribuível a este tipo — quem chama
 * passa `app.db` sem nenhum cast.
 */
export interface StorageSql {
  <T extends readonly object[]>(
    template: TemplateStringsArray,
    ...parameters: readonly string[]
  ): Promise<T>;
}

/** Linha crua de `tenant_storage_configs` (snake_case, como o postgres.js devolve). */
export interface TenantStorageConfigRow {
  provider: string;
  credentials_source: string;
  /** jsonb já desserializado pelo driver — objeto, nunca string (ver `assertPlainObject`). */
  config: unknown;
  encrypted_secret: string | null;
}

/**
 * A mesma linha, com o `id` — o que a consulta da configuração ATIVA precisa
 * devolver para que o upload grave `documents.storage_config_id`.
 *
 * O `id` fica FORA de `TenantStorageConfigRow` de propósito: `parseStorageTarget`
 * também é usado sobre uma configuração digitada no formulário e ainda não
 * gravada (o "Testar conexão" da T-140), que não tem id nenhum.
 */
interface IdentifiedStorageConfigRow extends TenantStorageConfigRow {
  id: string;
}

// ---------------------------------------------------------------------------
// Destino resolvido
// ---------------------------------------------------------------------------

/**
 * Destino de armazenamento de uma empresa, já validado e com o segredo EM
 * CLARO — o passo intermediário entre a linha do banco e o driver.
 *
 * É público porque a T-140 precisa construir um driver a partir da
 * configuração digitada no formulário (o "Testar conexão" roda ANTES de gravar,
 * então não há linha no banco para ler).
 */
export type ResolvedStorageTarget =
  | { provider: 's3'; credentialsSource: 'platform' }
  | { provider: 's3'; credentialsSource: 'tenant'; config: S3Config }
  | { provider: 'sharepoint'; credentialsSource: 'tenant'; config: SharePointConfig };

// ---------------------------------------------------------------------------
// Dependências
// ---------------------------------------------------------------------------

/**
 * Por quanto tempo uma instância de driver é reaproveitada.
 *
 * Note que a validade NÃO é o que protege contra configuração desatualizada:
 * toda resolução relê a linha e compara o hash, então uma troca de destino vale
 * na chamada seguinte, sem esperar nada. O TTL existe só para limitar a vida de
 * uma instância cujas credenciais podem ter sido rotacionadas NO PROVEDOR sem
 * passar pelo nosso banco.
 *
 * Por isso 5 min e não 60 s: um TTL de 60 s descartaria um token OAuth de 1 h
 * sessenta vezes por hora, por empresa ativa, sem ganho de correção nenhum.
 */
const DEFAULT_DRIVER_TTL_MS = 300_000;

export interface StorageResolverDeps {
  /** Cliente postgres.js (o mesmo pool da app). */
  sql: StorageSql;
  /**
   * Configuração do bucket DA PLATAFORMA, vinda do `.env`. É o destino de toda
   * empresa sem linha em `tenant_storage_configs` — ou seja, hoje, de todas.
   */
  platformS3Config: S3Config;
  /**
   * Chave mestra de 32 bytes (`STORAGE_SECRET_KEY` já passada por
   * `parseSecretKey`) que decifra `encrypted_secret`.
   */
  secretKey: Buffer;
  /** Validade de uma instância de driver em cache. Default 5 min. */
  driverTtlMs?: number;
  /** Relógio injetável — o teste avança o tempo sem esperar. */
  now?: () => number;
  /** Fábricas injetáveis: o teste troca por um driver falso, sem rede. */
  createS3Driver?: (config: S3Config) => StorageDriver;
  createSharePointDriver?: (config: SharePointConfig) => StorageDriver;
}

// ---------------------------------------------------------------------------
// Construção do driver
// ---------------------------------------------------------------------------

/**
 * Constrói o driver de um destino já resolvido. Sem banco, sem cache — é a
 * peça que a T-140 usa no "Testar conexão" com a config ainda não gravada.
 */
export function buildStorageDriver(
  target: ResolvedStorageTarget,
  deps: Pick<StorageResolverDeps, 'platformS3Config' | 'createS3Driver' | 'createSharePointDriver'>
): StorageDriver {
  const makeS3 = deps.createS3Driver ?? defaultCreateS3Driver;
  const makeSharePoint = deps.createSharePointDriver ?? ((config: SharePointConfig) => defaultCreateSharePointDriver(config));

  if (target.provider === 'sharepoint') {
    return makeSharePoint(target.config);
  }
  return makeS3(
    target.credentialsSource === 'platform' ? deps.platformS3Config : target.config
  );
}

// ---------------------------------------------------------------------------
// Resolução sem cache
// ---------------------------------------------------------------------------

/**
 * Lê o destino ATIVO da empresa e constrói o driver, sem passar pelo cache.
 *
 * Serve a quem resolve uma vez só (purga de empresa, um script pontual). Em
 * caminho de request use `createStorageResolver`.
 *
 * ⚠️ É o destino de ESCRITA. Para ler o arquivo de um documento já gravado use
 * `resolveStorageDriverForConfig` com o `storage_config_id` dele.
 */
export async function resolveStorageDriver(
  deps: StorageResolverDeps,
  tenantId: string
): Promise<StorageDriver> {
  const { target } = await loadActiveStorageTarget(deps, tenantId);
  return buildStorageDriver(target, deps);
}

/**
 * Constrói o driver da configuração de UM documento, sem passar pelo cache.
 *
 * `storageConfigId` nulo é o S3 da plataforma; qualquer outro valor é lido de
 * `tenant_storage_configs`, ativo ou aposentado. É o que o worker usa: um job
 * dura de segundos a minutos e reler uma linha por job é ruído perto de
 * extrair, embeddar e classificar um documento.
 */
export async function resolveStorageDriverForConfig(
  deps: StorageResolverDeps,
  tenantId: string,
  storageConfigId: string | null
): Promise<StorageDriver> {
  const { target } = await loadStorageTargetById(deps, tenantId, storageConfigId);
  return buildStorageDriver(target, deps);
}

/**
 * Lê a linha ATIVA da empresa e devolve o destino já validado, o id da
 * configuração (nulo quando é a plataforma) e o hash do conteúdo que o cache
 * usa como salvaguarda.
 *
 * `AND active` é obrigatório: a tabela é versionada (ADR-1), e sem o filtro a
 * consulta escolheria qualquer linha do histórico — inclusive um destino que a
 * empresa já abandonou.
 */
async function loadActiveStorageTarget(
  deps: StorageResolverDeps,
  tenantId: string
): Promise<{ target: ResolvedStorageTarget; configHash: string; storageConfigId: string | null }> {
  const rows = await deps.sql<IdentifiedStorageConfigRow[]>`
    SELECT id, provider, credentials_source, config, encrypted_secret
    FROM tenant_storage_configs
    WHERE tenant_id = ${tenantId}
      AND active
    LIMIT 1
  `;

  const row = rows[0];
  if (row === undefined) {
    // Ausência de linha ativa NÃO é erro: é o default da plataforma. Diferente
    // de `resolveAiFeatureFlags`, que lança quando o tenant não existe — aqui a
    // existência do tenant já foi conferida pela rota que chegou até aqui.
    return { target: PLATFORM_TARGET, configHash: PLATFORM_HASH, storageConfigId: null };
  }

  return {
    target: parseStorageTarget(row, deps.secretKey, tenantId),
    configHash: hashRow(row),
    storageConfigId: row.id,
  };
}

/**
 * Lê a configuração de um DOCUMENTO — ativa ou aposentada — e devolve o destino
 * validado.
 *
 * Duas decisões que não são detalhe:
 *
 * 1. **`tenant_id` no `WHERE`, junto com o `id`.** Não é redundância com a FK
 *    composta `documents_storage_config_fk`: é a mesma defesa repetida na
 *    aplicação. Resolver a configuração de outra empresa significaria abrir o
 *    bucket dela COM AS CREDENCIAIS DELA — o pior vazamento possível neste
 *    sistema, e o tipo de coisa que não pode depender de uma única camada.
 *
 * 2. **Id não-nulo sem linha é ERRO, nunca fallback de plataforma.** Cair no
 *    bucket da plataforma transformaria "a configuração deste documento sumiu"
 *    em "arquivo não encontrado" — o operador procuraria o objeto no lugar
 *    errado. Só `NULL` é plataforma.
 */
async function loadStorageTargetById(
  deps: StorageResolverDeps,
  tenantId: string,
  storageConfigId: string | null
): Promise<{ target: ResolvedStorageTarget; configHash: string }> {
  if (storageConfigId === null) {
    return { target: PLATFORM_TARGET, configHash: PLATFORM_HASH };
  }

  const rows = await deps.sql<TenantStorageConfigRow[]>`
    SELECT provider, credentials_source, config, encrypted_secret
    FROM tenant_storage_configs
    WHERE id = ${storageConfigId}
      AND tenant_id = ${tenantId}
    LIMIT 1
  `;

  const row = rows[0];
  if (row === undefined) {
    throw new StorageTargetError(
      `configuração de armazenamento ${storageConfigId} não existe nesta empresa — ` +
        'o documento aponta para uma configuração inexistente ou de outra empresa',
      tenantId
    );
  }

  return { target: parseStorageTarget(row, deps.secretKey, tenantId), configHash: hashRow(row) };
}

/** Destino da plataforma — o `.env`, sem linha nenhuma no banco. */
const PLATFORM_TARGET: ResolvedStorageTarget = { provider: 's3', credentialsSource: 'platform' };

/** Hash fixo do destino "plataforma" — não há linha para hashear. */
const PLATFORM_HASH = 'platform';

/**
 * Impressão digital do conteúdo da linha.
 *
 * Com o cache chaveado por `storage_config_id` (ADR-1), o hash deixou de ser
 * necessário para a CORREÇÃO: linhas são imutáveis nos campos de configuração e
 * trocar de destino cria um id novo, que já é um miss automático. Ele fica como
 * SALVAGUARDA barata (um sha256 por resolução, sobre uma linha que já veio do
 * banco) contra o único jeito de a imutabilidade ser violada — um `UPDATE`
 * manual em psql, um seed ou um writer futuro desatento. Sem ele, esse caso
 * serviria uma credencial revogada por até um TTL inteiro.
 *
 * `encrypted_secret` entra inteiro: o IV é aleatório a cada `encryptSecret`,
 * então regravar o MESMO segredo também muda o hash. Reconstruir um driver à
 * toa é barato; continuar com uma credencial velha não é.
 */
function hashRow(row: TenantStorageConfigRow): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.provider,
        row.credentials_source,
        stableStringify(row.config),
        row.encrypted_secret,
      ])
    )
    .digest('hex');
}

/**
 * Serializa com as chaves em ordem: `{a:1,b:2}` e `{b:2,a:1}` são a MESMA
 * configuração e não podem gerar hashes diferentes (o postgres.js não promete
 * ordem de chaves de jsonb entre leituras).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

// ---------------------------------------------------------------------------
// Validação da linha
// ---------------------------------------------------------------------------

/**
 * Traduz a linha do banco no destino tipado, decifrando o segredo.
 *
 * Toda falha aqui vira `StorageTargetError`: para quem chama, o que importa é
 * "a configuração de armazenamento desta empresa está quebrada, alguém precisa
 * arrumar o cadastro" — nunca um `TypeError` vazando como 500 opaco.
 */
export function parseStorageTarget(
  row: TenantStorageConfigRow,
  secretKey: Buffer,
  tenantId: string
): ResolvedStorageTarget {
  const source = row.credentials_source;
  if (source !== 'platform' && source !== 'tenant') {
    throw new StorageTargetError(
      `credentials_source inválido em tenant_storage_configs: ${JSON.stringify(source)}`,
      tenantId
    );
  }

  if (row.provider === 's3' && source === 'platform') {
    return { provider: 's3', credentialsSource: 'platform' };
  }

  if (source === 'platform') {
    // O CHECK `storage_platform_creds_only_s3` já barra isto no banco; a
    // checagem aqui cobre quem construir a linha por outro caminho (a T-140
    // testa uma config informada no corpo da requisição, que não passa por
    // constraint nenhuma).
    throw new StorageTargetError(
      `não existe ${row.provider} da plataforma — credenciais de plataforma só valem para s3`,
      tenantId
    );
  }

  const config = assertPlainObject(row.config, tenantId);
  const secret = decryptRowSecret(row.encrypted_secret, secretKey, tenantId);

  if (row.provider === 's3') {
    return { provider: 's3', credentialsSource: 'tenant', config: parseS3Config(config, secret, tenantId) };
  }
  if (row.provider === 'sharepoint') {
    return {
      provider: 'sharepoint',
      credentialsSource: 'tenant',
      config: parseSharePointConfig(config, secret, tenantId),
    };
  }

  throw new StorageTargetError(
    `provider desconhecido em tenant_storage_configs: ${JSON.stringify(row.provider)}`,
    tenantId
  );
}

function decryptRowSecret(
  encryptedSecret: string | null,
  secretKey: Buffer,
  tenantId: string
): string {
  if (encryptedSecret === null || encryptedSecret.length === 0) {
    throw new StorageTargetError(
      'credentials_source = tenant exige encrypted_secret, e a coluna está vazia',
      tenantId
    );
  }
  try {
    return decryptSecret(encryptedSecret, secretKey);
  } catch (error) {
    // A causa concreta (chave trocada, conteúdo adulterado) já está na
    // mensagem do StorageCryptoError; o que falta é dizer DE QUEM é o segredo.
    throw new StorageTargetError(
      `não foi possível decifrar o segredo de armazenamento: ${
        error instanceof StorageCryptoError ? error.message : String(error)
      }`,
      tenantId,
      error
    );
  }
}

/**
 * O jsonb precisa chegar como objeto. Se chegar como STRING, a linha foi
 * gravada com `JSON.stringify` em vez de `sql.json(...)` e o postgres.js
 * re-serializou — o clássico double-encoding. Falhar com o diagnóstico na cara
 * poupa a próxima meia hora de depuração.
 */
function assertPlainObject(value: unknown, tenantId: string): Record<string, unknown> {
  if (typeof value === 'string') {
    throw new StorageTargetError(
      'tenant_storage_configs.config veio como string: a linha foi gravada com JSON.stringify em vez de sql.json(...) e está double-encoded',
      tenantId
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StorageTargetError(
      'tenant_storage_configs.config não é um objeto JSON',
      tenantId
    );
  }
  return value as Record<string, unknown>;
}

function parseS3Config(
  config: Record<string, unknown>,
  secretAccessKey: string,
  tenantId: string
): S3Config {
  return {
    region: requiredString(config, 'region', tenantId),
    bucket: requiredString(config, 'bucket', tenantId),
    accessKeyId: requiredString(config, 'accessKeyId', tenantId),
    secretAccessKey,
    ...optionalString(config, 'endpoint', tenantId, 'endpoint'),
    ...optionalString(config, 'publicEndpoint', tenantId, 'publicEndpoint'),
    forcePathStyle: optionalBoolean(config, 'forcePathStyle', tenantId) ?? false,
  };
}

function parseSharePointConfig(
  config: Record<string, unknown>,
  clientSecret: string,
  tenantId: string
): SharePointConfig {
  return {
    azureTenantId: requiredString(config, 'azureTenantId', tenantId),
    clientId: requiredString(config, 'clientId', tenantId),
    clientSecret,
    siteId: requiredString(config, 'siteId', tenantId),
    driveId: requiredString(config, 'driveId', tenantId),
    // `SharePointConfig` aceita `undefined` explícito nos opcionais, então
    // campo ausente pode ser repassado direto — sem spread condicional.
    rootFolder: optionalStringValue(config, 'rootFolder', tenantId),
    graphBaseUrl: optionalStringValue(config, 'graphBaseUrl', tenantId),
    loginBaseUrl: optionalStringValue(config, 'loginBaseUrl', tenantId),
  };
}

function requiredString(
  config: Record<string, unknown>,
  field: string,
  tenantId: string
): string {
  const value = config[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new StorageTargetError(
      `campo obrigatório ausente ou vazio na configuração de armazenamento: ${field}`,
      tenantId
    );
  }
  return value;
}

/** Devolve `{ campo: valor }` ou `{}` — para spread em objeto com `exactOptionalPropertyTypes`. */
function optionalString(
  config: Record<string, unknown>,
  field: string,
  tenantId: string,
  key: string
): Record<string, string> {
  const value = optionalStringValue(config, field, tenantId);
  return value === undefined ? {} : { [key]: value };
}

function optionalStringValue(
  config: Record<string, unknown>,
  field: string,
  tenantId: string
): string | undefined {
  const value = config[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new StorageTargetError(
      `campo ${field} da configuração de armazenamento deveria ser texto`,
      tenantId
    );
  }
  return value;
}

function optionalBoolean(
  config: Record<string, unknown>,
  field: string,
  tenantId: string
): boolean | undefined {
  const value = config[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new StorageTargetError(
      `campo ${field} da configuração de armazenamento deveria ser booleano`,
      tenantId
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Resolvedor com cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  driver: StorageDriver;
  configHash: string;
  cachedAt: number;
}

/**
 * Destino resolvido de uma empresa, com o id da configuração que o produziu.
 *
 * O id é o que o upload grava em `documents.storage_config_id` — sem ele, o
 * documento nasceria sem dizer de onde deve ser lido, que é exatamente o defeito
 * que a ADR-1 corrigiu. `null` significa S3 da plataforma.
 */
export interface StorageDestination {
  driver: StorageDriver;
  storageConfigId: string | null;
}

/**
 * Resolvedor de driver com cache de instância.
 *
 * É isto que a API decora como `app.storage`.
 */
export interface StorageResolver {
  /**
   * Driver do destino ATIVO da empresa — para onde vai um arquivo NOVO.
   *
   * ⚠️ Nunca use isto para ler, baixar ou apagar o arquivo de um documento já
   * gravado: depois de uma troca de destino, o acervo antigo continua na
   * configuração aposentada. Leitura é `forStorageConfig`.
   */
  forTenant(tenantId: string): Promise<StorageDriver>;
  /**
   * O mesmo destino ativo, acompanhado do id da configuração usada — o que o
   * upload precisa para gravar `documents.storage_config_id`.
   */
  activeDestination(tenantId: string): Promise<StorageDestination>;
  /**
   * Driver da configuração de UM documento, ativa ou aposentada.
   * `storageConfigId` nulo é o S3 da plataforma.
   */
  forStorageConfig(tenantId: string, storageConfigId: string | null): Promise<StorageDriver>;
  /**
   * Descarta instâncias em cache. Sem `storageConfigId`, descarta TODAS as
   * configurações daquela empresa.
   *
   * A correção NÃO depende disto: como cada resolução relê a linha e compara o
   * hash, uma configuração gravada agora já vale na chamada seguinte — inclusive
   * em outra réplica da API, que jamais receberia esta invalidação em memória.
   * O uso legítimo é forçar credencial nova sem esperar o TTL (rotação feita no
   * provedor, ou a configuração aposentada logo após um `PUT` — T-140).
   */
  invalidate(tenantId: string, storageConfigId?: string | null): void;
  /** Descarta todas as instâncias. Usado no shutdown e em teste. */
  invalidateAll(): void;
}

/**
 * Chave do cache: empresa + configuração.
 *
 * O `storage_config_id` sozinho bastaria (é uuid global), mas prefixar com o
 * tenant mantém a defesa em profundidade também na memória: uma entrada de uma
 * empresa não pode, nem por engano de chamada, ser servida a outra.
 */
function cacheKey(tenantId: string, storageConfigId: string | null): string {
  return `${tenantId}:${storageConfigId ?? 'platform'}`;
}

export function createStorageResolver(deps: StorageResolverDeps): StorageResolver {
  const cache = new Map<string, CacheEntry>();
  /**
   * Resoluções em voo. Sem isto, dez uploads simultâneos da mesma empresa
   * constroem dez `SharePointDriver` e pedem dez tokens ao Entra ID — a
   * deduplicação de token do driver só vale DENTRO de uma instância.
   *
   * A resolução do destino ATIVO tem chave própria (`active:{tenant}`) porque só
   * se descobre qual configuração é a ativa depois da consulta.
   */
  const inFlight = new Map<string, Promise<StorageDestination>>();

  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.driverTtlMs ?? DEFAULT_DRIVER_TTL_MS;

  function reuseOrBuild(
    key: string,
    target: ResolvedStorageTarget,
    configHash: string
  ): StorageDriver {
    const cached = cache.get(key);
    if (
      cached !== undefined &&
      cached.configHash === configHash &&
      now() - cached.cachedAt < ttlMs
    ) {
      return cached.driver;
    }

    const driver = buildStorageDriver(target, deps);
    // Uma resolução que começou ANTES de uma invalidação pode gravar aqui uma
    // entrada já velha. Não é problema: a próxima chamada relê a linha, acha um
    // hash diferente e reconstrói — o cache se conserta sozinho.
    cache.set(key, { driver, configHash, cachedAt: now() });
    return driver;
  }

  async function loadActive(tenantId: string): Promise<StorageDestination> {
    const { target, configHash, storageConfigId } = await loadActiveStorageTarget(deps, tenantId);
    return {
      driver: reuseOrBuild(cacheKey(tenantId, storageConfigId), target, configHash),
      storageConfigId,
    };
  }

  async function loadByConfig(
    tenantId: string,
    storageConfigId: string | null
  ): Promise<StorageDestination> {
    // A consulta acontece SEMPRE, antes de qualquer olhada no cache: é ela que
    // amarra o `storage_config_id` ao tenant. Um id de outra empresa falha aqui
    // mesmo que aquela configuração já esteja em cache pela dona legítima.
    const { target, configHash } = await loadStorageTargetById(deps, tenantId, storageConfigId);
    return {
      driver: reuseOrBuild(cacheKey(tenantId, storageConfigId), target, configHash),
      storageConfigId,
    };
  }

  function dedup(
    key: string,
    loader: () => Promise<StorageDestination>
  ): Promise<StorageDestination> {
    const pending = inFlight.get(key);
    if (pending !== undefined) return pending;

    const promise = loader().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  }

  return {
    forTenant(tenantId: string): Promise<StorageDriver> {
      return dedup(`active:${tenantId}`, () => loadActive(tenantId)).then((d) => d.driver);
    },

    activeDestination(tenantId: string): Promise<StorageDestination> {
      return dedup(`active:${tenantId}`, () => loadActive(tenantId));
    },

    forStorageConfig(tenantId: string, storageConfigId: string | null): Promise<StorageDriver> {
      return dedup(cacheKey(tenantId, storageConfigId), () =>
        loadByConfig(tenantId, storageConfigId)
      ).then((d) => d.driver);
    },

    invalidate(tenantId: string, storageConfigId?: string | null): void {
      if (storageConfigId === undefined) {
        const prefix = `${tenantId}:`;
        for (const key of cache.keys()) {
          if (key.startsWith(prefix)) cache.delete(key);
        }
        return;
      }
      cache.delete(cacheKey(tenantId, storageConfigId));
    },

    invalidateAll(): void {
      cache.clear();
    },
  };
}
