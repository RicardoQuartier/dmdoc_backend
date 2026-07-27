import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, resetDomainTables, type TestDb } from '../test/helpers.js';
import type { S3Service } from '../services/s3.js';
import { newId } from '@dmdoc/db-pg';

/**
 * E2E da exclusão em massa (épico E-8 / T-95): `POST /documents/bulk-delete`.
 *
 * A operação é SÍNCRONA e IRREVERSÍVEL — não há lote, fila nem polling. O foco
 * dos testes é exatamente onde uma exclusão em massa pode causar estrago:
 *   - gate de papel administrativo (UPLOADER/USER → 403), com a ASSIMETRIA
 *     deliberada de o `DELETE /documents/:id` individual continuar liberado ao
 *     UPLOADER com ACL;
 *   - escopo cirúrgico: só os ids enviados somem; o `= ANY` não vaza para fora
 *     da lista (documento não selecionado mantém chunks e texto extraído);
 *   - isolamento multi-tenant: id de outra empresa → 404 e NADA escrito antes
 *     disso (nem nos ids válidos que vieram junto);
 *   - seleção cross-tenant de um SUPER_ADMIN → 422;
 *   - contagem vinda do `RETURNING` (dedupe de ids, documento já excluído);
 *   - S3 best-effort: falha ao remover o objeto NÃO desfaz nem derruba nada.
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
const UPLOADER_A_ID = crypto.randomUUID();
const USER_A_ID = crypto.randomUUID();
const ADMIN_B_ID = crypto.randomUUID();
const SUPER_ID = crypto.randomUUID();
const MTA_ID = crypto.randomUUID();
const DEPT_A_ID = newId();
const DEPT_A2_ID = newId();
const DEPT_B_ID = newId();
const PASSWORD = 'senha-forte-de-teste-123';
const DISK_QUOTA = 10 * 1024 * 1024;
const ZERO_EMBEDDING = `[${new Array(1536).fill(0).join(',')}]`;

let app: FastifyInstance;
let s3Mock: S3Service;
let testDb: TestDb;
let tokenAdminA: string;
let tokenUploaderA: string;
let tokenUserA: string;
let tokenSuper: string;
let tokenMta: string;

// Empresa A: 4 documentos no departamento A (todos com conteúdo e 1 chunk).
let DOC_1 = '';
let DOC_2 = '';
let DOC_3 = '';
let DOC_4 = '';
// Documento em departamento SEM ACL do UPLOADER (segunda camada de permissão).
let DOC_SEM_ACL = '';
// Empresa B: um documento com conteúdo, para provar que nada é escrito antes
// do 404 de isolamento.
let DOC_B = '';

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
  status: DocStatus = 'READY'
): Promise<string> {
  const id = newId();
  const hash = crypto.randomBytes(32).toString('hex');
  await testDb.db`
    INSERT INTO documents (
      id, tenant_id, department_id, document_type_id, filename, original_filename,
      content_hash, size_bytes, mime_type, s3_key, status, failure_reason,
      uploaded_by_id, uploaded_at, index_values, tags, deleted
    ) VALUES (
      ${id}, ${tenantId}, ${departmentId}, NULL, ${'f-' + id + '.pdf'}, 'doc.pdf',
      ${hash}, ${1234}, 'application/pdf', ${'s3/' + id}, ${status}, NULL,
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

async function countRows(table: 'document_content' | 'chunks', documentId: string): Promise<number> {
  const rows = await testDb.db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ${testDb.db(table)} WHERE document_id = ${documentId}
  `;
  return Number(rows[0]?.n ?? 0);
}

async function isDeleted(id: string): Promise<boolean> {
  const rows = await testDb.db<{ deleted: boolean }[]>`
    SELECT deleted FROM documents WHERE id = ${id}
  `;
  return rows[0]!.deleted;
}

/** Estado completo de um documento: excluído? ainda tem conteúdo e chunks? */
async function snapshot(id: string): Promise<{ deleted: boolean; content: number; chunks: number }> {
  return {
    deleted: await isDeleted(id),
    content: await countRows('document_content', id),
    chunks: await countRows('chunks', id),
  };
}

