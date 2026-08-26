import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, resetDomainTables, type TestDb, staticStorage } from '../test/helpers.js';
import type { StorageDriver } from '@dmdoc/storage';
import { newId } from '@dmdoc/db-pg';

/**
 * E2E de `GET /reports/deletions` — relatório de auditoria de exclusões
 * (TENANT_ADMIN+). Exercita as rotas REAIS de exclusão (`DELETE
 * /documents/:id` e `POST /documents/bulk-delete`) para gerar os `audit_logs`
 * — não escreve fixtures de auditoria à mão — porque o comportamento
 * "1 linha por ARQUIVO, não por evento" depende de como esses dois endpoints
 * realmente gravam `metadata` (ver auth/audit.ts, `sql.json()`).
 */

function createMockS3(): StorageDriver {
  return {
    provider: 's3',
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(Buffer.from('conteudo de teste')),
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
const SUPER_ID = crypto.randomUUID();
const MTA_ID = crypto.randomUUID();
const DEPT_A_ID = newId();
const DEPT_B_ID = newId();
const PASSWORD = 'senha-forte-de-teste-123';
const DISK_QUOTA = 10 * 1024 * 1024;

let app: FastifyInstance;
let s3Mock: StorageDriver;
let testDb: TestDb;
let tokenAdminA: string;
let tokenUploaderA: string;
let tokenUserA: string;
let tokenSuper: string;
let tokenMta: string;

async function login(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  return (JSON.parse(res.body) as { accessToken: string }).accessToken;
}

async function seedDocument(
  tenantId: string,
  departmentId: string,
  uploadedById: string,
  overrides: { originalFilename?: string; title?: string | null } = {}
): Promise<string> {
  const id = newId();
  const hash = crypto.randomBytes(32).toString('hex');
  const originalFilename = overrides.originalFilename ?? 'doc.pdf';
  const title = overrides.title ?? null;
  await testDb.db`
    INSERT INTO documents (
      id, tenant_id, department_id, document_type_id, filename, original_filename, title,
      content_hash, size_bytes, mime_type, storage_key, status, failure_reason,
      uploaded_by_id, uploaded_at, index_values, tags, deleted
    ) VALUES (
      ${id}, ${tenantId}, ${departmentId}, NULL, ${'f-' + id + '.pdf'}, ${originalFilename}, ${title},
      ${hash}, ${1234}, 'application/pdf', ${'s3/' + id}, 'READY', NULL,
      ${uploadedById}, NOW(), '{}'::jsonb, '{}'::text[], false
    )
  `;
  return id;
}

async function deleteOne(token: string, documentId: string): Promise<number> {
  const res = await app.inject({
    method: 'DELETE',
    url: `/documents/${documentId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  return res.statusCode;
}

async function bulkDelete(token: string, documentIds: string[]): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: '/documents/bulk-delete',
    headers: { authorization: `Bearer ${token}` },
    payload: { documentIds },
  });
  return res.statusCode;
}

interface DeletionItem {
  documentId: string;
  filename: string | null;
  action: 'document.delete' | 'document.bulk_delete';
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  deletedAt: string;
  restorable: boolean;
}

interface DeletionsReport {
  items: DeletionItem[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

function getReport(
  token: string,
  query: Record<string, string> = {}
): Promise<{ statusCode: number; body: DeletionsReport }> {
  const qs = new URLSearchParams(query).toString();
  return app
    .inject({
      method: 'GET',
      url: `/reports/deletions${qs ? `?${qs}` : ''}`,
      headers: { authorization: `Bearer ${token}` },
    })
    .then((res) => ({ statusCode: res.statusCode, body: res.json() as DeletionsReport }));
}

beforeAll(async () => {
  testDb = await startTestDb();
  s3Mock = createMockS3();
  app = await buildApp({
    config: testConfig(),
    db: testDb.db,
    queue: null,
    aiReprocessQueue: null,
    storage: staticStorage(s3Mock),
  });
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDomainTables(testDb.db);

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

  await seedUser(testDb.db, { id: ADMIN_A_ID, tenantId: TENANT_A, email: 'admin-a@e.com', password: PASSWORD, role: 'TENANT_ADMIN', name: 'Admin A' });
  await seedUser(testDb.db, { id: UPLOADER_A_ID, tenantId: TENANT_A, email: 'uploader-a@e.com', password: PASSWORD, role: 'UPLOADER', name: 'Uploader A' });
  await seedUser(testDb.db, { id: USER_A_ID, tenantId: TENANT_A, email: 'user-a@e.com', password: PASSWORD, role: 'USER', name: 'User A' });
  await seedUser(testDb.db, { id: ADMIN_B_ID, tenantId: TENANT_B, email: 'admin-b@e.com', password: PASSWORD, role: 'TENANT_ADMIN', name: 'Admin B' });
  await seedUser(testDb.db, { id: SUPER_ID, tenantId: null, email: 'super@plataforma.com', password: PASSWORD, role: 'SUPER_ADMIN', name: 'Super' });
  await seedUser(testDb.db, {
    id: MTA_ID,
    tenantId: null,
    email: 'mta@e.com',
    password: PASSWORD,
    role: 'MULTI_TENANT_ADMIN',
    allowedTenantIds: [TENANT_A],
    name: 'MTA',
  });

  await testDb.db`
    INSERT INTO department_permissions (user_id, department_id, tenant_id, can_read, can_write)
    VALUES (${UPLOADER_A_ID}, ${DEPT_A_ID}, ${TENANT_A}, true, true)
    ON CONFLICT (user_id, department_id) WHERE deleted = false DO NOTHING
  `;

  tokenAdminA = await login('admin-a@e.com');
  tokenUploaderA = await login('uploader-a@e.com');
  tokenUserA = await login('user-a@e.com');
  tokenSuper = await login('super@plataforma.com');
  tokenMta = await login('mta@e.com');
});

describe('GET /reports/deletions — gate de papel', () => {
  it('retorna 401 sem token', async () => {
    const res = await app.inject({ method: 'GET', url: '/reports/deletions' });
    expect(res.statusCode).toBe(401);
  });

  it('USER → 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/reports/deletions',
      headers: { authorization: `Bearer ${tokenUserA}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('UPLOADER → 403 (mesmo podendo apagar documentos)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/reports/deletions',
      headers: { authorization: `Bearer ${tokenUploaderA}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('TENANT_ADMIN → 200', async () => {
    const { statusCode } = await getReport(tokenAdminA);
    expect(statusCode).toBe(200);
  });

  it('MULTI_TENANT_ADMIN com ?tenantId → 200', async () => {
    const { statusCode } = await getReport(tokenMta, { tenantId: TENANT_A });
    expect(statusCode).toBe(200);
  });

  it('SUPER_ADMIN com ?tenantId → 200', async () => {
    const { statusCode } = await getReport(tokenSuper, { tenantId: TENANT_A });
    expect(statusCode).toBe(200);
  });

  it('SUPER_ADMIN sem ?tenantId → 409 (mode !== single)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/reports/deletions',
      headers: { authorization: `Bearer ${tokenSuper}` },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('GET /reports/deletions — achatamento (1 linha por arquivo)', () => {
  it('DELETE /documents/:id individual vira exatamente 1 linha', async () => {
    const docId = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID, { originalFilename: 'contrato.pdf' });
    expect(await deleteOne(tokenAdminA, docId)).toBe(204);

    const { statusCode, body } = await getReport(tokenAdminA);
    expect(statusCode).toBe(200);
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      documentId: docId,
      filename: 'contrato.pdf',
      action: 'document.delete',
      userId: ADMIN_A_ID,
      userName: 'Admin A',
      userEmail: 'admin-a@e.com',
    });
  });

  it('bulk-delete de N documentos vira N linhas, todas com o mesmo usuário/data/hora', async () => {
    const doc1 = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID, { originalFilename: 'a.pdf' });
    const doc2 = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID, { originalFilename: 'b.pdf' });
    const doc3 = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID, { originalFilename: 'c.pdf' });

    expect(await bulkDelete(tokenAdminA, [doc1, doc2, doc3])).toBe(200);

    const { statusCode, body } = await getReport(tokenAdminA);
    expect(statusCode).toBe(200);
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(3);
    expect(body.items.every((i) => i.action === 'document.bulk_delete')).toBe(true);
    expect(body.items.every((i) => i.userId === ADMIN_A_ID)).toBe(true);
    const timestamps = new Set(body.items.map((i) => i.deletedAt));
    expect(timestamps.size).toBe(1); // mesmo instante — vem do MESMO audit_log
    const ids = body.items.map((i) => i.documentId).sort();
    expect(ids).toEqual([doc1, doc2, doc3].sort());
  });

  it('individual + bulk misturados somam corretamente', async () => {
    const solo = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID);
    const doc1 = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID);
    const doc2 = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID);

    expect(await deleteOne(tokenAdminA, solo)).toBe(204);
    expect(await bulkDelete(tokenAdminA, [doc1, doc2])).toBe(200);

    const { body } = await getReport(tokenAdminA);
    expect(body.total).toBe(3);
  });
});

describe('GET /reports/deletions — isolamento multi-tenant', () => {
  it('exclusão do tenant B não aparece no relatório do tenant A', async () => {
    const docB = await seedDocument(TENANT_B, DEPT_B_ID, ADMIN_B_ID);
    const tokenAdminB = await login('admin-b@e.com');
    expect(await deleteOne(tokenAdminB, docB)).toBe(204);

    const { body } = await getReport(tokenAdminA);
    expect(body.total).toBe(0);
  });

  it('MTA só vê a empresa explicitamente selecionada', async () => {
    const docA = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID);
    expect(await deleteOne(tokenAdminA, docA)).toBe(204);

    const { body } = await getReport(tokenMta, { tenantId: TENANT_A });
    expect(body.total).toBe(1);
    expect(body.items[0]!.documentId).toBe(docA);
  });
});

describe('GET /reports/deletions — filtros', () => {
  it('search casa por original_filename', async () => {
    const alvo = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID, { originalFilename: 'relatorio-financeiro-2026.pdf' });
    const outro = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID, { originalFilename: 'nota-fiscal.pdf' });
    expect(await deleteOne(tokenAdminA, alvo)).toBe(204);
    expect(await deleteOne(tokenAdminA, outro)).toBe(204);

    const { body } = await getReport(tokenAdminA, { search: 'financeiro' });
    expect(body.total).toBe(1);
    expect(body.items[0]!.documentId).toBe(alvo);
  });

  it('search casa por title (quando definido) mesmo com original_filename diferente', async () => {
    const alvo = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID, {
      originalFilename: 'scan-0001.pdf',
      title: 'Contrato de Locação Comercial',
    });
    expect(await deleteOne(tokenAdminA, alvo)).toBe(204);

    const { body } = await getReport(tokenAdminA, { search: 'Locação' });
    expect(body.total).toBe(1);
    expect(body.items[0]!.filename).toBe('Contrato de Locação Comercial');
  });

  it('search sem correspondência retorna lista vazia', async () => {
    const doc = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID, { originalFilename: 'algo.pdf' });
    expect(await deleteOne(tokenAdminA, doc)).toBe(204);

    const { body } = await getReport(tokenAdminA, { search: 'inexistente-xyz' });
    expect(body.total).toBe(0);
  });

  it('userId filtra por quem apagou', async () => {
    const docAdmin = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID);
    const docUploader = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID);
    expect(await deleteOne(tokenAdminA, docAdmin)).toBe(204);
    expect(await deleteOne(tokenUploaderA, docUploader)).toBe(204);

    const { body } = await getReport(tokenAdminA, { userId: UPLOADER_A_ID });
    expect(body.total).toBe(1);
    expect(body.items[0]!.documentId).toBe(docUploader);
    expect(body.items[0]!.userId).toBe(UPLOADER_A_ID);
  });

  it('dateFrom/dateTo filtram por created_at do audit log', async () => {
    const docJan = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID);
    const docJul = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID);
    expect(await deleteOne(tokenAdminA, docJan)).toBe(204);

    // Isola o segundo delete como um evento de auditoria distinto (resource
    // diferente) para poder mover só o dele no tempo.
    await testDb.db`UPDATE audit_logs SET created_at = ${new Date('2026-01-10T12:00:00Z')} WHERE resource = ${`documents/${docJan}`}`;

    expect(await deleteOne(tokenAdminA, docJul)).toBe(204);
    await testDb.db`UPDATE audit_logs SET created_at = ${new Date('2026-07-10T12:00:00Z')} WHERE resource = ${`documents/${docJul}`}`;

    const { body } = await getReport(tokenAdminA, { dateFrom: '2026-06-01', dateTo: '2026-08-01' });
    expect(body.total).toBe(1);
    expect(body.items[0]!.documentId).toBe(docJul);
  });

  it('página/tamanho aplicam paginação por offset', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID));
    }
    for (const id of ids) {
      expect(await deleteOne(tokenAdminA, id)).toBe(204);
    }

    const { body } = await getReport(tokenAdminA, { page: '1', pageSize: '2' });
    expect(body.total).toBe(5);
    expect(body.pageCount).toBe(3);
    expect(body.items).toHaveLength(2);
  });
});

describe('GET /reports/deletions — ordenação', () => {
  it('created_at DESC — exclusão mais recente aparece primeiro', async () => {
    const docOld = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID);
    const docNew = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID);

    expect(await deleteOne(tokenAdminA, docOld)).toBe(204);
    await testDb.db`UPDATE audit_logs SET created_at = ${new Date('2026-01-01T00:00:00Z')} WHERE resource = ${`documents/${docOld}`}`;

    expect(await deleteOne(tokenAdminA, docNew)).toBe(204);
    await testDb.db`UPDATE audit_logs SET created_at = ${new Date('2026-05-01T00:00:00Z')} WHERE resource = ${`documents/${docNew}`}`;

    const { body } = await getReport(tokenAdminA);
    expect(body.items.map((i) => i.documentId)).toEqual([docNew, docOld]);
  });
});

describe('GET /reports/deletions — campo restorable', () => {
  it('documento ainda excluído → restorable: true', async () => {
    const docId = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID, { originalFilename: 'contrato.pdf' });
    expect(await deleteOne(tokenAdminA, docId)).toBe(204);

    const { body } = await getReport(tokenAdminA);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.restorable).toBe(true);
  });

  it('documento restaurado → restorable: false, mas a linha do relatório permanece', async () => {
    const docId = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID, { originalFilename: 'contrato.pdf' });
    expect(await deleteOne(tokenAdminA, docId)).toBe(204);

    const restoreRes = await app.inject({
      method: 'POST',
      url: `/documents/${docId}/restore`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(restoreRes.statusCode).toBe(200);

    const { body } = await getReport(tokenAdminA);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.documentId).toBe(docId);
    expect(body.items[0]!.restorable).toBe(false);
  });
});

describe('GET /reports/deletions — hierarquia de papéis (rolesVisibleTo)', () => {
  it('TENANT_ADMIN não vê nome/e-mail de um MTA que apagou um documento no tenant, mas a linha permanece', async () => {
    const doc = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID);
    expect(await deleteOne(tokenMta, doc)).toBe(204);

    const { body } = await getReport(tokenAdminA, { tenantId: TENANT_A });
    expect(body.total).toBe(1);
    expect(body.items[0]!.documentId).toBe(doc);
    expect(body.items[0]!.userId).toBe(MTA_ID);
    expect(body.items[0]!.userName).toBeNull();
    expect(body.items[0]!.userEmail).toBeNull();
  });
});
