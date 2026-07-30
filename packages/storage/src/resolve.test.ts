import { describe, expect, it, vi } from 'vitest';

import { encryptSecret } from './crypto.js';
import type { StorageDriver } from './driver.js';
import { StorageTargetError } from './errors.js';
import {
  createStorageResolver,
  resolveStorageDriver,
  resolveStorageDriverForConfig,
  type StorageResolverDeps,
} from './resolve.js';
import type { S3Config } from './s3-driver.js';

/**
 * Testes da resolução de destino de armazenamento.
 *
 * Nenhum driver de verdade é construído: as fábricas são injetadas e apenas
 * registram a configuração que receberam. O que está sob teste é a DECISÃO
 * (qual driver, com qual config) e o cache — não o comportamento dos drivers,
 * que têm suíte própria.
 *
 * Desde a ADR-1 do E-11, `tenant_storage_configs` é VERSIONADA: uma linha por
 * configuração, no máximo uma `active` por empresa, e as aposentadas continuam
 * servindo para LER o acervo que ficou nelas. Os testes abaixo separam as duas
 * perguntas: destino ATIVO (escrita) e destino DE UM DOCUMENTO (leitura).
 */

const SECRET_KEY = Buffer.alloc(32, 7);
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CONFIG_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const CONFIG_2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const CONFIG_3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';

const PLATFORM_CONFIG = {
  region: 'us-east-1',
  bucket: 'dmdoc-documents',
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin',
  endpoint: 'http://minio:9000',
  publicEndpoint: 'http://localhost:5054',
  forcePathStyle: true,
} satisfies S3Config;

/** Linha de `tenant_storage_configs` como o banco a guarda (versionada). */
interface StoredRow {
  id: string;
  tenant_id: string;
  provider: string;
  credentials_source: string;
  config: unknown;
  encrypted_secret: string | null;
  active: boolean;
}

/**
 * Banco falso: um `Map` de id → linha de `tenant_storage_configs`, exposto com
 * a mesma cara de uma tag de template do postgres.js.
 *
 * Distingue as duas consultas do módulo pelo texto do template — a da
 * configuração ATIVA (`AND active`, parâmetro: tenant) e a por ID (parâmetros:
 * id e tenant). O filtro de tenant da consulta por id é reproduzido fielmente:
 * é ele que sustenta o teste de isolamento.
 */
function fakeSql(rows: Map<string, StoredRow>): {
  sql: StorageResolverDeps['sql'];
  queries: () => number;
} {
  let count = 0;
  const sql = (<T extends readonly object[]>(
    template: TemplateStringsArray,
    ...parameters: readonly string[]
  ): Promise<T> => {
    count += 1;
    const query = template.join('?');

    if (query.includes('AND active')) {
      const tenantId = parameters[0];
      const found = [...rows.values()].find((r) => r.tenant_id === tenantId && r.active);
      return Promise.resolve(
        (found === undefined ? [] : [projectActive(found)]) as unknown as T
      );
    }

    const [storageConfigId, tenantId] = parameters;
    const found = rows.get(storageConfigId as string);
    return Promise.resolve(
      (found === undefined || found.tenant_id !== tenantId ? [] : [project(found)]) as unknown as T
    );
  }) as StorageResolverDeps['sql'];

  return { sql, queries: () => count };
}

/** Só as colunas do `SELECT` — nada de `id`, `tenant_id` ou `active` vazando. */
function project(row: StoredRow): Record<string, unknown> {
  return {
    provider: row.provider,
    credentials_source: row.credentials_source,
    config: row.config,
    encrypted_secret: row.encrypted_secret,
  };
}

function projectActive(row: StoredRow): Record<string, unknown> {
  return { id: row.id, ...project(row) };
}

/** Driver falso que carrega a config recebida, para as asserções. */
interface SpyDriver extends StorageDriver {
  readonly builtWith: unknown;
}

