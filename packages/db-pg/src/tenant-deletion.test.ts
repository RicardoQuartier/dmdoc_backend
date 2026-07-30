import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { purgeTenantData, type PurgeTenantDeps } from './tenant-deletion.js';

/**
 * Testes de integração de `purgeTenantData` contra um PostgreSQL real
 * (banco `dmdoc_test`, migrado com o mesmo schema do dev).
 *
 * Cobertura:
 * - Conteúdo do tenant alvo é fisicamente removido (tabelas vazias).
 * - Auditoria preservada: `document_events` e `audit_logs` permanecem, com FKs
 *   anuladas, mantendo `tenant_id`.
 * - Tenant alvo: deleted=true, active=false, deleted_at preenchido, name renomeado.
 * - Isolamento: o tenant de controle permanece 100% intacto.
 * - Storage: `deleteStoragePrefix` chamado 1x com `{ tenantId, prefix }`.
 * - Storage por empresa (E-11 / T-142): quando o callback roda, o inventário de
 *   destinos ainda está inteiro no banco — TODAS as linhas de
 *   `tenant_storage_configs` (com credenciais) e os documentos que revelam o
 *   destino da plataforma. Depois, nenhuma dessas linhas sobrevive.
 * - Idempotência: re-executar não lança.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test';

const sql: Sql = postgres(DATABASE_URL);

// UUIDs fixos para o tenant alvo (A) e o de controle (B).
const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

const EMBEDDING = `[${Array.from({ length: 1536 }, () => 0).join(',')}]`;

interface SeedIds {
  userId: string;
  deptId: string;
  docTypeId: string;
  indexFieldId: string;
  docId: string;
  permId: string;
  eventId: string;
  auditId: string;
  globalLinkId: string;
}

interface StorageIds {
  cfgS3Old: string;
  cfgS3New: string;
  cfgSp: string;
  migrationId: string;
  docS3Old: string;
  docS3New: string;
  docSp: string;
}

/**
 * Fotografia do inventário de destinos NO INSTANTE em que o callback de storage
 * roda — é o que a implementação do worker (fatia da yukino) vai consultar.
 */
interface StorageInventory {
  configs: Array<{ id: string; provider: string; bucket: string | null; hasSecret: boolean }>;
  /** `EXISTS` de documento com `storage_config_id IS NULL`, SEM filtro de `deleted`. */
  hasPlatformDocs: boolean;
  /** Documentos do tenant ainda presentes (a purga do banco não pode ter rodado). */
  documentCount: number;
}

/**
 * Semeia um conjunto completo de dados para um tenant: usuário, departamento,
 * tipo de documento (+ index field), documento (+ content + chunk),
 * permissão, link de tipo global, evento de upload e audit log.
 * `globalTypeId` é um tipo GLOBAL (tenant_id NULL) compartilhado.
 */
