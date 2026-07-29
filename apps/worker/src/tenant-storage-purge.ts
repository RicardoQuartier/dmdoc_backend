import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import { storageLocationKey, type S3Config } from '@dmdoc/storage';
import type { StorageForTenant } from './storage.js';

/**
 * Varredura de storage da purga de empresa (épico E-11 / T-142).
 *
 * É a implementação do callback `deleteStoragePrefix` que `purgeTenantData`
 * (`@dmdoc/db-pg`) chama ANTES de tocar no banco. Aquele pacote não conhece
 * storage: ele entrega `{ tenantId, prefix }` e é aqui que se responde "quais
 * lugares físicos precisam ser varridos".
 *
 * ## Por que não basta o destino ATIVO
 *
 * Desde o storage por empresa, uma empresa pode ter arquivos em mais de um lugar
 * ao mesmo tempo:
 *
 * - migração parcial, cancelada ou com falhas — parte no bucket antigo, parte no
 *   novo;
 * - migração concluída SEM `cleanup-source` — o acervo íntegro nos dois, por
 *   decisão de projeto (a origem é cópia de segurança até o cliente validar);
 * - acervo anterior ao épico, ainda no bucket da plataforma
 *   (`documents.storage_config_id IS NULL`), enquanto o resto já está no destino
 *   próprio.
 *
 * Varrer só o destino corrente deixaria arquivo de cliente para trás,
 * indefinidamente e sem nenhuma linha no banco apontando para ele — na única
 * operação do sistema que promete purga física.
 *
 * ## A fonte dos destinos (ADR-1 do épico)
 *
 * TODAS as linhas de `tenant_storage_configs` do tenant (ativas E aposentadas),
 * mais o destino da plataforma quando existir documento com
 * `storage_config_id IS NULL`. Duas coisas que NÃO são fonte:
 *
 * - **`documents.storage_provider`** — é o TIPO do destino, não o destino. Uma
 *   empresa que saiu do bucket da plataforma para um bucket próprio tem `'s3'`
 *   dos dois lados: um `SELECT DISTINCT storage_provider` enxergaria UM destino
 *   e metade do acervo do cliente ficaria para trás.
 * - **`storage_migrations`** — nunca foi a fonte certa; era remendo para o caso
 *   "a origem sumiu de `documents` porque tudo já comutou". Com as configurações
 *   aposentadas persistidas, a origem continua listada em
 *   `tenant_storage_configs` mesmo depois da comutação.
 *
 * ## Quando isto pode rodar
 *
 * Só enquanto `documents` e `tenant_storage_configs` ainda estão de pé — o
 * inventário e as credenciais moram nas duas. É exatamente por isso que a T-142
 * inverteu a ordem de `purgeTenantData` (storage → banco): depois da transação,
 * o `EXISTS` da plataforma responderia `false` e não haveria segredo para
 * decifrar. Ver o cabeçalho de `packages/db-pg/src/tenant-deletion.ts`.
 */

export interface TenantStoragePurgeDeps {
  /** Pool normal — não há transação aberta quando o callback roda. */
  sql: Sql;
  storage: StorageForTenant;
  logger: Logger;
  /**
   * Bucket DA PLATAFORMA. Entra só para calcular a identidade física do destino
   * de plataforma, que não tem linha em `tenant_storage_configs` para descrevê-lo.
   */
  platformS3Config: S3Config;
}

/**
 * Um lugar a varrer.
 *
 * `storageConfigId` nulo é o S3 da plataforma — o mesmo valor que
 * `forStorageConfig` espera, e o mesmo que `documents.storage_config_id` guarda
 * para o acervo que nunca saiu do bucket da plataforma.
 */
export interface StoragePurgeTarget {
  storageConfigId: string | null;
  provider: string;
  /** Identidade física (endpoint+bucket, ou site+drive+pasta), sem credenciais. */
  locationKey: string;
}

export interface TenantStoragePurgeResult {
  /** Destinos varridos, já deduplicados por lugar físico. */
  targets: StoragePurgeTarget[];
  /** Quantos `deletePrefix` concluíram. */
  purged: number;
  /** Destinos em que a varredura falhou — logados um a um, nenhum aborta os demais. */
  failed: StoragePurgeTarget[];
  /** Configurações descartadas por apontarem para um lugar já na lista. */
  deduplicated: number;
}

/** Linha crua de `tenant_storage_configs` — só o que a identidade precisa. */
interface StorageConfigRow {
  id: string;
  provider: string;
  credentials_source: string;
  config: unknown;
}

/**
 * Levanta os destinos a varrer, já deduplicados por LUGAR FÍSICO.
 *
 * ## Por que deduplicar
 *
 * Rotação de credencial cria uma linha nova (as linhas são imutáveis) apontando
 * para o MESMO bucket. Uma empresa que trocou a access key duas vezes tem três
 * configurações e um único lugar: sem dedup, o mesmo prefixo seria listado e
 * apagado três vezes — três varreduras completas de um bucket que pode ter
 * dezenas de milhares de objetos.
 *
 * ⚠️ A comparação é `storageLocationKey`, NUNCA `sameStorageConfig`: esta última
 * compara o jsonb inteiro (inclusive `accessKeyId`) e diria "destinos
 * diferentes" justamente no caso da rotação, que é o caso a colapsar.
 *
 * A primeira configuração de cada lugar é a que fica. Qual delas fica não muda o
 * resultado da varredura (o lugar é o mesmo), só qual credencial é usada para
 * alcançá-lo — e a ordem `created_at` favorece a mais antiga, que é a que ainda
 * cobre o acervo mais antigo caso alguma tenha sido revogada.
 */
