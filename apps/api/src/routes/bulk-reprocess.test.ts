import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, type TestDb, staticStorage } from '../test/helpers.js';
import type { StorageDriver } from '@dmdoc/storage';
import { newId } from '@dmdoc/db-pg';

/**
 * E2E do reprocessamento COMPLETO em massa (épico E-7 / T-91):
 * `POST /documents/bulk-reprocess` + `GET /documents/bulk-reprocess/:batchId`.
 *
 * Diferente do lote de IA (E-4), aqui o pipeline é integral e SÓ documentos em
 * `FAILED` são elegíveis. O foco dos testes:
 *   - gate de papel administrativo (UPLOADER/USER → 403 nas DUAS rotas);
 *   - elegibilidade: READY/PENDING/PROCESSING são pulados EM SILÊNCIO e, o
 *     mais importante, NADA neles é tocado (o READY mantém `document_content`
 *     e `chunks` — se perder, os DELETEs foram aplicados à seleção inteira);
 *   - isolamento multi-tenant (documento e lote de outra empresa → 404, e
 *     nenhuma escrita antes do 404);
 *   - dedupe de ids em `requested`/`total`;
 *   - progresso DERIVADO de `documents.status` (nada de contador persistido);
 *   - compensação quando o enfileiramento falha (volta a FAILED + 502).
 *
 * A fila é `null` por padrão (sem Redis) — o lote é criado, só não há jobs
 * enfileirados; isso é suficiente para exercitar toda a rota HTTP. O teste de
 * compensação injeta uma fila falsa cujo `addBulk` rejeita.
 */

