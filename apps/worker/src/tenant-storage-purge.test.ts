import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import postgres, { type Sql } from 'postgres';
import { purgeTenantData } from '@dmdoc/db-pg';
import type { S3Config, StorageDriver } from '@dmdoc/storage';
import type { StorageForTenant } from './storage.js';
import { listTenantStorageTargets, purgeTenantStorage } from './tenant-storage-purge.js';

/**
 * Varredura de storage da purga de empresa (épico E-11 / T-142).
 *
 * ## Por que estes testes usam PostgreSQL de verdade
 *
 * O que decide a correção aqui é o INVENTÁRIO: quais linhas de
 * `tenant_storage_configs` entram (todas, ativas e aposentadas) e quando o
 * destino da plataforma entra (`EXISTS` de documento com `storage_config_id IS
 * NULL`, sem filtro de `deleted`). Um dublê de `Sql` devolveria a lista que o
 * teste mandasse e provaria só que o `for` itera. Em particular, o modo de falha
 * que a ADR-1 corrigiu — dois destinos com o MESMO `provider` colapsando em um —
 * só é observável sobre linhas de verdade.
 *
 * O storage, esse sim, é falso: um mapa por destino, que permite afirmar de qual
 * bucket cada arquivo sumiu — inclusive no caso s3 → s3, em que
 * `storage_provider` é idêntico dos dois lados e não distingue nada.
 */

// ---------------------------------------------------------------------------
// Mundo falso de armazenamento
// ---------------------------------------------------------------------------

/** destino (bucket/drive) → chave → conteúdo. */
const buckets = new Map<string, Map<string, Buffer>>();
/** `storage_config_id` (ou `'platform'`) → nome do destino. */
const destinationOf = new Map<string, string>();
/** Destinos cujo `deletePrefix` deve falhar (credencial revogada, bucket sumido). */
const failOnDeletePrefix = new Set<string>();
/** Configurações que nem resolvem driver (segredo que não decifra). */
const failOnResolve = new Set<string>();

/** `destino:prefixo` de cada `deletePrefix` executado, na ordem. */
const deletePrefixCalls: string[] = [];
/** Quantas vezes `forTenant` foi chamado — tem de ser ZERO (ver o teste). */
let forTenantCalls = 0;

function bucketOf(name: string): Map<string, Buffer> {
  let bucket = buckets.get(name);
  if (bucket === undefined) {
    bucket = new Map<string, Buffer>();
    buckets.set(name, bucket);
  }
  return bucket;
}

function fakeDriver(destination: string, provider: 's3' | 'sharepoint' = 's3'): StorageDriver {
  return {
    provider,
    put: async ({ key, buffer }) => {
      bucketOf(destination).set(key, buffer);
    },
    get: async (key) => {
      const found = buckets.get(destination)?.get(key);
      if (found === undefined) throw new Error(`objeto inexistente em ${destination}: ${key}`);
      return found;
    },
    getDownloadUrl: async (key) => `https://${destination}.fake/${key}`,
    delete: async (key) => {
      bucketOf(destination).delete(key);
    },
    deletePrefix: async (prefix) => {
      deletePrefixCalls.push(`${destination}:${prefix}`);
      if (failOnDeletePrefix.has(destination)) {
        throw new Error(`credencial recusada em ${destination}`);
      }
      for (const key of [...(buckets.get(destination)?.keys() ?? [])]) {
        if (key.startsWith(prefix)) bucketOf(destination).delete(key);
      }
    },
  };
}

/** `storage_config_id` (ou `'platform'`) → provider, só para o driver falso. */
const providerOf = new Map<string, 's3' | 'sharepoint'>();

/**
 * Resolvedor falso: mapeia `storage_config_id` → destino, como o
 * `forStorageConfig` de verdade faria depois de ler `tenant_storage_configs`.
 * `null` é o S3 da plataforma.
 */
