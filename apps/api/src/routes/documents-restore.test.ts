import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, resetDomainTables, type TestDb, staticStorage } from '../test/helpers.js';
import type { StorageDriver } from '@dmdoc/storage';
import { newId } from '@dmdoc/db-pg';

/**
 * E2E de `POST /documents/:id/restore` — desfaz o soft-delete de um documento
 * a partir do relatório de auditoria (`GET /reports/deletions`).
 *
 * Decisões de design exercitadas aqui (ver comentário da rota em
 * `documents.ts`):
 *   - auditoria imutável: `document.delete` original convive com o novo
 *     `document.restore`, nenhum é sobrescrito;
 *   - storage NÃO é movido de volta — `storage_key` permanece a chave
 *     `deleted__{id}__...` mesmo após restaurar;
 *   - reprocessamento é reenfileirado (mesmo bloco do
 *     `POST /documents/:id/reprocess`), porque `chunks`/`document_content`
 *     foram hard-deletados na exclusão;
 *   - 404 nunca revela existência fora do escopo; 409 quando o documento não
 *     está excluído (ou uma corrida já restaurou antes).
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
const ZERO_EMBEDDING = `[${new Array(1536).fill(0).join(',')}]`;

let app: FastifyInstance;
let s3Mock: StorageDriver;
let testDb: TestDb;
let tokenAdminA: string;
let tokenUploaderA: string;
let tokenUserA: string;
let tokenAdminB: string;
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

/** Documento "vivo" com `document_content` e 1 chunk (mesmo padrão de `bulk-delete.test.ts`). */
async function seedDocument(
  tenantId: string,
  departmentId: string,
  uploadedById: string,
  originalFilename = 'contrato.pdf'
): Promise<string> {
  const id = newId();
  const hash = crypto.randomBytes(32).toString('hex');
  await testDb.db`
    INSERT INTO documents (
      id, tenant_id, department_id, document_type_id, filename, original_filename,
      content_hash, size_bytes, mime_type, storage_key, status, failure_reason,
      uploaded_by_id, uploaded_at, index_values, tags, deleted
    ) VALUES (
      ${id}, ${tenantId}, ${departmentId}, NULL, ${'f-' + id + '.pdf'}, ${originalFilename},
      ${hash}, ${1234}, 'application/pdf', ${'s3/' + id}, 'READY', NULL,
      ${uploadedById}, NOW(), '{}'::jsonb, '{}'::text[], false
    )
  `;
  await testDb.db`
    INSERT INTO document_content (document_id, tenant_id, full_text, extraction)
    VALUES (
      ${id}, ${tenantId}, 'texto extraido',
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
    VALUES (${newId()}, ${id}, ${tenantId}, ${departmentId}, 0, 'trecho de teste', ${ZERO_EMBEDDING}::vector, 3)
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

function restore(token: string, documentId: string) {
  return app.inject({
    method: 'POST',
    url: `/documents/${documentId}/restore`,
    headers: { authorization: `Bearer ${token}` },
  });
}

interface DocRow {
  id: string;
  deleted: boolean;
  status: string;
  storage_key: string;
  tenant_id: string;
}

async function readDoc(id: string): Promise<DocRow> {
  const rows = await testDb.db<DocRow[]>`
    SELECT id, deleted, status, storage_key, tenant_id FROM documents WHERE id = ${id}
  `;
  return rows[0]!;
}

async function countRows(table: 'document_content' | 'chunks', documentId: string): Promise<number> {
  const rows = await testDb.db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ${testDb.db(table)} WHERE document_id = ${documentId}
  `;
  return Number(rows[0]?.n ?? 0);
}

