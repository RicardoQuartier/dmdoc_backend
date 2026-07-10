import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { run } from './backfill-missing-document-events.js';

/**
 * Testes de integração de `run` (backfill-missing-document-events) contra um
 * PostgreSQL real (banco `dmdoc_test`, migrado com o mesmo schema do dev).
 *
 * Cobertura:
 * - Documento sem document_events correspondente → cria um evento.
 * - Documento que já tem document_events → não duplica.
 * - Rodar duas vezes seguidas → segunda execução não insere nada.
 * - Documento soft-deleted (deleted = true) sem evento → ainda cria o evento
 *   (confirma que o filtro d.deleted = false NÃO foi aplicado).
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test';

const sql: Sql = postgres(DATABASE_URL);

const TENANT_ID = '33333333-3333-3333-3333-333333333333';
const USER_ID = 'aaaa0000-0000-0000-0000-000000000001';
const DEPT_ID = 'bbbb0000-0000-0000-0000-000000000001';
const DOC_TYPE_ID = 'cccc0000-0000-0000-0000-000000000001';

async function insertDocument(id: string, opts: { deleted?: boolean } = {}): Promise<void> {
  await sql`INSERT INTO documents (
      id, tenant_id, department_id, document_type_id, filename, original_filename,
      content_hash, size_bytes, mime_type, s3_key, status, uploaded_by_id, deleted
    ) VALUES (
      ${id}, ${TENANT_ID}, ${DEPT_ID}, ${DOC_TYPE_ID}, 'f.pdf', 'f.pdf',
      ${`hash-${id}`}, ${1234}, 'application/pdf', ${`tenants/${TENANT_ID}/${id}`}, 'READY',
      ${USER_ID}, ${opts.deleted ?? false}
    )`;
}

async function countEvents(documentId: string): Promise<number> {
  const rows = await sql`SELECT COUNT(*)::int AS c FROM document_events WHERE document_id = ${documentId}`;
  return Number(rows[0]?.['c'] ?? 0);
}

beforeEach(async () => {
  await sql`DELETE FROM chunks WHERE tenant_id = ${TENANT_ID}`;
  await sql`DELETE FROM document_content WHERE tenant_id = ${TENANT_ID}`;
  await sql`DELETE FROM document_events WHERE tenant_id = ${TENANT_ID}`;
  await sql`DELETE FROM audit_logs WHERE tenant_id = ${TENANT_ID}`;
  await sql`DELETE FROM documents WHERE tenant_id = ${TENANT_ID}`;
  await sql`DELETE FROM department_permissions WHERE tenant_id = ${TENANT_ID}`;
  await sql`DELETE FROM document_type_index_fields WHERE document_type_id = ${DOC_TYPE_ID}`;
  await sql`DELETE FROM document_types WHERE tenant_id = ${TENANT_ID}`;
  await sql`DELETE FROM departments WHERE tenant_id = ${TENANT_ID}`;
  await sql`DELETE FROM users WHERE tenant_id = ${TENANT_ID}`;
  await sql`DELETE FROM tenants WHERE id = ${TENANT_ID}`;

  await sql`INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active)
    VALUES (${TENANT_ID}, 'Empresa Teste', ${1_000_000}, ${10}, true)`;
  await sql`INSERT INTO users (id, tenant_id, email, password_hash, name, role)
    VALUES (${USER_ID}, ${TENANT_ID}, 'user@x.com', 'hash', 'User', 'USER')`;
  await sql`INSERT INTO departments (id, tenant_id, name, level)
    VALUES (${DEPT_ID}, ${TENANT_ID}, 'Dept', 0)`;
  await sql`INSERT INTO document_types (id, tenant_id, name, is_global)
    VALUES (${DOC_TYPE_ID}, ${TENANT_ID}, 'Tipo', false)`;
});

afterAll(async () => {
  await sql.end();
});

describe('backfillMissingDocumentEvents (run)', () => {
  it('cria um evento para documento sem document_events correspondente', async () => {
    const docId = 'eeee0000-0000-0000-0000-000000000001';
    await insertDocument(docId);

    await run(sql);

    expect(await countEvents(docId)).toBe(1);
    const [event] = await sql`SELECT * FROM document_events WHERE document_id = ${docId}`;
    expect(event?.['tenant_id']).toBe(TENANT_ID);
    expect(event?.['uploaded_by_id']).toBe(USER_ID);
    expect(event?.['event_type']).toBe('upload');
    expect(event?.['mime_type']).toBe('application/pdf');
    expect(event?.['document_type_id']).toBe(DOC_TYPE_ID);
    expect(event?.['document_type_name']).toBe('Tipo');
    expect(event?.['deduplicated']).toBe(false);
  });

  it('não duplica evento para documento que já tem document_events', async () => {
    const docId = 'eeee0000-0000-0000-0000-000000000002';
    await insertDocument(docId);
    await sql`INSERT INTO document_events (
        id, tenant_id, document_id, uploaded_by_id, mime_type, document_type_id,
        document_type_name, size_bytes
      ) VALUES (
        gen_random_uuid(), ${TENANT_ID}, ${docId}, ${USER_ID}, 'application/pdf',
        ${DOC_TYPE_ID}, 'Tipo', ${1234}
      )`;

    await run(sql);

    expect(await countEvents(docId)).toBe(1);
  });

  it('é idempotente: rodar duas vezes seguidas não insere nada na segunda execução', async () => {
    const docId = 'eeee0000-0000-0000-0000-000000000003';
    await insertDocument(docId);

    await run(sql);
    expect(await countEvents(docId)).toBe(1);

    await run(sql);
    expect(await countEvents(docId)).toBe(1);
  });

  it('cria evento para documento soft-deleted sem evento (não filtra deleted = false)', async () => {
    const docId = 'eeee0000-0000-0000-0000-000000000004';
    await insertDocument(docId, { deleted: true });

    await run(sql);

    expect(await countEvents(docId)).toBe(1);
  });
});