function spyDriver(provider: 's3' | 'sharepoint', builtWith: unknown): SpyDriver {
  return {
    provider,
    builtWith,
    put: vi.fn(),
    get: vi.fn(),
    getDownloadUrl: vi.fn(),
    delete: vi.fn(),
    deletePrefix: vi.fn(),
  } as unknown as SpyDriver;
}

interface Harness {
  deps: StorageResolverDeps;
  rows: Map<string, StoredRow>;
  s3Built: unknown[];
  sharePointBuilt: unknown[];
  queries: () => number;
  setNow: (ms: number) => void;
}

function harness(overrides: Partial<StorageResolverDeps> = {}): Harness {
  const rows = new Map<string, StoredRow>();
  const { sql, queries } = fakeSql(rows);
  const s3Built: unknown[] = [];
  const sharePointBuilt: unknown[] = [];
  let clock = 1_000;

  const deps: StorageResolverDeps = {
    sql,
    platformS3Config: PLATFORM_CONFIG,
    secretKey: SECRET_KEY,
    now: () => clock,
    createS3Driver: (config) => {
      s3Built.push(config);
      return spyDriver('s3', config);
    },
    createSharePointDriver: (config) => {
      sharePointBuilt.push(config);
      return spyDriver('sharepoint', config);
    },
    ...overrides,
  };

  return {
    deps,
    rows,
    s3Built,
    sharePointBuilt,
    queries,
    setNow: (ms: number) => {
      clock = ms;
    },
  };
}

interface RowOptions {
  id?: string;
  tenantId?: string;
  bucket?: string;
  secret?: string;
  active?: boolean;
}

/** Insere uma linha `('s3','tenant')` no banco falso e devolve o id dela. */
function putTenantS3Row(h: Harness, opts: RowOptions = {}): string {
  const id = opts.id ?? CONFIG_1;
  h.rows.set(id, {
    id,
    tenant_id: opts.tenantId ?? TENANT_A,
    provider: 's3',
    credentials_source: 'tenant',
    config: {
      region: 'sa-east-1',
      bucket: opts.bucket ?? 'bucket-do-cliente',
      accessKeyId: 'AKIA-DO-CLIENTE',
      endpoint: 'https://s3.sa-east-1.amazonaws.com',
      forcePathStyle: false,
    },
    encrypted_secret: encryptSecret(opts.secret ?? 'segredo-do-cliente', SECRET_KEY),
    active: opts.active ?? true,
  });
  return id;
}

// ---------------------------------------------------------------------------