const storage: StorageForTenant = {
  forTenant: async () => {
    forTenantCalls += 1;
    return fakeDriver(PLATFORM);
  },
  forStorageConfig: async (_tenantId: string, storageConfigId: string | null) => {
    if (storageConfigId !== null && failOnResolve.has(storageConfigId)) {
      throw new Error(`não foi possível decifrar o segredo de ${storageConfigId}`);
    }
    const destination = destinationOf.get(storageConfigId ?? 'platform');
    if (destination === undefined) {
      throw new Error(`configuração sem destino mapeado no teste: ${String(storageConfigId)}`);
    }
    return fakeDriver(destination, providerOf.get(storageConfigId ?? 'platform') ?? 's3');
  },
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PLATFORM = 'bucket-da-plataforma';
const TENANT_ID = crypto.randomUUID();
const OTHER_TENANT_ID = crypto.randomUUID();
const DEPARTMENT_ID = crypto.randomUUID();
const USER_ID = crypto.randomUUID();
const PREFIX = `tenants/${TENANT_ID}/`;

/** Bucket da plataforma como o `.env` o descreve — a identidade física dele. */
const platformS3Config: S3Config = {
  region: 'us-east-1',
  bucket: PLATFORM,
  accessKeyId: 'AKIAPLATAFORMA',
  secretAccessKey: 'segredo-da-plataforma',
  endpoint: 'http://minio:9000',
  forcePathStyle: true,
};

const logger = pino({ level: 'silent' });

let sql: Sql;

function deps(): {
  sql: Sql;
  storage: StorageForTenant;
  logger: typeof logger;
  platformS3Config: S3Config;
} {
  return { sql, storage, logger, platformS3Config };
}

/**
 * Linha de `tenant_storage_configs`.
 *
 * `endpoint` entra no jsonb porque é ele, com o bucket, que forma a identidade
 * FÍSICA do destino (`storageLocationKey`) — e o dedup depende dela.
 */
async function seedStorageConfig(params: {
  tenantId?: string;
  provider?: 's3' | 'sharepoint';
  /** S3: nome do bucket. SharePoint: usado como `driveId`. */
  bucket: string;
  /** Muda a credencial sem mudar o lugar — é o caso da rotação. */
  accessKeyId?: string;
  endpoint?: string;
  active: boolean;
  /** Destino no mundo falso. Default: o próprio `bucket`. */
  destination?: string;
}): Promise<string> {
  const provider = params.provider ?? 's3';
  const config =
    provider === 'sharepoint'
      ? {
          azureTenantId: 'azure-tenant',
          clientId: 'client-id',
          siteId: 'site-do-cliente',
          driveId: params.bucket,
        }
      : {
          bucket: params.bucket,
          region: 'us-east-1',
          accessKeyId: params.accessKeyId ?? 'AKIA',
          ...(params.endpoint !== undefined ? { endpoint: params.endpoint } : {}),
        };

  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO tenant_storage_configs (
      tenant_id, provider, credentials_source, config, encrypted_secret, active, retired_at
    ) VALUES (
      ${params.tenantId ?? TENANT_ID},
      ${provider},
      'tenant',
      ${sql.json(config)},
      'segredo-cifrado-de-mentira',
      ${params.active},
      ${params.active ? null : new Date()}
    )
    RETURNING id
  `;
  const id = rows[0]!.id;
  destinationOf.set(id, params.destination ?? params.bucket);
  providerOf.set(id, provider);
  return id;
}

/** Documento com o arquivo gravado no destino correspondente. */
async function seedDocument(params: {
  storageConfigId: string | null;
  provider?: 's3' | 'sharepoint';
  deleted?: boolean;
  tenantId?: string;
}): Promise<{ id: string; storageKey: string }> {
  const tenantId = params.tenantId ?? TENANT_ID;
  const content = Buffer.from(`conteudo ${crypto.randomUUID()}`);
  const contentHash = crypto.createHash('sha256').update(content).digest('hex');
  const storageKey = `tenants/${tenantId}/documents/${contentHash}/arquivo.pdf`;

  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO documents (
      tenant_id, department_id, filename, original_filename, content_hash, size_bytes,
      mime_type, storage_key, storage_provider, storage_config_id, status,
      uploaded_by_id, uploaded_at, deleted
    ) VALUES (
      ${tenantId}, ${DEPARTMENT_ID}, 'arquivo.pdf', 'arquivo.pdf', ${contentHash},
      ${content.length}, 'application/pdf', ${storageKey},
      ${params.provider ?? 's3'}, ${params.storageConfigId}, 'READY',
      ${USER_ID}, now(), ${params.deleted ?? false}
    )
    RETURNING id
  `;

  const destination = destinationOf.get(params.storageConfigId ?? 'platform');
  if (destination === undefined) throw new Error('destino do documento não mapeado no teste');
  bucketOf(destination).set(storageKey, content);

  return { id: rows[0]!.id, storageKey };
}

/** Chaves ainda presentes num destino do mundo falso. */
function keysIn(destination: string): string[] {
  return [...(buckets.get(destination)?.keys() ?? [])];
}

beforeAll(async () => {
  const url =
    process.env['TEST_DATABASE_URL'] ??
    process.env['DATABASE_URL'] ??
    'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test';
  sql = postgres(url, { max: 5, onnotice: () => undefined });
});

afterAll(async () => {
  await sql.end();
});

beforeEach(async () => {
  buckets.clear();
  destinationOf.clear();
  providerOf.clear();
  destinationOf.set('platform', PLATFORM);
  providerOf.set('platform', 's3');
  failOnDeletePrefix.clear();
  failOnResolve.clear();
  deletePrefixCalls.length = 0;
  forTenantCalls = 0;

  await sql.unsafe(`
    TRUNCATE TABLE chunks, document_content, document_events, audit_logs, documents,
      storage_migrations, tenant_storage_configs, department_permissions, departments,
      users, tenants
    RESTART IDENTITY CASCADE
  `);

  await sql`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
    VALUES
      (${TENANT_ID}, 'Empresa da Purga', ${10 * 1024 * 1024}, 20, true, now()),
      (${OTHER_TENANT_ID}, 'Outra Empresa', ${10 * 1024 * 1024}, 20, true, now())
  `;
  await sql`
    INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
    VALUES (${DEPARTMENT_ID}, ${TENANT_ID}, NULL, 'Financeiro', 0, '{}'::text[], false, now())
  `;
  await sql`
    INSERT INTO users (id, tenant_id, email, password_hash, name, role, active, created_at, deleted)
    VALUES (${USER_ID}, ${TENANT_ID}, 'purga@empresa.com', 'hash', 'Operador', 'TENANT_ADMIN', true, now(), false)
  `;
});

// ---------------------------------------------------------------------------
// O inventário de destinos
// ---------------------------------------------------------------------------

describe('listTenantStorageTargets — de onde saem os destinos', () => {
  it('varre os DOIS buckets quando a empresa trocou de S3 para outro S3', async () => {
    // O caso que a versão anterior da tarefa deixava passar: `provider` é 's3'
    // dos dois lados. `SELECT DISTINCT storage_provider` devolveria UMA linha e
    // metade do acervo do cliente ficaria no bucket antigo, para sempre.
    const antigo = await seedStorageConfig({ bucket: 'bucket-antigo', active: false });
    const novo = await seedStorageConfig({ bucket: 'bucket-novo', active: true });
    await seedDocument({ storageConfigId: antigo });
    await seedDocument({ storageConfigId: novo });

    const { targets } = await listTenantStorageTargets(deps(), TENANT_ID);

    expect(targets.map((t) => t.storageConfigId).sort()).toEqual([antigo, novo].sort());
    expect(new Set(targets.map((t) => t.locationKey)).size).toBe(2);
    expect(targets.every((t) => t.provider === 's3')).toBe(true);
  });

  it('inclui a configuração APOSENTADA mesmo sem nenhum documento apontando para ela', async () => {
    // Migração concluída sem `cleanup-source`: todo mundo já comutou para o
    // destino novo, mas o acervo íntegro continua no antigo, de propósito.
    // Nenhuma consulta a `documents` revelaria esse destino — só a linha
    // aposentada de `tenant_storage_configs` revela.
    const antigo = await seedStorageConfig({ bucket: 'origem-preservada', active: false });
    const novo = await seedStorageConfig({ bucket: 'destino-atual', active: true });
    await seedDocument({ storageConfigId: novo });

    const { targets } = await listTenantStorageTargets(deps(), TENANT_ID);

    expect(targets.map((t) => t.storageConfigId).sort()).toEqual([antigo, novo].sort());
  });

  it('inclui o destino de PLATAFORMA quando há documento com storage_config_id NULL', async () => {
    const proprio = await seedStorageConfig({ bucket: 'bucket-do-cliente', active: true });
    await seedDocument({ storageConfigId: proprio });
    await seedDocument({ storageConfigId: null });

    const { targets } = await listTenantStorageTargets(deps(), TENANT_ID);

    expect(targets.map((t) => t.storageConfigId).sort()).toEqual([null, proprio].sort());
    // A plataforma não tem linha em `tenant_storage_configs`: a identidade dela
    // sai do `.env` (endpoint + bucket), não do banco.
    const plataforma = targets.find((t) => t.storageConfigId === null);
    expect(plataforma?.locationKey).toBe('s3|http://minio:9000|bucket-da-plataforma');
  });

  it('NÃO inclui a plataforma quando nenhum documento aponta para ela', async () => {
    // Empresa que nasceu já com destino próprio, ou cujo acervo migrou inteiro e
    // já passou pelo `cleanup-source`. Varrer o bucket da plataforma aqui seria
    // um `deletePrefix` a mais num bucket COMPARTILHADO por todas as empresas —
    // no-op hoje, e uma bomba no dia em que o prefixo mudar.
    const proprio = await seedStorageConfig({ bucket: 'bucket-do-cliente', active: true });
    await seedDocument({ storageConfigId: proprio });

    const { targets } = await listTenantStorageTargets(deps(), TENANT_ID);

    expect(targets.map((t) => t.storageConfigId)).toEqual([proprio]);
  });

  it('não deixa o soft delete esconder o destino de plataforma', async () => {
    // A purga é FÍSICA: o binário continua no bucket mesmo com a linha
    // soft-deletada. Um `AND deleted = false` no `EXISTS` esconderia o destino
    // inteiro quando o único documento de lá estivesse excluído logicamente.
    const proprio = await seedStorageConfig({ bucket: 'bucket-do-cliente', active: true });
    await seedDocument({ storageConfigId: proprio });
    await seedDocument({ storageConfigId: null, deleted: true });

    const { targets } = await listTenantStorageTargets(deps(), TENANT_ID);

    expect(targets.map((t) => t.storageConfigId).sort()).toEqual([null, proprio].sort());
  });

  it('colapsa configurações que apontam para o MESMO lugar (rotação de credencial)', async () => {
    // Duas linhas, uma access key cada, o MESMO bucket. `sameStorageConfig`
    // diria "diferentes" (o jsonb inclui `accessKeyId`); `storageLocationKey`
    // diz "mesmo lugar" — e é essa a pergunta certa.
    const antiga = await seedStorageConfig({
      bucket: 'bucket-unico',
      accessKeyId: 'AKIA-VELHA',
      active: false,
    });
    await seedStorageConfig({
      bucket: 'bucket-unico',
      accessKeyId: 'AKIA-NOVA',
      active: true,
    });

    const { targets, deduplicated } = await listTenantStorageTargets(deps(), TENANT_ID);

    expect(targets).toHaveLength(1);
    expect(deduplicated).toBe(1);
    // Fica a mais antiga (ordem `created_at`) — qualquer uma varreria o mesmo
    // lugar, mas a ordem tem de ser determinística.
    expect(targets[0]?.storageConfigId).toBe(antiga);
  });

  it('distingue SharePoint por site + drive + pasta, e não o confunde com S3', async () => {
    const sp = await seedStorageConfig({
      provider: 'sharepoint',
      bucket: 'drive-do-cliente',
      active: true,
    });
    const s3 = await seedStorageConfig({ bucket: 'drive-do-cliente', active: false });

    const { targets, deduplicated } = await listTenantStorageTargets(deps(), TENANT_ID);

    // Mesmo nome dos dois lados; lugares completamente diferentes.
    expect(deduplicated).toBe(0);
    expect(targets.map((t) => t.storageConfigId).sort()).toEqual([sp, s3].sort());
    expect(targets.find((t) => t.storageConfigId === sp)?.locationKey).toBe(
      'sharepoint|site-do-cliente|drive-do-cliente|'
    );
  });

  it('não enxerga destino de OUTRA empresa', async () => {
    const meu = await seedStorageConfig({ bucket: 'meu-bucket', active: true });
    await seedStorageConfig({
      tenantId: OTHER_TENANT_ID,
      bucket: 'bucket-alheio',
      active: true,
    });
    await seedDocument({ storageConfigId: meu });

    const { targets } = await listTenantStorageTargets(deps(), TENANT_ID);

    expect(targets.map((t) => t.storageConfigId)).toEqual([meu]);
  });

  it('não deixa documento de OUTRA empresa na plataforma arrastar a plataforma para a varredura', async () => {
    const meu = await seedStorageConfig({ bucket: 'meu-bucket', active: true });
    await seedDocument({ storageConfigId: meu });
    // A outra empresa é que está na plataforma — o `EXISTS` tem de filtrar por
    // tenant, senão qualquer purga varreria o bucket compartilhado.
    const otherDept = crypto.randomUUID();
    const otherUser = crypto.randomUUID();
    await sql`
      INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
      VALUES (${otherDept}, ${OTHER_TENANT_ID}, NULL, 'Dept', 0, '{}'::text[], false, now())
    `;
    await sql`
      INSERT INTO users (id, tenant_id, email, password_hash, name, role, active, created_at, deleted)
      VALUES (${otherUser}, ${OTHER_TENANT_ID}, 'outro@empresa.com', 'hash', 'Outro', 'TENANT_ADMIN', true, now(), false)
    `;
    await sql`
      INSERT INTO documents (
        tenant_id, department_id, filename, original_filename, content_hash, size_bytes,
        mime_type, storage_key, storage_provider, storage_config_id, status,
        uploaded_by_id, uploaded_at, deleted
      ) VALUES (
        ${OTHER_TENANT_ID}, ${otherDept}, 'a.pdf', 'a.pdf', ${crypto.randomUUID()},
        10, 'application/pdf', ${`tenants/${OTHER_TENANT_ID}/a.pdf`}, 's3', NULL, 'READY',
        ${otherUser}, now(), false
      )
    `;

    const { targets } = await listTenantStorageTargets(deps(), TENANT_ID);

    expect(targets.map((t) => t.storageConfigId)).toEqual([meu]);
  });
});

// ---------------------------------------------------------------------------
// A varredura
// ---------------------------------------------------------------------------

describe('purgeTenantStorage — a varredura', () => {
  it('apaga os arquivos nos DOIS destinos, inclusive dois buckets S3 distintos', async () => {
    const antigo = await seedStorageConfig({ bucket: 'bucket-antigo', active: false });
    const novo = await seedStorageConfig({ bucket: 'bucket-novo', active: true });
    const docAntigo = await seedDocument({ storageConfigId: antigo });
    const docNovo = await seedDocument({ storageConfigId: novo });

    expect(keysIn('bucket-antigo')).toEqual([docAntigo.storageKey]);
    expect(keysIn('bucket-novo')).toEqual([docNovo.storageKey]);

    const result = await purgeTenantStorage(deps(), TENANT_ID, PREFIX);

    expect(result.purged).toBe(2);
    expect(result.failed).toEqual([]);
    expect(keysIn('bucket-antigo')).toEqual([]);
    expect(keysIn('bucket-novo')).toEqual([]);
  });

  it('varre a plataforma, o bucket próprio e o SharePoint numa mesma empresa', async () => {
    const s3 = await seedStorageConfig({ bucket: 'bucket-do-cliente', active: false });
    const sp = await seedStorageConfig({
      provider: 'sharepoint',
      bucket: 'drive-do-cliente',
      active: true,
    });
    const naPlataforma = await seedDocument({ storageConfigId: null });
    const noBucket = await seedDocument({ storageConfigId: s3 });
    const noDrive = await seedDocument({ storageConfigId: sp, provider: 'sharepoint' });

    const result = await purgeTenantStorage(deps(), TENANT_ID, PREFIX);

    expect(result.purged).toBe(3);
    expect(keysIn(PLATFORM)).toEqual([]);
    expect(keysIn('bucket-do-cliente')).toEqual([]);
    expect(keysIn('drive-do-cliente')).toEqual([]);
    // E os três arquivos existiam antes — o teste não passa por vacuidade.
    expect([naPlataforma, noBucket, noDrive].every((d) => d.storageKey.startsWith(PREFIX))).toBe(
      true
    );
  });

  it('resolve cada destino por forStorageConfig, nunca por forTenant', async () => {
    // `forTenant` devolve sempre o destino ATIVO: usá-lo na varredura repetiria
    // o mesmo lugar N vezes e deixaria todos os aposentados intactos — o defeito
    // exato que esta tarefa corrige.
    const antigo = await seedStorageConfig({ bucket: 'bucket-antigo', active: false });
    await seedStorageConfig({ bucket: 'bucket-novo', active: true });
    await seedDocument({ storageConfigId: antigo });

    await purgeTenantStorage(deps(), TENANT_ID, PREFIX);

    expect(forTenantCalls).toBe(0);
    expect(deletePrefixCalls.sort()).toEqual(
      [`bucket-antigo:${PREFIX}`, `bucket-novo:${PREFIX}`].sort()
    );
  });

  it('falha em UM destino não impede a limpeza dos demais', async () => {
    // Credencial de SharePoint revogada não pode blindar o MinIO.
    const s3 = await seedStorageConfig({ bucket: 'minio-do-cliente', active: false });
    const sp = await seedStorageConfig({
      provider: 'sharepoint',
      bucket: 'drive-indisponivel',
      active: true,
    });
    await seedDocument({ storageConfigId: s3 });
    await seedDocument({ storageConfigId: sp, provider: 'sharepoint' });
    failOnDeletePrefix.add('drive-indisponivel');

    const result = await purgeTenantStorage(deps(), TENANT_ID, PREFIX);

    expect(result.purged).toBe(1);
    expect(result.failed.map((t) => t.storageConfigId)).toEqual([sp]);
    // O que era alcançável foi apagado.
    expect(keysIn('minio-do-cliente')).toEqual([]);
    expect(keysIn('drive-indisponivel')).toHaveLength(1);
  });

  it('destino que nem resolve driver (segredo ilegível) também não aborta os demais', async () => {
    const quebrado = await seedStorageConfig({ bucket: 'bucket-quebrado', active: false });
    const bom = await seedStorageConfig({ bucket: 'bucket-bom', active: true });
    await seedDocument({ storageConfigId: quebrado });
    await seedDocument({ storageConfigId: bom });
    failOnResolve.add(quebrado);

    const result = await purgeTenantStorage(deps(), TENANT_ID, PREFIX);

    expect(result.failed.map((t) => t.storageConfigId)).toEqual([quebrado]);
    expect(keysIn('bucket-bom')).toEqual([]);
  });

  it('não relança: a purga do banco tem de prosseguir mesmo com todos os destinos fora', async () => {
    const s3 = await seedStorageConfig({ bucket: 'bucket-fora-do-ar', active: true });
    await seedDocument({ storageConfigId: s3 });
    failOnDeletePrefix.add('bucket-fora-do-ar');

    // A empresa já foi soft-deletada pela rota; travar aqui deixaria o conteúdo
    // lógico de pé por causa de um provedor indisponível.
    const result = await purgeTenantStorage(deps(), TENANT_ID, PREFIX);

    expect(result.purged).toBe(0);
    expect(result.failed).toHaveLength(1);
  });

  it('destino sem nenhum arquivo é no-op silencioso', async () => {
    const vazio = await seedStorageConfig({ bucket: 'bucket-vazio', active: true });
    expect(vazio).toBeDefined();

    const result = await purgeTenantStorage(deps(), TENANT_ID, PREFIX);

    expect(result.purged).toBe(1);
    expect(result.failed).toEqual([]);
  });

  it('empresa sem configuração nenhuma e sem documentos não varre nada', async () => {
    const result = await purgeTenantStorage(deps(), TENANT_ID, PREFIX);

    expect(result.targets).toEqual([]);
    expect(deletePrefixCalls).toEqual([]);
  });

  it('rotação de credencial varre o bucket UMA vez só', async () => {
    await seedStorageConfig({ bucket: 'bucket-unico', accessKeyId: 'AKIA-VELHA', active: false });
    const nova = await seedStorageConfig({
      bucket: 'bucket-unico',
      accessKeyId: 'AKIA-NOVA',
      active: true,
    });
    await seedDocument({ storageConfigId: nova });

    const result = await purgeTenantStorage(deps(), TENANT_ID, PREFIX);

    expect(deletePrefixCalls).toEqual([`bucket-unico:${PREFIX}`]);
    expect(result.deduplicated).toBe(1);
    expect(keysIn('bucket-unico')).toEqual([]);
  });

  it('não toca no destino de outra empresa', async () => {
    const meu = await seedStorageConfig({ bucket: 'meu-bucket', active: true });
    const alheio = await seedStorageConfig({
      tenantId: OTHER_TENANT_ID,
      bucket: 'bucket-alheio',
      active: true,
    });
    await seedDocument({ storageConfigId: meu });
    bucketOf('bucket-alheio').set(`tenants/${OTHER_TENANT_ID}/x.pdf`, Buffer.from('x'));
    expect(alheio).toBeDefined();

    await purgeTenantStorage(deps(), TENANT_ID, PREFIX);

    expect(keysIn('bucket-alheio')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Integração com `purgeTenantData` — a ordem storage → banco
// ---------------------------------------------------------------------------

describe('purgeTenantData + purgeTenantStorage', () => {
  it('apaga os arquivos de todos os destinos E purga o banco, nessa ordem', async () => {
    const antigo = await seedStorageConfig({ bucket: 'bucket-antigo', active: false });
    const novo = await seedStorageConfig({ bucket: 'bucket-novo', active: true });
    await seedDocument({ storageConfigId: antigo });
    await seedDocument({ storageConfigId: novo });
    await seedDocument({ storageConfigId: null });

    await purgeTenantData(sql, TENANT_ID, {
      deleteStoragePrefix: async ({ tenantId, prefix }) => {
        await purgeTenantStorage(deps(), tenantId, prefix);
      },
      logger,
    });

    // Os TRÊS destinos foram varridos — incluindo o da plataforma, que só era
    // descobrível enquanto `documents` ainda estava de pé.
    expect(deletePrefixCalls.sort()).toEqual(
      [`bucket-antigo:${PREFIX}`, `bucket-novo:${PREFIX}`, `${PLATFORM}:${PREFIX}`].sort()
    );
    expect(keysIn('bucket-antigo')).toEqual([]);
    expect(keysIn('bucket-novo')).toEqual([]);
    expect(keysIn(PLATFORM)).toEqual([]);

    // E o banco saiu junto: nenhum documento, nenhuma credencial de cliente.
    const docs = await sql<Array<{ c: number }>>`
      SELECT count(*)::int AS c FROM documents WHERE tenant_id = ${TENANT_ID}
    `;
    const configs = await sql<Array<{ c: number }>>`
      SELECT count(*)::int AS c FROM tenant_storage_configs WHERE tenant_id = ${TENANT_ID}
    `;
    expect(docs[0]?.c).toBe(0);
    expect(configs[0]?.c).toBe(0);
  });

  it('purga o banco mesmo quando o storage do cliente está inalcançável', async () => {
    const s3 = await seedStorageConfig({ bucket: 'bucket-fora-do-ar', active: true });
    await seedDocument({ storageConfigId: s3 });
    failOnDeletePrefix.add('bucket-fora-do-ar');

    await purgeTenantData(sql, TENANT_ID, {
      deleteStoragePrefix: async ({ tenantId, prefix }) => {
        await purgeTenantStorage(deps(), tenantId, prefix);
      },
      logger,
    });

    const docs = await sql<Array<{ c: number }>>`
      SELECT count(*)::int AS c FROM documents WHERE tenant_id = ${TENANT_ID}
    `;
    expect(docs[0]?.c).toBe(0);
    // O arquivo ficou lá, e é isso que o log de erro por destino registra para
    // reconciliação — depois desta purga ninguém mais tem a credencial.
    expect(keysIn('bucket-fora-do-ar')).toHaveLength(1);
  });
});