function createMockS3(): StorageDriver {
  return {
    provider: 's3',
    put: vi.fn().mockResolvedValue(undefined),
    getDownloadUrl: vi.fn().mockResolvedValue('https://mock-signed-url'),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as StorageDriver;
}

const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();
const ADMIN_A_ID = crypto.randomUUID();
const UPLOADER_A_ID = crypto.randomUUID();
const USER_A_ID = crypto.randomUUID();
const ADMIN_B_ID = crypto.randomUUID();
const MTA_ID = crypto.randomUUID();
const DEPT_A_ID = newId();
const DEPT_B_ID = newId();
const PASSWORD = 'senha-forte-de-teste-123';
const DISK_QUOTA = 10 * 1024 * 1024;
const ZERO_EMBEDDING = `[${new Array(1536).fill(0).join(',')}]`;

let app: FastifyInstance;
let testDb: TestDb;
let tokenAdminA: string;
let tokenAdminB: string;
let tokenUploaderA: string;
let tokenUserA: string;
let tokenMta: string;

// Documentos da empresa A: 2 em FAILED, 1 READY (com conteúdo), 1 PENDING.
let FAILED_1 = '';
let FAILED_2 = '';
let READY_1 = '';
let PENDING_1 = '';
// Documento em FAILED da empresa B (com conteúdo, para provar que nada é
// escrito antes do 404 de isolamento).
let FAILED_B = '';

async function login(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  return JSON.parse(res.body).accessToken as string;
}

type DocStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';

async function seedDocument(
  tenantId: string,
  departmentId: string,
  uploadedById: string,
  status: DocStatus,
  failureReason: string | null = null
): Promise<string> {
  const id = newId();
  const hash = crypto.randomBytes(32).toString('hex');
  await testDb.db`
    INSERT INTO documents (
      id, tenant_id, department_id, document_type_id, filename, original_filename,
      content_hash, size_bytes, mime_type, storage_key, status, failure_reason,
      uploaded_by_id, uploaded_at, index_values, tags, deleted
    ) VALUES (
      ${id}, ${tenantId}, ${departmentId}, NULL, ${'f-' + id + '.pdf'}, 'doc.pdf',
      ${hash}, ${1234}, 'application/pdf', ${'s3/' + id}, ${status}, ${failureReason},
      ${uploadedById}, NOW(), '{}'::jsonb, '{}'::text[], false
    )
  `;
  return id;
}

/** Semeia `document_content` + 1 chunk — o conteúdo que o lote NÃO pode apagar. */
async function seedContent(documentId: string, tenantId: string, departmentId: string): Promise<void> {
  await testDb.db`
    INSERT INTO document_content (document_id, tenant_id, full_text, extraction)
    VALUES (
      ${documentId}, ${tenantId}, 'texto extraido',
      ${testDb.db.json({
        engine: 'native',
        engineVersion: '1.0.0',
        durationMs: 10,
        ocrPages: [],
        pageCount: 1,
        extractedAt: new Date().toISOString(),
      })}
    )
  `;
  await testDb.db`
    INSERT INTO chunks (id, document_id, tenant_id, department_id, chunk_index, text, embedding, token_count)
    VALUES (${newId()}, ${documentId}, ${tenantId}, ${departmentId}, 0, 'trecho de teste', ${ZERO_EMBEDDING}::vector, 3)
  `;
}

async function countRows(table: 'document_content' | 'chunks', documentId: string): Promise<number> {
  const rows = await testDb.db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ${testDb.db(table)} WHERE document_id = ${documentId}
  `;
  return Number(rows[0]?.n ?? 0);
}

async function readDoc(id: string): Promise<{ status: string; failure_reason: string | null }> {
  const rows = await testDb.db<{ status: string; failure_reason: string | null }[]>`
    SELECT status, failure_reason FROM documents WHERE id = ${id}
  `;
  return rows[0]!;
}

async function countBatches(): Promise<number> {
  const rows = await testDb.db<{ n: number }[]>`SELECT count(*)::int AS n FROM document_reprocess_batch`;
  return Number(rows[0]?.n ?? 0);
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = await buildApp({
    config: testConfig(),
    db: testDb.db,
    queue: null, // sem Redis — lote é criado, jobs não enfileirados
    aiReprocessQueue: null,
    storage: staticStorage(createMockS3()),
  });
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(async () => {
  vi.clearAllMocks();

  await testDb.db`DELETE FROM document_reprocess_batch`;
  await testDb.db`DELETE FROM audit_logs`;
  await testDb.db`DELETE FROM chunks`;
  await testDb.db`DELETE FROM document_content`;
  await testDb.db`DELETE FROM documents`;
  await testDb.db`DELETE FROM department_permissions`;
  await testDb.db`DELETE FROM departments`;
  await testDb.db`DELETE FROM users WHERE tenant_id IS NOT NULL OR role IN ('TENANT_ADMIN','UPLOADER','USER','MULTI_TENANT_ADMIN')`;
  await testDb.db`DELETE FROM tenants WHERE id IN (${TENANT_A}, ${TENANT_B})`;

  await testDb.db`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
    VALUES
      (${TENANT_A}, 'Empresa A', ${DISK_QUOTA}, 20, true, NOW()),
      (${TENANT_B}, 'Empresa B', ${DISK_QUOTA}, 20, true, NOW())
  `;
  await testDb.db`
    INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
    VALUES
      (${DEPT_A_ID}, ${TENANT_A}, NULL, 'Financeiro A', 0, '{}'::text[], false, NOW()),
      (${DEPT_B_ID}, ${TENANT_B}, NULL, 'Financeiro B', 0, '{}'::text[], false, NOW())
  `;

  await seedUser(testDb.db, { id: ADMIN_A_ID, tenantId: TENANT_A, email: 'admin-a@e.com', password: PASSWORD, role: 'TENANT_ADMIN' });
  await seedUser(testDb.db, { id: UPLOADER_A_ID, tenantId: TENANT_A, email: 'uploader-a@e.com', password: PASSWORD, role: 'UPLOADER' });
  await seedUser(testDb.db, { id: USER_A_ID, tenantId: TENANT_A, email: 'user-a@e.com', password: PASSWORD, role: 'USER' });
  await seedUser(testDb.db, { id: ADMIN_B_ID, tenantId: TENANT_B, email: 'admin-b@e.com', password: PASSWORD, role: 'TENANT_ADMIN' });
  // MTA com acesso APENAS à empresa B — usado para provar o 404 no status de
  // um lote da empresa A.
  await seedUser(testDb.db, {
    id: MTA_ID,
    tenantId: null,
    email: 'mta@e.com',
    password: PASSWORD,
    role: 'MULTI_TENANT_ADMIN',
    allowedTenantIds: [TENANT_B],
  });

  // ACL legítima de ESCRITA do UPLOADER no departamento A: garante que o 403 do
  // lote vem do gate de papel, não de falta de permissão no departamento.
  await testDb.db`
    INSERT INTO department_permissions (user_id, department_id, tenant_id, can_read, can_write)
    VALUES (${UPLOADER_A_ID}, ${DEPT_A_ID}, ${TENANT_A}, true, true)
    ON CONFLICT (user_id, department_id) WHERE deleted = false DO NOTHING
  `;

  FAILED_1 = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID, 'FAILED', 'timeout do LLM');
  FAILED_2 = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID, 'FAILED', 'sem crédito');
  READY_1 = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID, 'READY');
  PENDING_1 = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID, 'PENDING');
  FAILED_B = await seedDocument(TENANT_B, DEPT_B_ID, ADMIN_B_ID, 'FAILED', 'timeout do LLM');

  await seedContent(READY_1, TENANT_A, DEPT_A_ID);
  await seedContent(FAILED_B, TENANT_B, DEPT_B_ID);

  tokenAdminA = await login('admin-a@e.com');
  tokenAdminB = await login('admin-b@e.com');
  tokenUploaderA = await login('uploader-a@e.com');
  tokenUserA = await login('user-a@e.com');
  tokenMta = await login('mta@e.com');
});

function post(token: string, documentIds: string[]) {
  return app.inject({
    method: 'POST',
    url: '/documents/bulk-reprocess',
    headers: { authorization: `Bearer ${token}` },
    payload: { documentIds },
  });
}

describe('POST /documents/bulk-reprocess — elegibilidade e não-destrutividade', () => {
  it('seleção mista (2 FAILED + 1 READY + 1 PENDING): 202 com total 2 e skipped 2', async () => {
    const res = await post(tokenAdminA, [FAILED_1, FAILED_2, READY_1, PENDING_1]);

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.requested).toBe(4);
    expect(body.total).toBe(2);
    expect(body.skipped).toBe(2);
    expect(body.skippedByStatus).toEqual({ READY: 1, PENDING: 1 });
    expect(typeof body.batchId).toBe('string');

    // O lote guarda SÓ os dois elegíveis.
    const rows = await testDb.db<{ document_ids: string[]; total: number; skipped: number }[]>`
      SELECT document_ids, total, skipped FROM document_reprocess_batch WHERE id = ${body.batchId}
    `;
    expect(rows[0]!.total).toBe(2);
    expect(rows[0]!.skipped).toBe(2);
    expect([...rows[0]!.document_ids].sort()).toEqual([FAILED_1, FAILED_2].sort());
  });

  it('o READY selecionado junto NÃO é tocado: segue READY com conteúdo e chunks intactos', async () => {
    const res = await post(tokenAdminA, [FAILED_1, FAILED_2, READY_1, PENDING_1]);
    expect(res.statusCode).toBe(202);

    // O bug clássico seria aplicar os DELETEs sobre a seleção inteira.
    const ready = await readDoc(READY_1);
    expect(ready.status).toBe('READY');
    expect(await countRows('document_content', READY_1)).toBe(1);
    expect(await countRows('chunks', READY_1)).toBe(1);

    // O PENDING também segue intocado.
    expect((await readDoc(PENDING_1)).status).toBe('PENDING');

    // Os elegíveis foram para PENDING, sem failure_reason e sem conteúdo.
    for (const id of [FAILED_1, FAILED_2]) {
      const doc = await readDoc(id);
      expect(doc.status).toBe('PENDING');
      expect(doc.failure_reason).toBeNull();
      expect(await countRows('document_content', id)).toBe(0);
      expect(await countRows('chunks', id)).toBe(0);
    }
  });

  it('apaga o conteúdo anterior do documento em falha que ainda tinha texto/chunks', async () => {
    await seedContent(FAILED_1, TENANT_A, DEPT_A_ID);
    expect(await countRows('chunks', FAILED_1)).toBe(1);

    const res = await post(tokenAdminA, [FAILED_1]);
    expect(res.statusCode).toBe(202);

    expect(await countRows('document_content', FAILED_1)).toBe(0);
    expect(await countRows('chunks', FAILED_1)).toBe(0);
  });

  it('seleção só com READY → 422 e nenhum lote criado', async () => {
    const res = await post(tokenAdminA, [READY_1]);

    expect(res.statusCode).toBe(422);
    expect(await countBatches()).toBe(0);
    // Nada tocado.
    expect((await readDoc(READY_1)).status).toBe('READY');
    expect(await countRows('document_content', READY_1)).toBe(1);
    expect(await countRows('chunks', READY_1)).toBe(1);
  });

  it('ids duplicados contam uma vez só em requested e total', async () => {
    const res = await post(tokenAdminA, [FAILED_1, FAILED_1, FAILED_2, FAILED_2, FAILED_1]);

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.requested).toBe(2);
    expect(body.total).toBe(2);
    expect(body.skipped).toBe(0);
    expect(body.skippedByStatus).toEqual({});

    const rows = await testDb.db<{ document_ids: string[] }[]>`
      SELECT document_ids FROM document_reprocess_batch WHERE id = ${body.batchId}
    `;
    expect(rows[0]!.document_ids).toHaveLength(2);
  });

  it('teto de lote: mais de 500 documentIds é rejeitado (validação)', async () => {
    const tooMany = Array.from({ length: 501 }, () => crypto.randomUUID());
    const res = await post(tokenAdminA, tooMany);
    expect([400, 422]).toContain(res.statusCode);
  });

  it('grava audit log document.bulk_reprocess com o resource do lote', async () => {
    const res = await post(tokenAdminA, [FAILED_1, FAILED_2, READY_1]);
    const { batchId } = JSON.parse(res.body);

    const logs = await testDb.db<{ action: string; resource: string; metadata: string }[]>`
      SELECT action, resource, metadata FROM audit_logs WHERE action = 'document.bulk_reprocess'
    `;
    expect(logs).toHaveLength(1);
    expect(logs[0]!.resource).toBe(`documents/bulk-reprocess/${batchId}`);
    // `metadata` é jsonb gravado com JSON.stringify (ver auth/audit.ts) — a
    // leitura devolve a string JSON crua.
    expect(JSON.parse(logs[0]!.metadata)).toMatchObject({ batchId, requested: 3, total: 2, skipped: 1 });
  });
});

describe('POST /documents/bulk-reprocess — permissão e isolamento', () => {
  it('USER (somente-leitura) → 403 mesmo com ids válidos', async () => {
    const res = await post(tokenUserA, [FAILED_1]);
    expect(res.statusCode).toBe(403);
    expect(await countBatches()).toBe(0);
    // Gate antes de qualquer leitura/escrita: o documento segue FAILED.
    expect((await readDoc(FAILED_1)).status).toBe('FAILED');
  });

  it('UPLOADER com ACL de escrita no departamento AINDA ASSIM não dispara lote (403)', async () => {
    const res = await post(tokenUploaderA, [FAILED_1, FAILED_2]);
    expect(res.statusCode).toBe(403);
    expect(await countBatches()).toBe(0);
    expect((await readDoc(FAILED_1)).status).toBe('FAILED');
  });

  it('ISOLAMENTO: id de outra empresa → 404 e nada é escrito', async () => {
    const res = await post(tokenAdminA, [FAILED_1, FAILED_B]);

    expect(res.statusCode).toBe(404);
    expect(await countBatches()).toBe(0);
    // O documento da empresa B segue FAILED e com conteúdo intacto...
    const docB = await readDoc(FAILED_B);
    expect(docB.status).toBe('FAILED');
    expect(await countRows('document_content', FAILED_B)).toBe(1);
    expect(await countRows('chunks', FAILED_B)).toBe(1);
    // ...e o documento válido da empresa A também não foi tocado.
    expect((await readDoc(FAILED_1)).status).toBe('FAILED');
  });

  it('id inexistente na seleção → 404 e nada é escrito', async () => {
    const res = await post(tokenAdminA, [FAILED_1, crypto.randomUUID()]);
    expect(res.statusCode).toBe(404);
    expect(await countBatches()).toBe(0);
    expect((await readDoc(FAILED_1)).status).toBe('FAILED');
  });
});

describe('POST /documents/bulk-reprocess — compensação de enfileiramento', () => {
  it('addBulk falhando devolve os documentos a FAILED e responde 502', async () => {
    const failingQueue = {
      addBulk: vi.fn().mockRejectedValue(new Error('redis fora do ar')),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Queue;

    const appWithQueue = await buildApp({
      config: testConfig(),
      db: testDb.db,
      queue: failingQueue,
      aiReprocessQueue: null,
      storage: staticStorage(createMockS3()),
    });

    try {
      const res = await appWithQueue.inject({
        method: 'POST',
        url: '/documents/bulk-reprocess',
        headers: { authorization: `Bearer ${tokenAdminA}` },
        payload: { documentIds: [FAILED_1, FAILED_2] },
      });

      expect(res.statusCode).toBe(502);
      for (const id of [FAILED_1, FAILED_2]) {
        const doc = await readDoc(id);
        expect(doc.status).toBe('FAILED');
        expect(doc.failure_reason).toBe('Falha ao enfileirar reprocessamento em lote');
      }
    } finally {
      await appWithQueue.close();
    }
  });

  it('fila configurada: enfileira 1 job process-document por elegível, sem priority', async () => {
    const addBulk = vi.fn().mockResolvedValue([]);
    const okQueue = { addBulk, close: vi.fn().mockResolvedValue(undefined) } as unknown as Queue;

    const appWithQueue = await buildApp({
      config: testConfig(),
      db: testDb.db,
      queue: okQueue,
      aiReprocessQueue: null,
      storage: staticStorage(createMockS3()),
    });

    try {
      const res = await appWithQueue.inject({
        method: 'POST',
        url: '/documents/bulk-reprocess',
        headers: { authorization: `Bearer ${tokenAdminA}` },
        payload: { documentIds: [FAILED_1, READY_1] },
      });

      expect(res.statusCode).toBe(202);
      expect(addBulk).toHaveBeenCalledTimes(1);
      const jobs = addBulk.mock.calls[0]![0] as Array<{
        name: string;
        data: { documentId: string; tenantId: string };
        opts: Record<string, unknown>;
      }>;
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.name).toBe('process-document');
      expect(jobs[0]!.data.documentId).toBe(FAILED_1);
      expect(jobs[0]!.data.tenantId).toBe(TENANT_A);
      expect(jobs[0]!.opts).toEqual({ attempts: 3, backoff: { type: 'exponential', delay: 2000 } });
      expect(jobs[0]!.opts['priority']).toBeUndefined();
    } finally {
      await appWithQueue.close();
    }
  });
});

describe('GET /documents/bulk-reprocess/:batchId', () => {
  async function createBatch(token: string, documentIds: string[]): Promise<string> {
    const res = await post(token, documentIds);
    return JSON.parse(res.body).batchId as string;
  }

  it('progresso DERIVADO de documents.status (running → completed)', async () => {
    const batchId = await createBatch(tokenAdminA, [FAILED_1, FAILED_2, READY_1]);

    const running = await app.inject({
      method: 'GET',
      url: `/documents/bulk-reprocess/${batchId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(running.statusCode).toBe(200);
    const body = JSON.parse(running.body);
    expect(body.batchId).toBe(batchId);
    expect(body).toMatchObject({
      total: 2,
      done: 0,
      failed: 0,
      pending: 2,
      skipped: 1,
      status: 'running',
      stalled: false,
    });
    expect(typeof body.createdAt).toBe('string');

    // Simula o worker concluindo um e falhando o outro — sem nenhum contador
    // persistido, o progresso muda só por causa de documents.status.
    await testDb.db`UPDATE documents SET status = 'READY' WHERE id = ${FAILED_1}`;
    await testDb.db`UPDATE documents SET status = 'FAILED' WHERE id = ${FAILED_2}`;

    const done = await app.inject({
      method: 'GET',
      url: `/documents/bulk-reprocess/${batchId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(JSON.parse(done.body)).toMatchObject({
      total: 2,
      done: 1,
      failed: 1,
      pending: 0,
      status: 'completed',
    });
  });

  it('ISOLAMENTO: TENANT_ADMIN de outra empresa lendo o lote → 404', async () => {
    const batchId = await createBatch(tokenAdminA, [FAILED_1]);
    const res = await app.inject({
      method: 'GET',
      url: `/documents/bulk-reprocess/${batchId}`,
      headers: { authorization: `Bearer ${tokenAdminB}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('ISOLAMENTO: MTA sem o tenant do lote na lista → 404', async () => {
    const batchId = await createBatch(tokenAdminA, [FAILED_1]);
    const res = await app.inject({
      method: 'GET',
      url: `/documents/bulk-reprocess/${batchId}`,
      headers: { authorization: `Bearer ${tokenMta}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('lote inexistente → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/documents/bulk-reprocess/${crypto.randomUUID()}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('UPLOADER e USER do próprio tenant não leem o progresso do lote (403)', async () => {
    const batchId = await createBatch(tokenAdminA, [FAILED_1]);

    for (const token of [tokenUploaderA, tokenUserA]) {
      const res = await app.inject({
        method: 'GET',
        url: `/documents/bulk-reprocess/${batchId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
    }
  });
});
