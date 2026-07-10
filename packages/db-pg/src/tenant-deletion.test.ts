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
 * - Storage: `deleteS3Prefix` chamado 1x com `tenants/{id}/`.
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
      content_hash, size_bytes, mime_type, s3_key, status, uploaded_by_id
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

async function countRows(table: string, tenantId: string): Promise<number> {
  const rows = await sql.unsafe<Array<{ c: number }>>(
    `SELECT COUNT(*)::int AS c FROM ${table} WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows[0]?.c ?? 0;
}

function makeDeps(): { deps: PurgeTenantDeps; deleteS3Prefix: ReturnType<typeof vi.fn> } {
  const deleteS3Prefix = vi.fn(async () => undefined);
  const deps: PurgeTenantDeps = {
    deleteS3Prefix,
    logger: { info: () => undefined, error: () => undefined },
  };
  return { deps, deleteS3Prefix };
}

const GLOBAL_TYPE_ID = '99999999-9999-9999-9999-999999999999';
// Ator global (SUPER_ADMIN, tenant_id NULL) que executa a exclusão — NÃO é removido.
const GLOBAL_ACTOR_ID = '88888888-8888-8888-8888-888888888888';

beforeEach(async () => {
  // Limpeza total (ordem filhos → pais) antes de cada teste.
  await sql`DELETE FROM chunks`;
  await sql`DELETE FROM document_content`;
  await sql`DELETE FROM document_events`;
  await sql`DELETE FROM audit_logs`;
  await sql`DELETE FROM documents`;
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

  await seedTenant(TENANT_A, '0a', GLOBAL_TYPE_ID);
  await seedTenant(TENANT_B, '0b', GLOBAL_TYPE_ID);

  // Ator global (SUPER_ADMIN, sem tenant) e o audit `tenant.delete.requested`
  // que ele gera no tenant A — o user_id deve sobreviver à purga.
  await sql`INSERT INTO users (id, tenant_id, email, password_hash, name, role)
    VALUES (${GLOBAL_ACTOR_ID}, NULL, 'qa-actor@global.test', 'x', 'QA Actor', 'SUPER_ADMIN')`;
  await sql`INSERT INTO audit_logs (id, tenant_id, user_id, action, resource)
    VALUES ('a0000000-0000-0000-0000-0000000000ac', ${TENANT_A}, ${GLOBAL_ACTOR_ID},
            'tenant.delete.requested', ${'tenants/' + TENANT_A})`;
});

afterAll(async () => {
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
    expect(metadata.counts?.['documents']).toBe(1);
    expect(metadata.counts?.['users']).toBe(1);
  });

  it('chama deleteS3Prefix uma vez com o prefixo do tenant', async () => {
    const { deps, deleteS3Prefix } = makeDeps();
    await purgeTenantData(sql, TENANT_A, deps);

    expect(deleteS3Prefix).toHaveBeenCalledTimes(1);
    expect(deleteS3Prefix).toHaveBeenCalledWith(`tenants/${TENANT_A}/`);
  });

  it('mantém o tenant de controle 100% intacto (isolamento)', async () => {
    const { deps } = makeDeps();
    await purgeTenantData(sql, TENANT_A, deps);

    expect(await countRows('chunks', TENANT_B)).toBe(1);
    expect(await countRows('document_content', TENANT_B)).toBe(1);
    expect(await countRows('documents', TENANT_B)).toBe(1);
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