async function countAudit(action: string): Promise<number> {
  const rows = await testDb.db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM audit_logs WHERE action = ${action}
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
    s3: s3Mock,
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
      (${DEPT_A2_ID}, ${TENANT_A}, NULL, 'Juridico A', 0, '{}'::text[], false, NOW()),
      (${DEPT_B_ID}, ${TENANT_B}, NULL, 'Financeiro B', 0, '{}'::text[], false, NOW())
  `;

  await seedUser(testDb.db, { id: ADMIN_A_ID, tenantId: TENANT_A, email: 'admin-a@e.com', password: PASSWORD, role: 'TENANT_ADMIN' });
  await seedUser(testDb.db, { id: UPLOADER_A_ID, tenantId: TENANT_A, email: 'uploader-a@e.com', password: PASSWORD, role: 'UPLOADER' });
  await seedUser(testDb.db, { id: USER_A_ID, tenantId: TENANT_A, email: 'user-a@e.com', password: PASSWORD, role: 'USER' });
  await seedUser(testDb.db, { id: ADMIN_B_ID, tenantId: TENANT_B, email: 'admin-b@e.com', password: PASSWORD, role: 'TENANT_ADMIN' });
  await seedUser(testDb.db, { id: SUPER_ID, tenantId: null, email: 'super@plataforma.com', password: PASSWORD, role: 'SUPER_ADMIN' });
  await seedUser(testDb.db, {
    id: MTA_ID,
    tenantId: null,
    email: 'mta@e.com',
    password: PASSWORD,
    role: 'MULTI_TENANT_ADMIN',
    allowedTenantIds: [TENANT_A],
  });

  // ACL legítima de ESCRITA do UPLOADER no departamento A: garante que o 403 do
  // lote vem do gate de papel, não de falta de permissão no departamento — e
  // sustenta o teste de que ele AINDA exclui pelo endpoint individual.
  await testDb.db`
    INSERT INTO department_permissions (user_id, department_id, tenant_id, can_read, can_write)
    VALUES (${UPLOADER_A_ID}, ${DEPT_A_ID}, ${TENANT_A}, true, true)
    ON CONFLICT (user_id, department_id) WHERE deleted = false DO NOTHING
  `;

  DOC_1 = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID, 'READY');
  DOC_2 = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID, 'PROCESSING');
  DOC_3 = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID, 'FAILED');
  DOC_4 = await seedDocument(TENANT_A, DEPT_A_ID, ADMIN_A_ID, 'READY');
  DOC_SEM_ACL = await seedDocument(TENANT_A, DEPT_A2_ID, ADMIN_A_ID, 'READY');
  DOC_B = await seedDocument(TENANT_B, DEPT_B_ID, ADMIN_B_ID, 'READY');

  tokenAdminA = await login('admin-a@e.com');
  tokenUploaderA = await login('uploader-a@e.com');
  tokenUserA = await login('user-a@e.com');
  tokenSuper = await login('super@plataforma.com');
  tokenMta = await login('mta@e.com');
});

function post(token: string, documentIds: unknown) {
  return app.inject({
    method: 'POST',
    url: '/documents/bulk-delete',
    headers: { authorization: `Bearer ${token}` },
    payload: { documentIds },
  });
}

describe('POST /documents/bulk-delete — exclusão e escopo cirúrgico', () => {
  it('exclui 3 documentos: 200 { deleted: 3 }, sem chunks nem texto extraído', async () => {
    const res = await post(tokenAdminA, [DOC_1, DOC_2, DOC_3]);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: 3 });

    for (const id of [DOC_1, DOC_2, DOC_3]) {
      expect(await snapshot(id)).toEqual({ deleted: true, content: 0, chunks: 0 });
    }
  });

  it('documento não selecionado permanece intacto (o = ANY não vaza da lista)', async () => {
    const res = await post(tokenAdminA, [DOC_1, DOC_2]);
    expect(res.statusCode).toBe(200);

    // O bug clássico seria aplicar UPDATE/DELETEs a mais do que a seleção.
    expect(await snapshot(DOC_3)).toEqual({ deleted: false, content: 1, chunks: 1 });
    expect(await snapshot(DOC_4)).toEqual({ deleted: false, content: 1, chunks: 1 });
    // E o documento da outra empresa, idem.
    expect(await snapshot(DOC_B)).toEqual({ deleted: false, content: 1, chunks: 1 });
  });

  it('qualquer status é elegível — PROCESSING e FAILED são excluídos sem 409', async () => {
    const res = await post(tokenAdminA, [DOC_2, DOC_3]);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).deleted).toBe(2);
    expect(await isDeleted(DOC_2)).toBe(true);
    expect(await isDeleted(DOC_3)).toBe(true);
  });

  it('ids duplicados contam uma vez só', async () => {
    const res = await post(tokenAdminA, [DOC_1, DOC_1, DOC_2, DOC_1, DOC_2]);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).deleted).toBe(2);
    // Uma única remoção de objeto por documento, não uma por id repetido.
    expect(s3Mock.deleteFile).toHaveBeenCalledTimes(2);
  });

  it('documento JÁ excluído na lista → 404, e nada mais é excluído', async () => {
    await testDb.db`UPDATE documents SET deleted = true WHERE id = ${DOC_4}`;

    const res = await post(tokenAdminA, [DOC_1, DOC_4]);

    // A resolução do passo 1 já filtra `deleted = false`: o id não resolve, a
    // seleção inteira é recusada e a contagem nunca é inflada por ele.
    expect(res.statusCode).toBe(404);
    expect(await snapshot(DOC_1)).toEqual({ deleted: false, content: 1, chunks: 1 });
    expect(s3Mock.deleteFile).not.toHaveBeenCalled();
  });

  it('remove no S3 exatamente as chaves dos documentos excluídos', async () => {
    const res = await post(tokenAdminA, [DOC_1, DOC_2]);
    expect(res.statusCode).toBe(200);

    const keys = (s3Mock.deleteFile as unknown as { mock: { calls: string[][] } }).mock.calls
      .map((c) => c[0]!)
      .sort();
    expect(keys).toEqual([`s3/${DOC_1}`, `s3/${DOC_2}`].sort());
  });

  it('MTA com a empresa na lista permitida exclui normalmente', async () => {
    const res = await post(tokenMta, [DOC_1]);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).deleted).toBe(1);
  });

  it('SUPER_ADMIN exclui documentos de uma empresa (escopo global)', async () => {
    const res = await post(tokenSuper, [DOC_B]);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).deleted).toBe(1);
    expect(await snapshot(DOC_B)).toEqual({ deleted: true, content: 0, chunks: 0 });
  });
});

describe('POST /documents/bulk-delete — validação do body', () => {
  it('mais de 500 ids → rejeitado', async () => {
    const tooMany = Array.from({ length: 501 }, () => crypto.randomUUID());
    const res = await post(tokenAdminA, tooMany);
    expect([400, 422]).toContain(res.statusCode);
    expect(await isDeleted(DOC_1)).toBe(false);
  });

  it('array vazio → rejeitado', async () => {
    const res = await post(tokenAdminA, []);
    expect([400, 422]).toContain(res.statusCode);
  });

  it('id que não é uuid → rejeitado', async () => {
    const res = await post(tokenAdminA, ['nao-e-uuid']);
    expect([400, 422]).toContain(res.statusCode);
  });
});

describe('POST /documents/bulk-delete — permissão e isolamento', () => {
  it('USER (somente-leitura) → 403 e nada é lido nem escrito', async () => {
    const res = await post(tokenUserA, [DOC_1]);

    expect(res.statusCode).toBe(403);
    expect(await snapshot(DOC_1)).toEqual({ deleted: false, content: 1, chunks: 1 });
  });

  it('UPLOADER com ACL de escrita AINDA ASSIM não exclui em lote (403)', async () => {
    const res = await post(tokenUploaderA, [DOC_1, DOC_2]);

    expect(res.statusCode).toBe(403);
    expect(await snapshot(DOC_1)).toEqual({ deleted: false, content: 1, chunks: 1 });
    expect(s3Mock.deleteFile).not.toHaveBeenCalled();
  });

  it('ASSIMETRIA: o mesmo UPLOADER continua excluindo pelo DELETE /documents/:id', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/documents/${DOC_1}`,
      headers: { authorization: `Bearer ${tokenUploaderA}` },
    });

    expect(res.statusCode).toBe(204);
    expect(await snapshot(DOC_1)).toEqual({ deleted: true, content: 0, chunks: 0 });
  });

  it('ISOLAMENTO: TENANT_ADMIN de A com id da empresa B → 404 e NADA escrito', async () => {
    const res = await post(tokenAdminA, [DOC_1, DOC_B]);

    expect(res.statusCode).toBe(404);
    // O documento de B segue intacto...
    expect(await snapshot(DOC_B)).toEqual({ deleted: false, content: 1, chunks: 1 });
    // ...e o documento válido de A também não foi tocado.
    expect(await snapshot(DOC_1)).toEqual({ deleted: false, content: 1, chunks: 1 });
    expect(s3Mock.deleteFile).not.toHaveBeenCalled();
    expect(await countAudit('document.bulk_delete')).toBe(0);
  });

  it('ISOLAMENTO: MTA sem a empresa na lista permitida → 404', async () => {
    const res = await post(tokenMta, [DOC_B]);
    expect(res.statusCode).toBe(404);
    expect(await snapshot(DOC_B)).toEqual({ deleted: false, content: 1, chunks: 1 });
  });

  it('id inexistente na seleção → 404 e nada é escrito', async () => {
    const res = await post(tokenAdminA, [DOC_1, crypto.randomUUID()]);

    expect(res.statusCode).toBe(404);
    expect(await snapshot(DOC_1)).toEqual({ deleted: false, content: 1, chunks: 1 });
  });

  it('ACL: TENANT_ADMIN opera sem restrição de departamento (inclui o dept sem concessão)', async () => {
    const res = await post(tokenAdminA, [DOC_1, DOC_SEM_ACL]);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).deleted).toBe(2);
  });

  it('SUPER_ADMIN com ids de DUAS empresas → 422 e nada é excluído', async () => {
    const res = await post(tokenSuper, [DOC_1, DOC_B]);

    expect(res.statusCode).toBe(422);
    expect(await snapshot(DOC_1)).toEqual({ deleted: false, content: 1, chunks: 1 });
    expect(await snapshot(DOC_B)).toEqual({ deleted: false, content: 1, chunks: 1 });
    expect(s3Mock.deleteFile).not.toHaveBeenCalled();
  });
});

