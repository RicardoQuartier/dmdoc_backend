import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import {
  createDocumentReprocessBatch,
  deriveDocumentReprocessBatchProgress,
  getDocumentReprocessBatch,
  getDocumentReprocessBatchGlobal,
  getDocumentReprocessBatchInTenants,
} from './document-reprocess-batch.js';

/**
 * Testes de integração dos helpers do lote de reprocessamento COMPLETO
 * (épico E-7) contra um PostgreSQL real (`dmdoc_test`, com a migration
 * 0016_document_reprocess_batch.sql aplicada pelo globalSetup).
 *
 * Cobrem: criação, isolamento multi-tenant na leitura (lote de outra empresa →
 * null) e — o coração da feature — a DERIVAÇÃO do progresso a partir de
 * `documents.status`, incluindo o caso do documento apagado fisicamente
 * (`gone`), que precisa contar como falha para o lote FECHAR em vez de travar.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test';

const sql: Sql = postgres(DATABASE_URL);

const TENANT_A = 'd0c8b000-0000-0000-0000-0000000000a1';
const TENANT_B = 'd0c8b000-0000-0000-0000-0000000000b2';
const USER_A = 'd0c8b000-0000-0000-0000-0000000000c3';
const DEPT_A = 'd0c8b000-0000-0000-0000-0000000000d4';

const DOC_1 = 'd0c8b000-0000-0000-0000-000000000101';
const DOC_2 = 'd0c8b000-0000-0000-0000-000000000102';
const DOC_3 = 'd0c8b000-0000-0000-0000-000000000103';

type DocStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';

async function insertDocument(
  id: string,
  status: DocStatus,
  opts: { deleted?: boolean } = {},
): Promise<void> {
  await sql`
    INSERT INTO documents (
      id, tenant_id, department_id, filename, original_filename,
      content_hash, size_bytes, mime_type, s3_key, status, uploaded_by_id, deleted
    ) VALUES (
      ${id}, ${TENANT_A}, ${DEPT_A}, 'f.pdf', 'f.pdf',
      ${`hash-${id}`}, ${1234}, 'application/pdf', ${`tenants/${TENANT_A}/${id}`},
      ${status}, ${USER_A}, ${opts.deleted ?? false}
    )
  `;
}

/** Cria o lote sobre os documentos informados (total = quantidade). */
async function createBatchFor(documentIds: string[], skipped = 0) {
  return createDocumentReprocessBatch(sql, {
    tenantId: TENANT_A,
    createdBy: USER_A,
    documentIds,
    total: documentIds.length,
    skipped,
  });
}

async function cleanup(): Promise<void> {
  await sql`DELETE FROM document_reprocess_batch WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM chunks WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM document_content WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM document_events WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM documents WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM department_permissions WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM departments WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM users WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM tenants WHERE id IN (${TENANT_A}, ${TENANT_B})`;
}

beforeAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await cleanup();
  await sql`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota)
    VALUES
      (${TENANT_A}, 'Empresa A (reprocess)', ${1_000_000}, ${10}),
      (${TENANT_B}, 'Empresa B (reprocess)', ${1_000_000}, ${10})
  `;
  await sql`
    INSERT INTO users (id, tenant_id, email, password_hash, name, role)
    VALUES (${USER_A}, ${TENANT_A}, 'reprocess-a@test.dev', 'x', 'Ator A', 'TENANT_ADMIN')
  `;
  await sql`
    INSERT INTO departments (id, tenant_id, name, level)
    VALUES (${DEPT_A}, ${TENANT_A}, 'Dept A', 0)
  `;
});

afterAll(async () => {
  await cleanup();
  await sql.end();
});