async function seedTenant(tenantId: string, suffix: string, globalTypeId: string): Promise<SeedIds> {
  const ids: SeedIds = {
    userId: `aaaa0000-0000-0000-0000-0000000000${suffix}`,
    deptId: `bbbb0000-0000-0000-0000-0000000000${suffix}`,
    docTypeId: `cccc0000-0000-0000-0000-0000000000${suffix}`,
    indexFieldId: `dddd0000-0000-0000-0000-0000000000${suffix}`,
    docId: `eeee0000-0000-0000-0000-0000000000${suffix}`,
    permId: `ffff0000-0000-0000-0000-0000000000${suffix}`,
    eventId: `a1b20000-0000-0000-0000-0000000000${suffix}`,
    auditId: `a3b40000-0000-0000-0000-0000000000${suffix}`,
    globalLinkId: `a5b60000-0000-0000-0000-0000000000${suffix}`,
  };

  await sql`INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active)
    VALUES (${tenantId}, ${`Empresa ${suffix}`}, ${1_000_000}, ${10}, true)`;

  await sql`INSERT INTO users (id, tenant_id, email, password_hash, name, role)
    VALUES (${ids.userId}, ${tenantId}, ${`user${suffix}@x.com`}, 'hash', 'User', 'USER')`;

  await sql`INSERT INTO departments (id, tenant_id, name, level)
    VALUES (${ids.deptId}, ${tenantId}, 'Dept', 0)`;

  await sql`INSERT INTO document_types (id, tenant_id, name, is_global)
    VALUES (${ids.docTypeId}, ${tenantId}, ${`Tipo ${suffix}`}, false)`;

  await sql`INSERT INTO document_type_index_fields (id, document_type_id, name, field_type)
    VALUES (${ids.indexFieldId}, ${ids.docTypeId}, 'Campo', 'TEXT')`;

  // Link de tipo GLOBAL para este tenant (deve ser purgado; o tipo global NÃO).
  await sql`INSERT INTO global_type_tenant_depts (id, global_type_id, tenant_id, department_ids)
    VALUES (${ids.globalLinkId}, ${globalTypeId}, ${tenantId}, ${sql.array([ids.deptId])}::uuid[])`;

  await sql`INSERT INTO documents (
      id, tenant_id, department_id, document_type_id, filename, original_filename,
      content_hash, size_bytes, mime_type, storage_key, status, uploaded_by_id
    ) VALUES (
      ${ids.docId}, ${tenantId}, ${ids.deptId}, ${ids.docTypeId}, 'f.pdf', 'f.pdf',
      ${`hash${suffix}`}, ${1234}, 'application/pdf', ${`tenants/${tenantId}/f.pdf`}, 'READY', ${ids.userId}
    )`;

  await sql`INSERT INTO document_content (document_id, tenant_id, full_text, extraction)
    VALUES (${ids.docId}, ${tenantId}, 'texto', ${'{}'}::jsonb)`;

  await sql`INSERT INTO chunks (
      document_id, tenant_id, department_id, chunk_index, text, embedding
    ) VALUES (
      ${ids.docId}, ${tenantId}, ${ids.deptId}, 0, 'chunk', ${EMBEDDING}::vector
    )`;

  await sql`INSERT INTO department_permissions (id, tenant_id, user_id, department_id, can_read, can_write)
    VALUES (${ids.permId}, ${tenantId}, ${ids.userId}, ${ids.deptId}, true, true)`;

  await sql`INSERT INTO document_events (
      id, tenant_id, document_id, uploaded_by_id, mime_type, document_type_id,
      document_type_name, size_bytes
    ) VALUES (
      ${ids.eventId}, ${tenantId}, ${ids.docId}, ${ids.userId}, 'application/pdf',
      ${ids.docTypeId}, ${`Tipo ${suffix}`}, ${1234}
    )`;

  await sql`INSERT INTO audit_logs (id, tenant_id, user_id, action, resource)
    VALUES (${ids.auditId}, ${tenantId}, ${ids.userId}, 'document.upload', ${`documents/${ids.docId}`})`;

  return ids;
}

/**
 * Semeia os DESTINOS DE ARMAZENAMENTO do tenant (E-11) e um documento em cada
 * um, reproduzindo a empresa que já morou em mais de um lugar:
 *
 * - `cfgS3Old`  — bucket S3 do cliente no MinIO, APOSENTADA (migração antiga);
 * - `cfgS3New`  — OUTRO bucket S3, também aposentada;
 * - `cfgSp`     — SharePoint, ATIVA (destino corrente).
 *
 * ⚠️ As duas primeiras existem para travar o furo que a ADR-1 corrigiu: ambas
 * têm `provider = 's3'`, então uma varredura por `DISTINCT storage_provider`
 * enxergaria UM destino e deixaria metade do acervo do cliente para trás.
 *
 * O documento da plataforma (`storage_config_id IS NULL`) já vem do `seedTenant`
 * — é o quarto destino, e o único que não tem linha em `tenant_storage_configs`.
 *
 * Todas as três configurações carregam `encrypted_secret` (secret key da AWS /
 * client secret do Azure, do CLIENTE): é o que a purga precisa levar embora.
 */