describe('resolveStorageDriver — destino ATIVO da empresa (escrita)', () => {
  it('sem linha ativa em tenant_storage_configs, usa o bucket da plataforma', async () => {
    const h = harness();

    const driver = await resolveStorageDriver(h.deps, TENANT_A);

    expect(driver.provider).toBe('s3');
    expect(h.s3Built).toEqual([PLATFORM_CONFIG]);
  });

  it("('s3','platform') é idêntico a não ter linha", async () => {
    const h = harness();
    h.rows.set(CONFIG_1, {
      id: CONFIG_1,
      tenant_id: TENANT_A,
      provider: 's3',
      credentials_source: 'platform',
      config: {},
      encrypted_secret: null,
      active: true,
    });

    const driver = await resolveStorageDriver(h.deps, TENANT_A);

    expect(driver.provider).toBe('s3');
    expect(h.s3Built).toEqual([PLATFORM_CONFIG]);
  });

  it("('s3','tenant') usa o bucket da empresa com o segredo decifrado", async () => {
    const h = harness();
    putTenantS3Row(h, { bucket: 'bucket-do-cliente' });

    const driver = await resolveStorageDriver(h.deps, TENANT_A);

    expect(driver.provider).toBe('s3');
    expect(h.s3Built).toEqual([
      {
        region: 'sa-east-1',
        bucket: 'bucket-do-cliente',
        accessKeyId: 'AKIA-DO-CLIENTE',
        secretAccessKey: 'segredo-do-cliente',
        endpoint: 'https://s3.sa-east-1.amazonaws.com',
        forcePathStyle: false,
      },
    ]);
    // O bucket da plataforma NÃO foi construído junto.
    expect(h.s3Built).toHaveLength(1);
  });

  it("('sharepoint','tenant') constrói o driver do SharePoint com o client secret decifrado", async () => {
    const h = harness();
    h.rows.set(CONFIG_1, {
      id: CONFIG_1,
      tenant_id: TENANT_A,
      provider: 'sharepoint',
      credentials_source: 'tenant',
      config: {
        azureTenantId: 'aad-tenant',
        clientId: 'client-id',
        siteId: 'site-id',
        driveId: 'drive-id',
        rootFolder: 'DMDoc',
      },
      encrypted_secret: encryptSecret('client-secret-do-azure', SECRET_KEY),
      active: true,
    });

    const driver = await resolveStorageDriver(h.deps, TENANT_A);

    expect(driver.provider).toBe('sharepoint');
    expect(h.sharePointBuilt).toEqual([
      {
        azureTenantId: 'aad-tenant',
        clientId: 'client-id',
        clientSecret: 'client-secret-do-azure',
        siteId: 'site-id',
        driveId: 'drive-id',
        rootFolder: 'DMDoc',
        graphBaseUrl: undefined,
        loginBaseUrl: undefined,
      },
    ]);
    expect(h.s3Built).toHaveLength(0);
  });

  it('IGNORA a configuração aposentada e resolve a ativa', async () => {
    const h = harness();
    putTenantS3Row(h, { id: CONFIG_1, bucket: 'bucket-antigo', active: false });
    putTenantS3Row(h, { id: CONFIG_2, bucket: 'bucket-novo', active: true });

    await resolveStorageDriver(h.deps, TENANT_A);

    expect(h.s3Built).toHaveLength(1);
    expect((h.s3Built[0] as S3Config).bucket).toBe('bucket-novo');
  });

  it('empresa que só tem configuração APOSENTADA volta ao destino da plataforma', async () => {
    // É o "voltar para o S3 da plataforma" da T-140: aposenta a ativa e não
    // insere nenhuma. Uploads novos vão para o bucket do `.env`; o acervo antigo
    // continua legível pela linha aposentada (ver `forStorageConfig`).
    const h = harness();
    putTenantS3Row(h, { id: CONFIG_1, bucket: 'bucket-abandonado', active: false });

    await resolveStorageDriver(h.deps, TENANT_A);

    expect(h.s3Built).toEqual([PLATFORM_CONFIG]);
  });
});

describe('resolveStorageDriverForConfig — destino DE UM DOCUMENTO (leitura)', () => {
  it('storage_config_id nulo é o S3 da plataforma, e nem consulta o banco', async () => {
    const h = harness();
    putTenantS3Row(h, { bucket: 'bucket-do-cliente' });

    const driver = await resolveStorageDriverForConfig(h.deps, TENANT_A, null);

    expect(driver.provider).toBe('s3');
    expect(h.s3Built).toEqual([PLATFORM_CONFIG]);
    expect(h.queries()).toBe(0);
  });

  it('lê pela configuração APOSENTADA quando é nela que o documento está', async () => {
    const h = harness();
    putTenantS3Row(h, { id: CONFIG_1, bucket: 'bucket-antigo', active: false });
    putTenantS3Row(h, { id: CONFIG_2, bucket: 'bucket-novo', active: true });

    const driver = await resolveStorageDriverForConfig(h.deps, TENANT_A, CONFIG_1);

    expect((driver as SpyDriver).builtWith).toMatchObject({ bucket: 'bucket-antigo' });
  });

  it('id de configuração de OUTRA empresa não resolve driver nenhum', async () => {
    const h = harness();
    // A configuração existe — mas é da empresa B.
    putTenantS3Row(h, { id: CONFIG_1, tenantId: TENANT_B, bucket: 'bucket-da-b' });

    await expect(resolveStorageDriverForConfig(h.deps, TENANT_A, CONFIG_1)).rejects.toThrow(
      StorageTargetError
    );
    // Nada foi construído: ler o bucket alheio com as credenciais dele é o pior
    // vazamento possível aqui, e não pode acontecer nem como efeito colateral.
    expect(h.s3Built).toHaveLength(0);
    expect(h.sharePointBuilt).toHaveLength(0);
  });

  it('id inexistente é erro, NUNCA fallback para a plataforma', async () => {
    const h = harness();

    const error = await resolveStorageDriverForConfig(h.deps, TENANT_A, CONFIG_3).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(StorageTargetError);
    expect((error as StorageTargetError).tenantId).toBe(TENANT_A);
    expect((error as Error).message).toMatch(/não existe nesta empresa/);
    expect(h.s3Built).toHaveLength(0);
  });
});