export async function listTenantStorageTargets(
  deps: Pick<TenantStoragePurgeDeps, 'sql' | 'platformS3Config'>,
  tenantId: string
): Promise<{ targets: StoragePurgeTarget[]; deduplicated: number }> {
  const rows = await deps.sql<StorageConfigRow[]>`
    SELECT id, provider, credentials_source, config
      FROM tenant_storage_configs
     WHERE tenant_id = ${tenantId}
     ORDER BY created_at ASC, id ASC
  `;

  const byLocation = new Map<string, StoragePurgeTarget>();
  let deduplicated = 0;

  for (const row of rows) {
    const locationKey = storageLocationKey(
      row.provider,
      row.credentials_source,
      row.config,
      deps.platformS3Config
    );
    if (byLocation.has(locationKey)) {
      deduplicated += 1;
      continue;
    }
    byLocation.set(locationKey, {
      storageConfigId: row.id,
      provider: row.provider,
      locationKey,
    });
  }

  // O destino da plataforma não tem linha em `tenant_storage_configs`: ele só se
  // revela por um documento que aponta para lugar nenhum.
  //
  // ⚠️ SEM filtro de `deleted`. A purga é FÍSICA e o soft delete não vale aqui:
  // um documento soft-deletado continua com o binário no bucket (a exclusão
  // lógica não apaga arquivo), e filtrá-lo esconderia o destino inteiro quando
  // ele for o único documento de lá.
  const platformDocs = await deps.sql<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM documents
       WHERE tenant_id = ${tenantId}
         AND storage_config_id IS NULL
    ) AS exists
  `;

  if (platformDocs[0]?.exists === true) {
    // Uma linha `('s3','platform')` da empresa já produz esta mesma chave — daí
    // o dedup valer também aqui, e não só entre linhas.
    const locationKey = storageLocationKey('s3', 'platform', {}, deps.platformS3Config);
    if (byLocation.has(locationKey)) {
      deduplicated += 1;
    } else {
      byLocation.set(locationKey, { storageConfigId: null, provider: 's3', locationKey });
    }
  }

  return { targets: [...byLocation.values()], deduplicated };
}

/**
 * Apaga `prefix` em todos os destinos que a empresa já usou.
 *
 * ## Tolerância POR DESTINO
 *
 * Cada destino é resolvido e varrido dentro do seu próprio `try`. Uma credencial
 * de SharePoint revogada, um bucket que não existe mais ou um segredo que não
 * decifra fazem falhar UM destino e apenas ele — os demais continuam. O contrário
 * (deixar a primeira falha subir) blindaria o MinIO por causa do Azure, e é
 * justamente o acervo alcançável que se consegue apagar.
 *
 * Falhas são logadas uma a uma, com `storageConfigId` e `locationKey`, e
 * resumidas no fim: é a lista que um operador usa para reconciliar à mão o que
 * ficou para trás. A função NÃO relança — `purgeTenantData` prossegue para o
 * banco de qualquer forma (a exclusão foi pedida e o conteúdo lógico tem de
 * sair), e um retry do BullMQ já não teria as credenciais para tentar de novo.
 *
 * Destino sem nenhum arquivo é no-op silencioso: `deletePrefix` sobre prefixo
 * inexistente não é erro em nenhum dos dois drivers.
 */
export async function purgeTenantStorage(
  deps: TenantStoragePurgeDeps,
  tenantId: string,
  prefix: string
): Promise<TenantStoragePurgeResult> {
  const log = deps.logger.child({ tenantId });
  const { targets, deduplicated } = await listTenantStorageTargets(deps, tenantId);

  log.info(
    {
      prefix,
      targetCount: targets.length,
      deduplicated,
      targets: targets.map((t) => ({
        storageConfigId: t.storageConfigId,
        provider: t.provider,
        locationKey: t.locationKey,
      })),
    },
    'purga de storage: destinos levantados para a empresa'
  );

  const failed: StoragePurgeTarget[] = [];
  let purged = 0;

  // Sequencial de propósito: são poucos destinos (raramente mais de três) e cada
  // `deletePrefix` já pagina milhares de objetos por dentro. Paralelizar aqui só
  // somaria pressão de rate limit sobre provedores diferentes ao mesmo tempo.
  for (const target of targets) {
    const targetLog = log.child({
      storageConfigId: target.storageConfigId,
      storageProvider: target.provider,
      locationKey: target.locationKey,
    });
    try {
      // `forStorageConfig`, não `forTenant`: o destino aposentado precisa ser
      // resolvido pela configuração DELE. `forTenant` devolveria sempre o
      // destino ativo e a varredura repetiria o mesmo lugar N vezes, deixando
      // todos os outros intactos.
      const driver = await deps.storage.forStorageConfig(tenantId, target.storageConfigId);
      await driver.deletePrefix(prefix);
      purged += 1;
      targetLog.info({ prefix }, 'purga de storage: destino varrido');
    } catch (err) {
      failed.push(target);
      targetLog.error(
        { err, prefix },
        'purga de storage: falha ao varrer um destino — os demais continuam'
      );
    }
  }

  if (failed.length > 0) {
    // Uma linha resumida e greppável: depois desta chamada as credenciais destes
    // destinos serão apagadas junto com a empresa, e ninguém mais consegue
    // alcançá-los pelo sistema.
    log.error(
      {
        prefix,
        failedCount: failed.length,
        targetCount: targets.length,
        failedTargets: failed.map((t) => ({
          storageConfigId: t.storageConfigId,
          locationKey: t.locationKey,
        })),
      },
      'purga de storage: arquivos permaneceram em pelo menos um destino — reconciliação manual'
    );
  } else {
    log.info({ prefix, targetCount: targets.length }, 'purga de storage: todos os destinos varridos');
  }

  return { targets, purged, failed, deduplicated };
}