async function seedStorageDestinations(
  tenantId: string,
  suffix: string,
  ids: SeedIds,
): Promise<StorageIds> {
  const storage: StorageIds = {
    cfgS3Old: `c1c10000-0000-0000-0000-0000000000${suffix}`,
    cfgS3New: `c2c20000-0000-0000-0000-0000000000${suffix}`,
    cfgSp: `c3c30000-0000-0000-0000-0000000000${suffix}`,
    migrationId: `d1d10000-0000-0000-0000-0000000000${suffix}`,
    docS3Old: `e1e10000-0000-0000-0000-0000000000${suffix}`,
    docS3New: `e2e20000-0000-0000-0000-0000000000${suffix}`,
    docSp: `e3e30000-0000-0000-0000-0000000000${suffix}`,
  };

  // jsonb SEMPRE com sql.json — JSON.stringify grava string double-encoded.
  await sql`INSERT INTO tenant_storage_configs
      (id, tenant_id, provider, credentials_source, config, encrypted_secret, active, retired_at)
    VALUES (
      ${storage.cfgS3Old}, ${tenantId}, 's3', 'tenant',
      ${sql.json({ endpoint: 'https://minio.cliente.local', bucket: `acervo-antigo-${suffix}` })},
      ${secretOf(suffix, 's3-old')}, false, now()
    )`;
  await sql`INSERT INTO tenant_storage_configs
      (id, tenant_id, provider, credentials_source, config, encrypted_secret, active, retired_at)
    VALUES (
      ${storage.cfgS3New}, ${tenantId}, 's3', 'tenant',
      ${sql.json({ bucket: `acervo-novo-${suffix}`, region: 'us-east-1' })},
      ${secretOf(suffix, 's3-new')}, false, now()
    )`;
  await sql`INSERT INTO tenant_storage_configs
      (id, tenant_id, provider, credentials_source, config, encrypted_secret, active)
    VALUES (
      ${storage.cfgSp}, ${tenantId}, 'sharepoint', 'tenant',
      ${sql.json({ siteId: `site-${suffix}`, driveId: `drive-${suffix}`, rootFolder: 'DMDoc' })},
      ${secretOf(suffix, 'sharepoint')}, true
    )`;

  const seedDoc = async (docId: string, configId: string, provider: string, tag: string) =>
    sql`INSERT INTO documents (
        id, tenant_id, department_id, document_type_id, filename, original_filename,
        content_hash, size_bytes, mime_type, storage_key, status, uploaded_by_id,
        storage_config_id, storage_provider
      ) VALUES (
        ${docId}, ${tenantId}, ${ids.deptId}, ${ids.docTypeId}, ${`${tag}.pdf`}, ${`${tag}.pdf`},
        ${`hash-${tag}-${suffix}`}, ${999}, 'application/pdf',
        ${`tenants/${tenantId}/${tag}.pdf`}, 'READY', ${ids.userId},
        ${configId}, ${provider}
      )`;

  await seedDoc(storage.docS3Old, storage.cfgS3Old, 's3', 'antigo');
  await seedDoc(storage.docS3New, storage.cfgS3New, 's3', 'novo');
  await seedDoc(storage.docSp, storage.cfgSp, 'sharepoint', 'sharepoint');

  // Histórico da migração que produziu esse estado (metadado; NÃO é fonte de
  // destinos para a varredura — as configurações aposentadas são).
  await sql`INSERT INTO storage_migrations
      (id, tenant_id, from_provider, to_provider, status, total_docs, migrated_docs, finished_at)
    VALUES (${storage.migrationId}, ${tenantId}, 's3', 'sharepoint', 'DONE', ${2}, ${2}, now())`;

  return storage;
}

/** Segredo cifrado sintético, previsível o bastante para ser caçado no banco. */
function secretOf(suffix: string, kind: string): string {
  return `SECRET-${suffix}-${kind}`;
}