describe('POST /documents/bulk-delete — auditoria', () => {
  it('grava document.bulk_delete com resource fixo e count igual ao deleted', async () => {
    const res = await post(tokenAdminA, [DOC_1, DOC_2, DOC_3]);
    const { deleted } = JSON.parse(res.body);

    const logs = await testDb.db<{ action: string; resource: string; metadata: string; tenant_id: string }[]>`
      SELECT action, resource, metadata, tenant_id FROM audit_logs WHERE action = 'document.bulk_delete'
    `;
    expect(logs).toHaveLength(1);
    expect(logs[0]!.resource).toBe('documents/bulk-delete');
    expect(logs[0]!.tenant_id).toBe(TENANT_A);
    // `metadata` é jsonb gravado com JSON.stringify (ver auth/audit.ts) — a
    // leitura devolve a string JSON crua.
    const metadata = JSON.parse(logs[0]!.metadata) as { count: number; documentIds: string[] };
    expect(metadata.count).toBe(deleted);
    expect([...metadata.documentIds].sort()).toEqual([DOC_1, DOC_2, DOC_3].sort());
  });
});

describe('POST /documents/bulk-delete — S3 best-effort', () => {
  it('falha ao remover no S3 não derruba a requisição nem desfaz a exclusão', async () => {
    const failingS3 = {
      uploadFile: vi.fn().mockResolvedValue(undefined),
      getSignedDownloadUrl: vi.fn().mockResolvedValue('https://mock-signed-url'),
      deleteFile: vi.fn().mockRejectedValue(new Error('S3 fora do ar')),
    } as unknown as S3Service;

    const appWithFailingS3 = await buildApp({
      config: testConfig(),
      db: testDb.db,
      queue: null,
      aiReprocessQueue: null,
      s3: failingS3,
    });

    try {
      const res = await appWithFailingS3.inject({
        method: 'POST',
        url: '/documents/bulk-delete',
        headers: { authorization: `Bearer ${tokenAdminA}` },
        payload: { documentIds: [DOC_1, DOC_2] },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).deleted).toBe(2);
      // Sem compensação: o documento excluído continua excluído.
      expect(await snapshot(DOC_1)).toEqual({ deleted: true, content: 0, chunks: 0 });
      expect(await snapshot(DOC_2)).toEqual({ deleted: true, content: 0, chunks: 0 });
      expect(failingS3.deleteFile).toHaveBeenCalledTimes(2);
      // A auditoria continua registrada mesmo com o S3 falhando.
      expect(await countAudit('document.bulk_delete')).toBe(1);
    } finally {
      await appWithFailingS3.close();
    }
  });
});