describe('resolveStorageDriver — configuração quebrada', () => {
  it('rejeita provider desconhecido', async () => {
    const h = harness();
    h.rows.set(CONFIG_1, {
      id: CONFIG_1,
      tenant_id: TENANT_A,
      provider: 'dropbox',
      credentials_source: 'tenant',
      config: {},
      encrypted_secret: encryptSecret('x', SECRET_KEY),
      active: true,
    });

    await expect(resolveStorageDriver(h.deps, TENANT_A)).rejects.toThrow(StorageTargetError);
    await expect(resolveStorageDriver(h.deps, TENANT_A)).rejects.toThrow(/dropbox/);
  });

  it('rejeita sharepoint com credenciais da plataforma (não existe SharePoint da plataforma)', async () => {
    const h = harness();
    h.rows.set(CONFIG_1, {
      id: CONFIG_1,
      tenant_id: TENANT_A,
      provider: 'sharepoint',
      credentials_source: 'platform',
      config: {},
      encrypted_secret: null,
      active: true,
    });

    await expect(resolveStorageDriver(h.deps, TENANT_A)).rejects.toThrow(
      /credenciais de plataforma só valem para s3/
    );
  });

  it('rejeita credentials_source = tenant sem segredo gravado', async () => {
    const h = harness();
    const id = putTenantS3Row(h);
    h.rows.set(id, { ...h.rows.get(id)!, encrypted_secret: null });

    await expect(resolveStorageDriver(h.deps, TENANT_A)).rejects.toThrow(/exige encrypted_secret/);
  });

  it('rejeita segredo cifrado com outra chave mestra', async () => {
    const h = harness();
    const id = putTenantS3Row(h);
    h.rows.set(id, {
      ...h.rows.get(id)!,
      encrypted_secret: encryptSecret('segredo', Buffer.alloc(32, 9)),
    });

    const error = await resolveStorageDriver(h.deps, TENANT_A).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageTargetError);
    expect((error as StorageTargetError).tenantId).toBe(TENANT_A);
    expect((error as Error).message).toMatch(/decifrar o segredo/);
  });

  it('rejeita campo obrigatório ausente, dizendo qual', async () => {
    const h = harness();
    const id = putTenantS3Row(h);
    h.rows.set(id, {
      ...h.rows.get(id)!,
      config: { region: 'sa-east-1', accessKeyId: 'k' },
    });

    await expect(resolveStorageDriver(h.deps, TENANT_A)).rejects.toThrow(/bucket/);
  });

  it('acusa jsonb double-encoded (gravado com JSON.stringify) em vez de quebrar adiante', async () => {
    const h = harness();
    const id = putTenantS3Row(h);
    const row = h.rows.get(id)!;
    h.rows.set(id, { ...row, config: JSON.stringify(row.config) });

    await expect(resolveStorageDriver(h.deps, TENANT_A)).rejects.toThrow(/double-encoded/);
  });

  it('configuração quebrada APOSENTADA quebra só a leitura daquele documento', async () => {
    const h = harness();
    putTenantS3Row(h, { id: CONFIG_1, bucket: 'bucket-antigo', active: false });
    h.rows.set(CONFIG_1, { ...h.rows.get(CONFIG_1)!, encrypted_secret: null });
    putTenantS3Row(h, { id: CONFIG_2, bucket: 'bucket-novo', active: true });

    await expect(resolveStorageDriverForConfig(h.deps, TENANT_A, CONFIG_1)).rejects.toThrow(
      StorageTargetError
    );
    // O destino ativo continua resolvendo: upload novo não é afetado.
    await expect(resolveStorageDriver(h.deps, TENANT_A)).resolves.toBeDefined();
  });
});