async function countRows(table: string, tenantId: string): Promise<number> {
  const rows = await sql.unsafe<Array<{ c: number }>>(
    `SELECT COUNT(*)::int AS c FROM ${table} WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows[0]?.c ?? 0;
}

function makeDeps(): { deps: PurgeTenantDeps; deleteStoragePrefix: ReturnType<typeof vi.fn> } {
  const deleteStoragePrefix = vi.fn(async () => undefined);
  const deps: PurgeTenantDeps = {
    deleteStoragePrefix,
    logger: { info: () => undefined, error: () => undefined },
  };
  return { deps, deleteStoragePrefix };
}

/**
 * Deps cujo callback de storage FOTOGRAFA, do lado de fora da transação e pela
 * mesma pool que o worker usaria, o inventário de destinos disponível naquele
 * instante.
 *
 * É assim que se testa a ORDEM sem simular o worker: se a purga do banco rodar
 * antes do storage, a fotografia sai vazia — sem configuração (logo, sem
 * credencial para alcançar o bucket do cliente) e sem documento (logo, sem como
 * saber que parte do acervo está no bucket da plataforma).
 */
function makeInventoryDeps(): {
  deps: PurgeTenantDeps;
  calls: Array<{ tenantId: string; prefix: string }>;
  snapshots: StorageInventory[];
} {
  const calls: Array<{ tenantId: string; prefix: string }> = [];
  const snapshots: StorageInventory[] = [];

  const deps: PurgeTenantDeps = {
    deleteStoragePrefix: async ({ tenantId, prefix }) => {
      calls.push({ tenantId, prefix });

      const configs = await sql<
        Array<{ id: string; provider: string; config: Record<string, unknown>; encrypted_secret: string | null }>
      >`
        SELECT id, provider, config, encrypted_secret
          FROM tenant_storage_configs
         WHERE tenant_id = ${tenantId}
         ORDER BY created_at, id
      `;
      // Sem filtro de `deleted`: a purga é física, soft delete não vale aqui.
      const platform = await sql<Array<{ e: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM documents WHERE tenant_id = ${tenantId} AND storage_config_id IS NULL
        ) AS e
      `;
      const docs = await sql<Array<{ c: number }>>`
        SELECT COUNT(*)::int AS c FROM documents WHERE tenant_id = ${tenantId}
      `;

      snapshots.push({
        configs: configs.map((c) => ({
          id: c.id,
          provider: c.provider,
          bucket: typeof c.config['bucket'] === 'string' ? (c.config['bucket'] as string) : null,
          hasSecret: c.encrypted_secret !== null,
        })),
        hasPlatformDocs: platform[0]?.e ?? false,
        documentCount: docs[0]?.c ?? 0,
      });
    },
    logger: { info: () => undefined, error: () => undefined },
  };

  return { deps, calls, snapshots };
}

const GLOBAL_TYPE_ID = '99999999-9999-9999-9999-999999999999';
// Ator global (SUPER_ADMIN, tenant_id NULL) que executa a exclusão — NÃO é removido.
const GLOBAL_ACTOR_ID = '88888888-8888-8888-8888-888888888888';

/** Destinos de armazenamento do tenant alvo, resemeados a cada teste. */
let storageA: StorageIds;

beforeEach(async () => {
  // Limpeza total (ordem filhos → pais) antes de cada teste.
  await sql`DELETE FROM chunks`;
  await sql`DELETE FROM document_content`;
  await sql`DELETE FROM document_events`;
  await sql`DELETE FROM audit_logs`;
  await sql`DELETE FROM documents`;
  // Depois de `documents`: a FK COMPOSTA documents_storage_config_fk é
  // ON DELETE NO ACTION e recusaria o delete com documento apontando para cá.
  await sql`DELETE FROM tenant_storage_configs`;
  await sql`DELETE FROM storage_migrations`;
  await sql`DELETE FROM department_permissions`;
  await sql`DELETE FROM document_type_index_fields`;
  await sql`DELETE FROM global_type_tenant_depts`;
  await sql`DELETE FROM document_types`;
  await sql`DELETE FROM departments`;
  await sql`DELETE FROM users`;
  await sql`DELETE FROM tenants`;

  // Tipo de documento GLOBAL (compartilhado, tenant_id NULL).
  await sql`INSERT INTO document_types (id, tenant_id, name, is_global)
    VALUES (${GLOBAL_TYPE_ID}, NULL, 'Tipo Global', true)`;

  const idsA = await seedTenant(TENANT_A, '0a', GLOBAL_TYPE_ID);
  const idsB = await seedTenant(TENANT_B, '0b', GLOBAL_TYPE_ID);

  // Destinos de armazenamento (E-11): três configurações + um documento em cada,
  // nos dois tenants — o de controle serve para provar o isolamento também aqui.
  storageA = await seedStorageDestinations(TENANT_A, '0a', idsA);
  await seedStorageDestinations(TENANT_B, '0b', idsB);

  // Ator global (SUPER_ADMIN, sem tenant) e o audit `tenant.delete.requested`
  // que ele gera no tenant A — o user_id deve sobreviver à purga.
  await sql`INSERT INTO users (id, tenant_id, email, password_hash, name, role)
    VALUES (${GLOBAL_ACTOR_ID}, NULL, 'qa-actor@global.test', 'x', 'QA Actor', 'SUPER_ADMIN')`;
  await sql`INSERT INTO audit_logs (id, tenant_id, user_id, action, resource)
    VALUES ('a0000000-0000-0000-0000-0000000000ac', ${TENANT_A}, ${GLOBAL_ACTOR_ID},
            'tenant.delete.requested', ${'tenants/' + TENANT_A})`;
});

