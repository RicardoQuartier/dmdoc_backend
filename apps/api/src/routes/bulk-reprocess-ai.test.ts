import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, type TestDb } from '../test/helpers.js';
import type { S3Service } from '../services/s3.js';
import { newId } from '@dmdoc/db-pg';

/**
 * E2E do reprocessamento de IA em massa (épico E-4 / T-24):
 * `POST /documents/bulk-reprocess-ai` + `GET /documents/bulk-reprocess-ai/:batchId`.
 *
 * Foco: isolamento multi-tenant (não reprocessar/ver lote de outra empresa →
 * 404), teto de lote, gating por feature flags do tenant, e o registro/leitura
 * de progresso do lote. A fila é `null` (sem Redis) — o lote é criado, só não há
 * jobs enfileirados; isso é suficiente para exercitar toda a rota HTTP.
 */

function createMockS3(): S3Service {
  return {
    uploadFile: vi.fn().mockResolvedValue(undefined),
    getSignedDownloadUrl: vi.fn().mockResolvedValue('https://mock-signed-url'),
    deleteFile: vi.fn().mockResolvedValue(undefined),
  } as unknown as S3Service;
}

const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();
const ADMIN_A_ID = crypto.randomUUID();
const USER_A_ID = crypto.randomUUID();
const ADMIN_B_ID = crypto.randomUUID();
const DEPT_A_ID = newId();
const DEPT_B_ID = newId();
const PASSWORD = 'senha-forte-de-teste-123';
const DISK_QUOTA = 10 * 1024 * 1024;

let app: FastifyInstance;
let testDb: TestDb;
let tokenAdminA: string;
let tokenAdminB: string;
let tokenUserA: string;

let DOC_A1 = '';
let DOC_A2 = '';
let DOC_B1 = '';

async function login(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  return JSON.parse(res.body).accessToken as string;
}

async function seedDocument(tenantId: string, departmentId: string, uploadedById: string): Promise<string> {
  const id = newId();
  const hash = crypto.randomBytes(32).toString('hex');
  await testDb.db`
    INSERT INTO documents (
      id, tenant_id, department_id, document_type_id, filename, original_filename,
      content_hash, size_bytes, mime_type, s3_key, status, uploaded_by_id, uploaded_at,
      index_values, tags, deleted
    ) VALUES (
      ${id}, ${tenantId}, ${departmentId}, NULL, ${'f-' + id + '.pdf'}, 'doc.pdf',
      ${hash}, ${1234}, 'application/pdf', ${'s3/' + id}, 'READY', ${uploadedById}, NOW(),
      '{}'::jsonb, '{}'::text[], false
    )
  `;
  return id;
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = await buildApp({
    config: testConfig(),
    db: testDb.db,
    queue: null,
    aiReprocessQueue: null, // sem Redis — lote é criado, jobs não enfileirados
    s3: createMockS3(),
  });
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(async () => {
  vi.clearAllMocks();

  await testDb.db`DELETE FROM ai_reprocess_batch`;
  await testDb.db`DELETE FROM audit_logs`;
  await testDb.db`DELETE FROM document_content`;
  await testDb.db`DELETE FROM documents`;
  await testDb.db`DELETE FROM department_permissions`;
  await testDb.db`DELETE FROM departments`;
  await testDb.db`DELETE FROM users WHERE tenant_id IS NOT NULL OR role IN ('TENANT_ADMIN','UPLOADER','USER')`;
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
  await seedUser(testDb.db, { id: USER_A_ID, tenantId: TENANT_A, email: 'user-a@e.com', password: PASSWORD, role: 'USER' });
  await seedUser(testDb.db, { id: ADMIN_B_ID, tenantId: TENANT_B, email: 'admin-b@e.com', password: PASSWORD, role: 'TENANT_ADMIN' });

  DOC_A1 = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID);
  DOC_A2 = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID);
  DOC_B1 = await seedDocument(TENANT_B, DEPT_B_ID, ADMIN_B_ID);

  tokenAdminA = await login('admin-a@e.com');
  tokenAdminB = await login('admin-b@e.com');
  tokenUserA = await login('user-a@e.com');
});

describe('POST /documents/bulk-reprocess-ai', () => {
  it('TENANT_ADMIN dispara reprocessamento dos próprios documentos (202 + lote)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/documents/bulk-reprocess-ai',
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { documentIds: [DOC_A1, DOC_A2] },
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(2);
    // Flags default (todas ligadas) → todas as etapas.
    expect(body.steps.sort()).toEqual(['indexes', 'tags', 'title']);
    expect(typeof body.batchId).toBe('string');
  });

  it('respeita o subconjunto de steps pedido (apenas tags)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/documents/bulk-reprocess-ai',
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { documentIds: [DOC_A1], steps: ['tags'] },
    });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).steps).toEqual(['tags']);
  });

  it('ISOLAMENTO: não reprocessa documento de outra empresa (404, nunca 403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/documents/bulk-reprocess-ai',
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { documentIds: [DOC_A1, DOC_B1] },
    });
    expect(res.statusCode).toBe(404);
  });

  it('USER (somente-leitura) não pode disparar (404 — sem permissão de escrita)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/documents/bulk-reprocess-ai',
      headers: { authorization: `Bearer ${tokenUserA}` },
      payload: { documentIds: [DOC_A1] },
    });
    expect(res.statusCode).toBe(404);
  });

  it('nenhuma feature de IA habilitada para a empresa → 422', async () => {
    await testDb.db`
      UPDATE tenants
      SET ai_classification_enabled = false,
          ai_title_suggestion_enabled = false,
          ai_index_suggestion_enabled = false,
          ai_tag_generation_enabled = false
      WHERE id = ${TENANT_A}
    `;
    const res = await app.inject({
      method: 'POST',
      url: '/documents/bulk-reprocess-ai',
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { documentIds: [DOC_A1] },
    });
    expect(res.statusCode).toBe(422);
  });

  it('teto de lote: mais de 500 documentIds é rejeitado (validação)', async () => {
    const tooMany = Array.from({ length: 501 }, () => crypto.randomUUID());
    const res = await app.inject({
      method: 'POST',
      url: '/documents/bulk-reprocess-ai',
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { documentIds: tooMany },
    });
    expect([400, 422]).toContain(res.statusCode);
  });
});

describe('GET /documents/bulk-reprocess-ai/:batchId', () => {
  async function createBatch(token: string, documentIds: string[]): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/documents/bulk-reprocess-ai',
      headers: { authorization: `Bearer ${token}` },
      payload: { documentIds },
    });
    return JSON.parse(res.body).batchId as string;
  }

  it('devolve total/done/failed/status do lote (polling)', async () => {
    const batchId = await createBatch(tokenAdminA, [DOC_A1, DOC_A2]);
    const res = await app.inject({
      method: 'GET',
      url: `/documents/bulk-reprocess-ai/${batchId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.batchId).toBe(batchId);
    expect(body.total).toBe(2);
    expect(body.done).toBe(0);
    expect(body.failed).toBe(0);
    expect(body.status).toBe('running');
  });

  it('ISOLAMENTO: lote de outra empresa → 404', async () => {
    const batchId = await createBatch(tokenAdminA, [DOC_A1]);
    const res = await app.inject({
      method: 'GET',
      url: `/documents/bulk-reprocess-ai/${batchId}`,
      headers: { authorization: `Bearer ${tokenAdminB}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