async function countAudit(action: string, documentId: string): Promise<number> {
  const rows = await testDb.db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM audit_logs WHERE action = ${action} AND resource = ${`documents/${documentId}`}
  `;
  return Number(rows[0]?.n ?? 0);
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

  tokenAdminA = await login('admin-a@e.com');
  tokenUploaderA = await login('uploader-a@e.com');
  tokenUserA = await login('user-a@e.com');
  tokenAdminB = await login('admin-b@e.com');
  tokenSuper = await login('super@plataforma.com');
  tokenMta = await login('mta@e.com');
});

describe('POST /documents/:id/restore — gate de papel', () => {
  it('retorna 401 sem token', async () => {
    const res = await app.inject({ method: 'POST', url: `/documents/${crypto.randomUUID()}/restore` });
    expect(res.statusCode).toBe(401);
  });

  it('USER → 403', async () => {
    const docId = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID);
    expect(await deleteOne(tokenAdminA, docId)).toBe(204);

    const res = await restore(tokenUserA, docId);
    expect(res.statusCode).toBe(403);
    expect((await readDoc(docId)).deleted).toBe(true);
  });

  it('UPLOADER → 403 (mesmo podendo excluir individualmente)', async () => {
    const docId = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID);
    expect(await deleteOne(tokenAdminA, docId)).toBe(204);

    const res = await restore(tokenUploaderA, docId);
    expect(res.statusCode).toBe(403);
    expect((await readDoc(docId)).deleted).toBe(true);
  });
});

describe('POST /documents/:id/restore — sucesso e efeitos colaterais', () => {
  it('TENANT_ADMIN restaura: 200, deleted volta a false, status vira PENDING, storage_key NÃO muda', async () => {
    const docId = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID, 'relatorio.pdf');
    expect(await deleteOne(tokenAdminA, docId)).toBe(204);

    const beforeRestore = await readDoc(docId);
    expect(beforeRestore.deleted).toBe(true);
    expect(beforeRestore.storage_key).toBe(`s3/deleted__${docId}__${docId}`);

    const res = await restore(tokenAdminA, docId);
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.id).toBe(docId);
    expect(body.deleted).toBe(false);
    expect(body.status).toBe('PENDING');
    // Decisão de design 2: storage_key NÃO é revertido — continua na chave
    // física do soft-delete.
    expect(body.storageKey).toBe(`s3/deleted__${docId}__${docId}`);

    const after = await readDoc(docId);
    expect(after.deleted).toBe(false);
    expect(after.status).toBe('PENDING');
    expect(after.storage_key).toBe(`s3/deleted__${docId}__${docId}`);

    // Arquivo físico não é tocado pela restauração (nenhuma chamada extra de
    // storage além das já feitas pelo DELETE anterior).
    expect(s3Mock.put).toHaveBeenCalledTimes(1);
    expect(s3Mock.delete).toHaveBeenCalledTimes(1);
  });

  it('chunks e document_content continuam vazios (no-op) após restaurar', async () => {
    const docId = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID);
    expect(await deleteOne(tokenAdminA, docId)).toBe(204);
    expect(await countRows('document_content', docId)).toBe(0);
    expect(await countRows('chunks', docId)).toBe(0);

    const res = await restore(tokenAdminA, docId);
    expect(res.statusCode).toBe(200);
    expect(await countRows('document_content', docId)).toBe(0);
    expect(await countRows('chunks', docId)).toBe(0);
  });

  it('reenfileira job process-document com a storageKey atual (deleted__...)', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const okQueue = { add, close: vi.fn().mockResolvedValue(undefined) } as unknown as Queue;

    const appWithQueue = await buildApp({
      config: testConfig(),
      db: testDb.db,
      queue: okQueue,
      aiReprocessQueue: null,
      storage: staticStorage(s3Mock),
    });

    try {
      const docId = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID);
      expect(await deleteOne(tokenAdminA, docId)).toBe(204);

      const res = await appWithQueue.inject({
        method: 'POST',
        url: `/documents/${docId}/restore`,
        headers: { authorization: `Bearer ${tokenAdminA}` },
      });

      expect(res.statusCode).toBe(200);
      expect(add).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledWith(
        'process-document',
        {
          tenantId: TENANT_A,
          documentId: docId,
          storageKey: `s3/deleted__${docId}__${docId}`,
          mimeType: 'application/pdf',
        },
        { attempts: 3, backoff: { type: 'exponential', delay: 2000 } }
      );
    } finally {
      await appWithQueue.close();
    }
  });

  it('audit log document.restore é gravado SEM apagar o document.delete original', async () => {
    const docId = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID, 'ata-reuniao.pdf');
    expect(await deleteOne(tokenAdminA, docId)).toBe(204);
    expect(await countAudit('document.delete', docId)).toBe(1);

    const res = await restore(tokenAdminA, docId);
    expect(res.statusCode).toBe(200);

    // Os dois eventos coexistem — nenhum foi sobrescrito.
    expect(await countAudit('document.delete', docId)).toBe(1);
    expect(await countAudit('document.restore', docId)).toBe(1);

    const restoreLogs = await testDb.db<
      Array<{ metadata: string | Record<string, unknown>; user_id: string; tenant_id: string }>
    >`
      SELECT metadata, user_id, tenant_id FROM audit_logs
      WHERE action = 'document.restore' AND resource = ${`documents/${docId}`}
    `;
    expect(restoreLogs).toHaveLength(1);
    expect(restoreLogs[0]!.user_id).toBe(ADMIN_A_ID);
    expect(restoreLogs[0]!.tenant_id).toBe(TENANT_A);
    const rawMetadata = restoreLogs[0]!.metadata;
    const metadata =
      typeof rawMetadata === 'string'
        ? (JSON.parse(rawMetadata) as { filename: string; storageKey: string })
        : (rawMetadata as unknown as { filename: string; storageKey: string });
    expect(metadata.filename).toBe(`f-${docId}.pdf`);
    expect(metadata.storageKey).toBe(`s3/deleted__${docId}__${docId}`);
  });

  it('MULTI_TENANT_ADMIN com a empresa na lista permitida restaura normalmente', async () => {
    const docId = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID);
    expect(await deleteOne(tokenAdminA, docId)).toBe(204);

    const res = await restore(tokenMta, docId);
    expect(res.statusCode).toBe(200);
    expect((await readDoc(docId)).deleted).toBe(false);
  });

  it('SUPER_ADMIN restaura documento de qualquer empresa (escopo global)', async () => {
    const docId = await seedDocument(TENANT_B, DEPT_B_ID, ADMIN_B_ID);
    expect(await deleteOne(tokenAdminB, docId)).toBe(204);

    const res = await restore(tokenSuper, docId);
    expect(res.statusCode).toBe(200);
    expect((await readDoc(docId)).deleted).toBe(false);
  });
});

describe('POST /documents/:id/restore — 409 (não está excluído)', () => {
  it('documento vivo (nunca excluído) → 409, nada muda', async () => {
    const docId = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID);

    const res = await restore(tokenAdminA, docId);
    expect(res.statusCode).toBe(409);

    const doc = await readDoc(docId);
    expect(doc.deleted).toBe(false);
    expect(doc.status).toBe('READY');
  });

  it('restaurar duas vezes: a segunda chamada → 409', async () => {
    const docId = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID);
    expect(await deleteOne(tokenAdminA, docId)).toBe(204);

    expect((await restore(tokenAdminA, docId)).statusCode).toBe(200);
    const second = await restore(tokenAdminA, docId);
    expect(second.statusCode).toBe(409);

    // Só 1 audit log de restauração — a segunda tentativa não grava nada.
    expect(await countAudit('document.restore', docId)).toBe(1);
  });
});

describe('POST /documents/:id/restore — 404 (fora do escopo / inexistente)', () => {
  it('id inexistente → 404', async () => {
    const res = await restore(tokenAdminA, crypto.randomUUID());
    expect(res.statusCode).toBe(404);
  });

  it('ISOLAMENTO: TENANT_ADMIN de A não restaura documento excluído da empresa B', async () => {
    const docB = await seedDocument(TENANT_B, DEPT_B_ID, ADMIN_B_ID);
    expect(await deleteOne(tokenAdminB, docB)).toBe(204);

    const res = await restore(tokenAdminA, docB);
    expect(res.statusCode).toBe(404);
    expect((await readDoc(docB)).deleted).toBe(true);
  });

  it('ISOLAMENTO: MTA sem a empresa B na lista permitida → 404', async () => {
    const docB = await seedDocument(TENANT_B, DEPT_B_ID, ADMIN_B_ID);
    expect(await deleteOne(tokenAdminB, docB)).toBe(204);

    const res = await restore(tokenMta, docB);
    expect(res.statusCode).toBe(404);
    expect((await readDoc(docB)).deleted).toBe(true);
  });
});