afterAll(async () => {
  // ⚠️ Limpar os DESTINOS antes de sair. `tenant_storage_configs` tem invariante
  // GLOBAL (`uniq_tenant_storage_active`) e `tenant-storage-schema.test.ts` conta
  // `WHERE active` sem filtro de tenant — deixar as configurações do tenant de
  // controle para trás quebra o arquivo seguinte, já que os testes de db-pg
  // rodam serializados sobre o MESMO banco (`fileParallelism: false`).
  await sql`DELETE FROM chunks`;
  await sql`DELETE FROM document_content`;
  await sql`DELETE FROM document_events`;
  await sql`DELETE FROM documents`;
  await sql`DELETE FROM tenant_storage_configs`;
  await sql`DELETE FROM storage_migrations`;
  await sql`DELETE FROM global_type_tenant_depts`;
  await sql`DELETE FROM document_types WHERE id = ${GLOBAL_TYPE_ID}`;
  await sql.end();
});

describe('purgeTenantData', () => {
  it('remove fisicamente todo o conteúdo do tenant alvo', async () => {
    const { deps } = makeDeps();
    await purgeTenantData(sql, TENANT_A, deps);

    expect(await countRows('chunks', TENANT_A)).toBe(0);
    expect(await countRows('document_content', TENANT_A)).toBe(0);
    expect(await countRows('documents', TENANT_A)).toBe(0);
    expect(await countRows('department_permissions', TENANT_A)).toBe(0);
    expect(await countRows('global_type_tenant_depts', TENANT_A)).toBe(0);
    expect(await countRows('document_types', TENANT_A)).toBe(0);
    expect(await countRows('departments', TENANT_A)).toBe(0);
    expect(await countRows('users', TENANT_A)).toBe(0);
    expect(await countRows('tenant_storage_configs', TENANT_A)).toBe(0);
    expect(await countRows('storage_migrations', TENANT_A)).toBe(0);

    // Index fields do tenant A (sem tenant_id próprio) também removidos.
    const idxFields = await sql`
      SELECT COUNT(*)::int AS c FROM document_type_index_fields
      WHERE document_type_id NOT IN (SELECT id FROM document_types)
    `;
    expect(idxFields[0]?.['c']).toBe(0);
  });

  it('preserva auditoria do tenant alvo com FKs anuladas', async () => {
    const { deps } = makeDeps();
    await purgeTenantData(sql, TENANT_A, deps);

    // document_events: linha permanece, tenant_id mantido, FKs anuladas.
    const events = await sql`
      SELECT tenant_id, document_id, document_type_id, uploaded_by_id
      FROM document_events WHERE tenant_id = ${TENANT_A}
    `;
    expect(events).toHaveLength(1);
    expect(events[0]?.['tenant_id']).toBe(TENANT_A);
    expect(events[0]?.['document_id']).toBeNull();
    expect(events[0]?.['document_type_id']).toBeNull();
    expect(events[0]?.['uploaded_by_id']).toBeNull();

    // audit_logs originais: preservados, tenant_id mantido, user_id anulado.
    const seededAudit = await sql`
      SELECT tenant_id, user_id FROM audit_logs
      WHERE tenant_id = ${TENANT_A} AND action = 'document.upload'
    `;
    expect(seededAudit).toHaveLength(1);
    expect(seededAudit[0]?.['user_id']).toBeNull();
  });

  it('preserva o ator global (SUPER_ADMIN) que executou a exclusão no audit', async () => {
    const { deps } = makeDeps();
    await purgeTenantData(sql, TENANT_A, deps);

    // O audit `tenant.delete.requested` referencia um usuário GLOBAL (não removido):
    // seu user_id deve ser PRESERVADO (invariante "audit guarda quem fez").
    const actorAudit = await sql`
      SELECT user_id FROM audit_logs
      WHERE tenant_id = ${TENANT_A} AND action = 'tenant.delete.requested'
    `;
    expect(actorAudit).toHaveLength(1);
    expect(actorAudit[0]?.['user_id']).toBe(GLOBAL_ACTOR_ID);

    // E o usuário global continua existindo (não foi removido pela purga).
    const actor = await sql`SELECT id FROM users WHERE id = ${GLOBAL_ACTOR_ID}`;
    expect(actor).toHaveLength(1);
  });

  it('marca o tenant como deletado, inativo e renomeado', async () => {
    const { deps } = makeDeps();
    await purgeTenantData(sql, TENANT_A, deps);

    const rows = await sql`SELECT name, active, deleted, deleted_at FROM tenants WHERE id = ${TENANT_A}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['active']).toBe(false);
    expect(rows[0]?.['deleted']).toBe(true);
    expect(rows[0]?.['deleted_at']).not.toBeNull();
    expect(String(rows[0]?.['name'])).toMatch(/^\[EXCLUÍDA-\d+\] Empresa 0a$/);
  });

  it('registra um audit log tenant.delete com user_id NULL', async () => {
    const { deps } = makeDeps();
    await purgeTenantData(sql, TENANT_A, deps);

    const rows = await sql`
      SELECT user_id, resource, metadata FROM audit_logs
      WHERE tenant_id = ${TENANT_A} AND action = 'tenant.delete'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['user_id']).toBeNull();
    expect(rows[0]?.['resource']).toBe(`tenants/${TENANT_A}`);
    const metadata = rows[0]?.['metadata'] as { counts?: Record<string, number> };
    // 1 documento na plataforma (seed) + 3 nos destinos próprios da empresa.
    expect(metadata.counts?.['documents']).toBe(4);
    expect(metadata.counts?.['users']).toBe(1);
    expect(metadata.counts?.['tenantStorageConfigs']).toBe(3);
    expect(metadata.counts?.['storageMigrations']).toBe(1);
  });

  it('chama deleteStoragePrefix uma vez com o tenant e o prefixo', async () => {
    const { deps, deleteStoragePrefix } = makeDeps();
    await purgeTenantData(sql, TENANT_A, deps);

    expect(deleteStoragePrefix).toHaveBeenCalledTimes(1);
    // O contrato passa o TENANT junto com o prefixo: é com ele que quem
    // implementa levanta TODOS os destinos da empresa, não só o corrente.
    expect(deleteStoragePrefix).toHaveBeenCalledWith({
      tenantId: TENANT_A,
      prefix: `tenants/${TENANT_A}/`,
    });
  });

  it('mantém o tenant de controle 100% intacto (isolamento)', async () => {
    const { deps } = makeDeps();
    await purgeTenantData(sql, TENANT_A, deps);

    expect(await countRows('chunks', TENANT_B)).toBe(1);
    expect(await countRows('document_content', TENANT_B)).toBe(1);
    expect(await countRows('documents', TENANT_B)).toBe(4);
    expect(await countRows('tenant_storage_configs', TENANT_B)).toBe(3);
    expect(await countRows('storage_migrations', TENANT_B)).toBe(1);
    expect(await countRows('department_permissions', TENANT_B)).toBe(1);
    expect(await countRows('global_type_tenant_depts', TENANT_B)).toBe(1);
    expect(await countRows('document_types', TENANT_B)).toBe(1);
    expect(await countRows('departments', TENANT_B)).toBe(1);
    expect(await countRows('users', TENANT_B)).toBe(1);
    expect(await countRows('document_events', TENANT_B)).toBe(1);

    // FKs do evento de B continuam preenchidas (não foram tocadas).
    const eventsB = await sql`
      SELECT document_id, uploaded_by_id FROM document_events WHERE tenant_id = ${TENANT_B}
    `;
    expect(eventsB[0]?.['document_id']).not.toBeNull();
    expect(eventsB[0]?.['uploaded_by_id']).not.toBeNull();

    // audit_log original de B mantém o user_id.
    const auditB = await sql`
      SELECT user_id FROM audit_logs WHERE tenant_id = ${TENANT_B} AND action = 'document.upload'
    `;
    expect(auditB[0]?.['user_id']).not.toBeNull();

    // Tenant B segue ativo e não deletado.
    const tenantB = await sql`SELECT active, deleted FROM tenants WHERE id = ${TENANT_B}`;
    expect(tenantB[0]?.['active']).toBe(true);
    expect(tenantB[0]?.['deleted']).toBe(false);

    // E as credenciais de B continuam de pé — a purga não varre a tabela toda.
    const secretsB = await sql<Array<{ c: number }>>`
      SELECT COUNT(*)::int AS c FROM tenant_storage_configs
       WHERE encrypted_secret LIKE 'SECRET-0b-%'
    `;
    expect(secretsB[0]?.c).toBe(3);
  });

  it('não remove o tipo de documento GLOBAL compartilhado', async () => {
    const { deps } = makeDeps();
    await purgeTenantData(sql, TENANT_A, deps);

    const global = await sql`SELECT id FROM document_types WHERE id = ${GLOBAL_TYPE_ID}`;
    expect(global).toHaveLength(1);
  });

  it('é idempotente: re-executar não lança e mantém o estado', async () => {
    const { deps } = makeDeps();
    await purgeTenantData(sql, TENANT_A, deps);
    await expect(purgeTenantData(sql, TENANT_A, deps)).resolves.toBeUndefined();

    // Segue deletado; nome não foi renomeado de novo (AND deleted = false).
    const rows = await sql`SELECT name, deleted FROM tenants WHERE id = ${TENANT_A}`;
    expect(rows[0]?.['deleted']).toBe(true);
    expect(String(rows[0]?.['name'])).toMatch(/^\[EXCLUÍDA-\d+\] Empresa 0a$/);
  });
});