describe('createDocumentReprocessBatch', () => {
  it('cria o lote preservando document_ids, total e skipped', async () => {
    const batch = await createBatchFor([DOC_1, DOC_2], 3);

    expect(batch.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(batch.tenantId).toBe(TENANT_A);
    expect(batch.createdBy).toBe(USER_A);
    expect(batch.documentIds).toEqual([DOC_1, DOC_2]);
    expect(batch.total).toBe(2);
    expect(batch.skipped).toBe(3);
    expect(batch.createdAt).toBeInstanceOf(Date);
  });

  it('a tabela não tem colunas de contador (progresso é derivado)', async () => {
    const rows = await sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'document_reprocess_batch'
    `;
    const columns = rows.map((r) => r.column_name).sort();
    expect(columns).toEqual([
      'created_at',
      'created_by',
      'document_ids',
      'id',
      'skipped',
      'tenant_id',
      'total',
    ]);
  });
});

describe('leitura escopada por tenant', () => {
  it('getDocumentReprocessBatch não devolve lote de outra empresa (isolamento)', async () => {
    const batch = await createBatchFor([DOC_1]);

    expect((await getDocumentReprocessBatch(sql, TENANT_A, batch.id))?.id).toBe(batch.id);
    // Tenant B tentando ler o lote de A → null (a rota mapeia para 404).
    expect(await getDocumentReprocessBatch(sql, TENANT_B, batch.id)).toBeNull();
  });

  it('getDocumentReprocessBatchGlobal (SUPER_ADMIN) enxerga qualquer empresa', async () => {
    const batch = await createBatchFor([DOC_1]);
    expect((await getDocumentReprocessBatchGlobal(sql, batch.id))?.id).toBe(batch.id);
  });

  it('getDocumentReprocessBatchInTenants respeita a lista de empresas (MTA)', async () => {
    const batch = await createBatchFor([DOC_1]);
    expect((await getDocumentReprocessBatchInTenants(sql, [TENANT_A], batch.id))?.id).toBe(
      batch.id,
    );
    expect(await getDocumentReprocessBatchInTenants(sql, [TENANT_B], batch.id)).toBeNull();
  });

  it('getDocumentReprocessBatchInTenants com lista vazia devolve null SEM consultar o banco', async () => {
    // Um `sql` que explode se for chamado: prova o curto-circuito.
    const explodingSql = new Proxy({} as Sql, {
      get() {
        throw new Error('não deveria consultar o banco com lista de tenants vazia');
      },
      apply() {
        throw new Error('não deveria consultar o banco com lista de tenants vazia');
      },
    });

    await expect(
      getDocumentReprocessBatchInTenants(explodingSql, [], 'd0c8b000-0000-0000-0000-0000000000ff'),
    ).resolves.toBeNull();
  });
});

describe('deriveDocumentReprocessBatchProgress', () => {
  it('deriva done/failed/pending de documents.status (1 READY, 1 FAILED, 1 PENDING)', async () => {
    await insertDocument(DOC_1, 'READY');
    await insertDocument(DOC_2, 'FAILED');
    await insertDocument(DOC_3, 'PENDING');
    const batch = await createBatchFor([DOC_1, DOC_2, DOC_3]);

    const progress = await deriveDocumentReprocessBatchProgress(sql, batch);

    expect(progress).toEqual({
      total: 3,
      done: 1,
      failed: 1,
      pending: 1,
      status: 'running',
      stalled: false,
    });
  });

  it('PROCESSING conta como pending e mantém o lote running', async () => {
    await insertDocument(DOC_1, 'READY');
    await insertDocument(DOC_2, 'PROCESSING');
    const batch = await createBatchFor([DOC_1, DOC_2]);

    const progress = await deriveDocumentReprocessBatchProgress(sql, batch);

    expect(progress.pending).toBe(1);
    expect(progress.done).toBe(1);
    expect(progress.status).toBe('running');
  });

  it('todos READY → status completed', async () => {
    await insertDocument(DOC_1, 'READY');
    await insertDocument(DOC_2, 'READY');
    await insertDocument(DOC_3, 'READY');
    const batch = await createBatchFor([DOC_1, DOC_2, DOC_3]);

    const progress = await deriveDocumentReprocessBatchProgress(sql, batch);

    expect(progress).toEqual({
      total: 3,
      done: 3,
      failed: 0,
      pending: 0,
      status: 'completed',
      stalled: false,
    });
  });

  it('todos FAILED → completed (lote encerrado, tudo em falha)', async () => {
    await insertDocument(DOC_1, 'FAILED');
    await insertDocument(DOC_2, 'FAILED');
    const batch = await createBatchFor([DOC_1, DOC_2]);

    const progress = await deriveDocumentReprocessBatchProgress(sql, batch);

    expect(progress.failed).toBe(2);
    expect(progress.pending).toBe(0);
    expect(progress.status).toBe('completed');
  });

  it('documento APAGADO do banco conta em failed (gone) e o lote FECHA em vez de travar', async () => {
    await insertDocument(DOC_1, 'READY');
    await insertDocument(DOC_2, 'READY');
    await insertDocument(DOC_3, 'PENDING');
    const batch = await createBatchFor([DOC_1, DOC_2, DOC_3]);

    // Antes: o pendente segura o lote em running.
    expect((await deriveDocumentReprocessBatchProgress(sql, batch)).status).toBe('running');

    // O documento pendente some fisicamente (purga) enquanto o lote roda.
    await sql`DELETE FROM documents WHERE id = ${DOC_3}`;

    const progress = await deriveDocumentReprocessBatchProgress(sql, batch);
    expect(progress).toEqual({
      total: 3,
      done: 2,
      failed: 1,
      pending: 0,
      status: 'completed',
      stalled: false,
    });
  });

  it('documento soft-deleted continua contando pelo status real (derivação não filtra deleted)', async () => {
    await insertDocument(DOC_1, 'READY', { deleted: true });
    await insertDocument(DOC_2, 'READY');
    const batch = await createBatchFor([DOC_1, DOC_2]);

    const progress = await deriveDocumentReprocessBatchProgress(sql, batch);

    // Se a query filtrasse `deleted = false`, o DOC_1 viraria `gone` e cairia
    // em `failed` — um documento que na verdade concluiu com sucesso.
    expect(progress.done).toBe(2);
    expect(progress.failed).toBe(0);
    expect(progress.status).toBe('completed');
  });

  it('documento de OUTRA empresa no lote não é contado (escopo por tenant na derivação)', async () => {
    await insertDocument(DOC_1, 'READY');
    const batch = await createDocumentReprocessBatch(sql, {
      tenantId: TENANT_B, // lote de B apontando para documento de A
      createdBy: USER_A,
      documentIds: [DOC_1],
      total: 1,
      skipped: 0,
    });

    const progress = await deriveDocumentReprocessBatchProgress(sql, batch);

    // O documento existe, mas é de outra empresa → não entra na agregação e
    // vira `gone` (failed), nunca `done`.
    expect(progress.done).toBe(0);
    expect(progress.failed).toBe(1);
  });

  it('stalled: pendências vivas há mais de 30 min sinalizam worker travado (sem forjar completed)', async () => {
    await insertDocument(DOC_1, 'PENDING');
    const batch = await createBatchFor([DOC_1]);

    expect((await deriveDocumentReprocessBatchProgress(sql, batch)).stalled).toBe(false);

    const old = {
      ...batch,
      createdAt: new Date(Date.now() - 31 * 60 * 1000),
    };
    const progress = await deriveDocumentReprocessBatchProgress(sql, old);
    expect(progress.stalled).toBe(true);
    // `stalled` NÃO fecha o lote — só avisa a UI para parar o polling.
    expect(progress.status).toBe('running');
  });

  it('stalled é false quando não há pendência, por mais antigo que seja o lote', async () => {
    await insertDocument(DOC_1, 'READY');
    const batch = await createBatchFor([DOC_1]);

    const progress = await deriveDocumentReprocessBatchProgress(sql, {
      ...batch,
      createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    expect(progress.status).toBe('completed');
    expect(progress.stalled).toBe(false);
  });
});