describe('createStorageResolver — cache', () => {
  it('reaproveita a mesma instância de driver enquanto a configuração não muda', async () => {
    const h = harness();
    putTenantS3Row(h, { bucket: 'bucket-do-cliente' });
    const resolver = createStorageResolver(h.deps);

    const first = await resolver.forTenant(TENANT_A);
    const second = await resolver.forTenant(TENANT_A);

    expect(second).toBe(first);
    // Construiu uma vez só — mas releu a linha nas duas chamadas, que é o que
    // permite perceber a troca de configuração sem esperar TTL.
    expect(h.s3Built).toHaveLength(1);
    expect(h.queries()).toBe(2);
  });

  it('trocar de destino (linha NOVA) vale na chamada seguinte, sem esperar o TTL', async () => {
    const h = harness();
    putTenantS3Row(h, { id: CONFIG_1, bucket: 'bucket-antigo' });
    const resolver = createStorageResolver(h.deps);

    const before = await resolver.forTenant(TENANT_A);

    // Troca de destino no modelo versionado: aposenta a linha e insere outra.
    putTenantS3Row(h, { id: CONFIG_1, bucket: 'bucket-antigo', active: false });
    putTenantS3Row(h, { id: CONFIG_2, bucket: 'bucket-novo', active: true });

    const after = await resolver.forTenant(TENANT_A);

    expect(after).not.toBe(before);
    expect(h.s3Built).toHaveLength(2);
    expect((h.s3Built[1] as S3Config).bucket).toBe('bucket-novo');
  });

  it('linha editada no lugar (violando a imutabilidade) ainda é percebida pelo hash', async () => {
    // Não deveria acontecer — a T-140 nunca faz UPDATE de config. É a
    // salvaguarda contra um psql manual servindo credencial revogada por um TTL.
    const h = harness();
    putTenantS3Row(h, { id: CONFIG_1, bucket: 'bucket-antigo' });
    const resolver = createStorageResolver(h.deps);

    const before = await resolver.forTenant(TENANT_A);
    putTenantS3Row(h, { id: CONFIG_1, bucket: 'bucket-reescrito' });
    const after = await resolver.forTenant(TENANT_A);

    expect(after).not.toBe(before);
    expect((h.s3Built[1] as S3Config).bucket).toBe('bucket-reescrito');
  });

  it('sair do destino próprio e voltar para a plataforma também é percebido', async () => {
    const h = harness();
    putTenantS3Row(h, { id: CONFIG_1, bucket: 'bucket-do-cliente' });
    const resolver = createStorageResolver(h.deps);

    await resolver.forTenant(TENANT_A);
    putTenantS3Row(h, { id: CONFIG_1, bucket: 'bucket-do-cliente', active: false });
    await resolver.forTenant(TENANT_A);

    expect(h.s3Built).toHaveLength(2);
    expect(h.s3Built[1]).toEqual(PLATFORM_CONFIG);
  });

  it('invalidate() força reconstrução mesmo com a configuração intacta', async () => {
    const h = harness();
    putTenantS3Row(h, { bucket: 'bucket-do-cliente' });
    const resolver = createStorageResolver(h.deps);

    const first = await resolver.forTenant(TENANT_A);
    resolver.invalidate(TENANT_A);
    const second = await resolver.forTenant(TENANT_A);

    expect(second).not.toBe(first);
    expect(h.s3Built).toHaveLength(2);
  });

  it('invalidate() com um id derruba só aquela configuração', async () => {
    const h = harness();
    putTenantS3Row(h, { id: CONFIG_1, bucket: 'bucket-antigo', active: false });
    putTenantS3Row(h, { id: CONFIG_2, bucket: 'bucket-novo', active: true });
    const resolver = createStorageResolver(h.deps);

    const antigo = await resolver.forStorageConfig(TENANT_A, CONFIG_1);
    const novo = await resolver.forStorageConfig(TENANT_A, CONFIG_2);

    resolver.invalidate(TENANT_A, CONFIG_1);

    expect(await resolver.forStorageConfig(TENANT_A, CONFIG_2)).toBe(novo);
    expect(await resolver.forStorageConfig(TENANT_A, CONFIG_1)).not.toBe(antigo);
  });

  it('descarta a instância depois do TTL', async () => {
    const h = harness({ driverTtlMs: 60_000 });
    putTenantS3Row(h, { bucket: 'bucket-do-cliente' });
    const resolver = createStorageResolver(h.deps);

    const first = await resolver.forTenant(TENANT_A);
    h.setNow(1_000 + 59_999);
    expect(await resolver.forTenant(TENANT_A)).toBe(first);

    h.setNow(1_000 + 60_000);
    expect(await resolver.forTenant(TENANT_A)).not.toBe(first);
    expect(h.s3Built).toHaveLength(2);
  });

  it('duas empresas na mesma instância não se contaminam', async () => {
    const h = harness();
    putTenantS3Row(h, { id: CONFIG_1, tenantId: TENANT_A, bucket: 'bucket-da-a', secret: 'segredo-a' });
    putTenantS3Row(h, { id: CONFIG_2, tenantId: TENANT_B, bucket: 'bucket-da-b', secret: 'segredo-b' });
    const resolver = createStorageResolver(h.deps);

    const a = await resolver.forTenant(TENANT_A);
    const b = await resolver.forTenant(TENANT_B);

    expect(a).not.toBe(b);
    expect((a as SpyDriver).builtWith).toMatchObject({
      bucket: 'bucket-da-a',
      secretAccessKey: 'segredo-a',
    });
    expect((b as SpyDriver).builtWith).toMatchObject({
      bucket: 'bucket-da-b',
      secretAccessKey: 'segredo-b',
    });

    // Invalidar uma não derruba a outra.
    resolver.invalidate(TENANT_A);
    expect(await resolver.forTenant(TENANT_B)).toBe(b);
    expect(await resolver.forTenant(TENANT_A)).not.toBe(a);
  });

  it('a empresa da plataforma não herda o driver da empresa com bucket próprio', async () => {
    const h = harness();
    putTenantS3Row(h, { id: CONFIG_1, tenantId: TENANT_A, bucket: 'bucket-da-a' });
    const resolver = createStorageResolver(h.deps);

    const a = await resolver.forTenant(TENANT_A);
    const b = await resolver.forTenant(TENANT_B);

    expect(b).not.toBe(a);
    expect((b as SpyDriver).builtWith).toEqual(PLATFORM_CONFIG);
  });

  it('resoluções concorrentes da mesma empresa constroem UM driver só', async () => {
    const h = harness();
    putTenantS3Row(h, { bucket: 'bucket-do-cliente' });
    const resolver = createStorageResolver(h.deps);

    const [a, b, c] = await Promise.all([
      resolver.forTenant(TENANT_A),
      resolver.forTenant(TENANT_A),
      resolver.forTenant(TENANT_A),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(h.s3Built).toHaveLength(1);
  });

  it('leituras concorrentes da MESMA configuração também constroem UM driver só', async () => {
    const h = harness();
    putTenantS3Row(h, { id: CONFIG_1, bucket: 'bucket-antigo', active: false });
    const resolver = createStorageResolver(h.deps);

    const [a, b, c] = await Promise.all([
      resolver.forStorageConfig(TENANT_A, CONFIG_1),
      resolver.forStorageConfig(TENANT_A, CONFIG_1),
      resolver.forStorageConfig(TENANT_A, CONFIG_1),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(h.s3Built).toHaveLength(1);
  });

  it('erro de configuração não fica preso no cache de resoluções em voo', async () => {
    const h = harness();
    const id = putTenantS3Row(h);
    h.rows.set(id, { ...h.rows.get(id)!, encrypted_secret: null });
    const resolver = createStorageResolver(h.deps);

    await expect(resolver.forTenant(TENANT_A)).rejects.toThrow(StorageTargetError);

    // Corrigida a configuração, a chamada seguinte funciona — sem TTL, sem
    // invalidate: a promessa rejeitada não pode ter ficado registrada.
    putTenantS3Row(h, { id, bucket: 'bucket-consertado' });
    const driver = await resolver.forTenant(TENANT_A);
    expect((driver as SpyDriver).builtWith).toMatchObject({ bucket: 'bucket-consertado' });
  });
});

describe('createStorageResolver — leitura por documento', () => {
  it('activeDestination devolve o driver E o id da configuração usada', async () => {
    const h = harness();
    putTenantS3Row(h, { id: CONFIG_2, bucket: 'bucket-novo' });
    const resolver = createStorageResolver(h.deps);

    const destination = await resolver.activeDestination(TENANT_A);

    expect(destination.storageConfigId).toBe(CONFIG_2);
    expect((destination.driver as SpyDriver).builtWith).toMatchObject({ bucket: 'bucket-novo' });
  });

  it('activeDestination devolve id nulo quando a empresa está na plataforma', async () => {
    const h = harness();
    const resolver = createStorageResolver(h.deps);

    const destination = await resolver.activeDestination(TENANT_A);

    expect(destination.storageConfigId).toBeNull();
    expect((destination.driver as SpyDriver).builtWith).toEqual(PLATFORM_CONFIG);
  });

  it('acervo dividido: cada documento resolve o SEU destino, na mesma instância', async () => {
    const h = harness();
    putTenantS3Row(h, { id: CONFIG_1, bucket: 'bucket-antigo', active: false });
    putTenantS3Row(h, { id: CONFIG_2, bucket: 'bucket-novo', active: true });
    const resolver = createStorageResolver(h.deps);

    const naPlataforma = await resolver.forStorageConfig(TENANT_A, null);
    const noAntigo = await resolver.forStorageConfig(TENANT_A, CONFIG_1);
    const noNovo = await resolver.forStorageConfig(TENANT_A, CONFIG_2);

    expect((naPlataforma as SpyDriver).builtWith).toEqual(PLATFORM_CONFIG);
    expect((noAntigo as SpyDriver).builtWith).toMatchObject({ bucket: 'bucket-antigo' });
    expect((noNovo as SpyDriver).builtWith).toMatchObject({ bucket: 'bucket-novo' });
  });

  it('a mesma configuração cacheada pela dona NÃO é servida a outra empresa', async () => {
    const h = harness();
    putTenantS3Row(h, { id: CONFIG_1, tenantId: TENANT_B, bucket: 'bucket-da-b' });
    const resolver = createStorageResolver(h.deps);

    // A dona resolve primeiro, deixando a entrada quente no cache.
    await resolver.forStorageConfig(TENANT_B, CONFIG_1);

    await expect(resolver.forStorageConfig(TENANT_A, CONFIG_1)).rejects.toThrow(
      StorageTargetError
    );
    expect(h.s3Built).toHaveLength(1);
  });

  it('o destino ativo e a leitura pela MESMA configuração compartilham a instância', async () => {
    const h = harness();
    putTenantS3Row(h, { id: CONFIG_1, bucket: 'bucket-do-cliente' });
    const resolver = createStorageResolver(h.deps);

    const escrita = await resolver.forTenant(TENANT_A);
    const leitura = await resolver.forStorageConfig(TENANT_A, CONFIG_1);

    expect(leitura).toBe(escrita);
    expect(h.s3Built).toHaveLength(1);
  });
});