/**
 * Empresa com arquivos em MAIS DE UM destino (E-11 / T-142).
 *
 * O `@dmdoc/db-pg` não conhece storage: ele não abre bucket nem SharePoint, e
 * por isso não há como testar aqui que o arquivo sumiu. O que ESTE pacote
 * garante — e é o que estes testes travam — é que, no instante em que o callback
 * roda, o inventário completo de destinos ainda está no banco e alcançável; e
 * que, depois, nada dele sobrevive.
 */
describe('purgeTenantData — destinos de armazenamento por empresa', () => {
  it('expõe ao callback TODOS os destinos do tenant, inclusive dois buckets S3 distintos', async () => {
    const { deps, calls, snapshots } = makeInventoryDeps();
    await purgeTenantData(sql, TENANT_A, deps);

    expect(calls).toEqual([{ tenantId: TENANT_A, prefix: `tenants/${TENANT_A}/` }]);
    const snap = snapshots[0];
    expect(snap).toBeDefined();

    // As TRÊS configurações — as duas aposentadas e a ativa. Uma varredura
    // baseada só no destino corrente enxergaria uma.
    expect(snap?.configs.map((c) => c.id).sort()).toEqual(
      [storageA.cfgS3Old, storageA.cfgS3New, storageA.cfgSp].sort(),
    );

    // ⚠️ O caso que a versão anterior da tarefa deixava passar: dois destinos
    // DIFERENTES com o mesmo `provider`. `DISTINCT storage_provider` devolveria
    // um único 's3' e metade do acervo do cliente ficaria para trás.
    const s3 = snap?.configs.filter((c) => c.provider === 's3') ?? [];
    expect(s3).toHaveLength(2);
    expect(new Set(s3.map((c) => c.bucket)).size).toBe(2);

    // O quarto destino não tem linha nenhuma: é a plataforma, e ela só se revela
    // por documento com `storage_config_id IS NULL`.
    expect(snap?.hasPlatformDocs).toBe(true);
  });

  it('entrega as credenciais vivas ao callback — o storage roda ANTES do banco', async () => {
    const { deps, snapshots } = makeInventoryDeps();
    await purgeTenantData(sql, TENANT_A, deps);

    // Sem `encrypted_secret` não se alcança o bucket nem o SharePoint do
    // cliente: apagar essas linhas antes do storage deixaria os arquivos
    // inalcançáveis para sempre.
    expect(snapshots[0]?.configs.every((c) => c.hasSecret)).toBe(true);
    // E os documentos ainda estavam lá — é deles que sai o destino de plataforma.
    expect(snapshots[0]?.documentCount).toBe(4);
  });

  it('não deixa o soft delete esconder o destino de plataforma', async () => {
    // Único documento na plataforma, e soft-deletado: a purga é FÍSICA, então a
    // varredura não pode filtrar `deleted = false` — o arquivo continua no
    // bucket da plataforma independentemente do estado lógico da linha.
    await sql`
      UPDATE documents SET deleted = true
       WHERE tenant_id = ${TENANT_A} AND storage_config_id IS NULL
    `;

    const { deps, snapshots } = makeInventoryDeps();
    await purgeTenantData(sql, TENANT_A, deps);

    expect(snapshots[0]?.hasPlatformDocs).toBe(true);
    expect(await countRows('documents', TENANT_A)).toBe(0);
  });

  it('não deixa nenhuma credencial do tenant sobreviver à exclusão da empresa', async () => {
    const { deps } = makeDeps();
    await purgeTenantData(sql, TENANT_A, deps);

    // Sem filtro de tenant, de propósito: o segredo não pode ter sobrado em
    // lugar nenhum da tabela. O tenant sofre SOFT delete, então nenhuma FK
    // obrigaria essas linhas a cair — a purga tem de derrubá-las explicitamente.
    const leftovers = await sql<Array<{ id: string }>>`
      SELECT id FROM tenant_storage_configs WHERE encrypted_secret LIKE 'SECRET-0a-%'
    `;
    expect(leftovers).toHaveLength(0);

    const anyConfig = await sql<Array<{ c: number }>>`
      SELECT COUNT(*)::int AS c FROM tenant_storage_configs WHERE tenant_id = ${TENANT_A}
    `;
    expect(anyConfig[0]?.c).toBe(0);

    const migrations = await sql<Array<{ c: number }>>`
      SELECT COUNT(*)::int AS c FROM storage_migrations WHERE tenant_id = ${TENANT_A}
    `;
    expect(migrations[0]?.c).toBe(0);
  });

  it('purga o banco mesmo quando o storage falha (falha logada, não abortiva)', async () => {
    const errors: unknown[] = [];
    const deps: PurgeTenantDeps = {
      // Credencial de SharePoint revogada, bucket fora do ar: o callback estoura.
      deleteStoragePrefix: async () => {
        throw new Error('destino inacessível');
      },
      logger: { info: () => undefined, error: (...a: unknown[]) => errors.push(a) },
    };

    await expect(purgeTenantData(sql, TENANT_A, deps)).resolves.toBeUndefined();

    expect(errors).toHaveLength(1);
    // O conteúdo lógico sai de qualquer jeito — inclusive as credenciais.
    expect(await countRows('documents', TENANT_A)).toBe(0);
    expect(await countRows('tenant_storage_configs', TENANT_A)).toBe(0);
    const tenant = await sql`SELECT deleted FROM tenants WHERE id = ${TENANT_A}`;
    expect(tenant[0]?.['deleted']).toBe(true);
  });

  it('é idempotente com destinos múltiplos: a segunda passada não acha mais nada', async () => {
    const { deps } = makeDeps();
    await purgeTenantData(sql, TENANT_A, deps);

    const { deps: deps2, snapshots } = makeInventoryDeps();
    await expect(purgeTenantData(sql, TENANT_A, deps2)).resolves.toBeUndefined();

    // Inventário vazio na re-execução: nenhuma configuração, nenhum documento.
    // Apagar prefixo inexistente é no-op nos dois drivers, então o retry do
    // BullMQ é seguro.
    expect(snapshots[0]?.configs).toEqual([]);
    expect(snapshots[0]?.hasPlatformDocs).toBe(false);
    expect(snapshots[0]?.documentCount).toBe(0);
  });
});
