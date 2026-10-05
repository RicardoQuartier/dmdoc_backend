import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import FormData from 'form-data';
import { newId } from '@dmdoc/db-pg';
import type { StorageDriver } from '@dmdoc/storage';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, type TestDb, staticStorage } from '../test/helpers.js';
import { cleanupUploadSessions, UPLOAD_CHUNK_SIZE_BYTES } from './document-uploads.js';

/**
 * Upload em partes (épico E-16 / ADR 0004) — integração com PostgreSQL real,
 * disco real (diretório temporário) e storage em memória.
 *
 * O storage falso guarda o conteúdo que `putFile` leu do disco, para provar que
 * o objeto gravado tem o MESMO SHA-256 do arquivo original.
 */

// ---------------------------------------------------------------------------
// Storage em memória
// ---------------------------------------------------------------------------
const stored = new Map<string, Buffer>();

function createMemoryStorage(): StorageDriver {
  return {
    provider: 's3',
    put: vi.fn(async ({ key, buffer }: { key: string; buffer: Buffer }) => {
      stored.set(key, Buffer.from(buffer));
    }),
    putFile: vi.fn(async ({ key, path: filePath }: { key: string; path: string }) => {
      stored.set(key, await readFile(filePath));
    }),
    get: vi.fn(async (key: string) => stored.get(key) ?? Buffer.alloc(0)),
    getDownloadUrl: vi.fn().mockResolvedValue('https://mock-signed-url'),
    delete: vi.fn(async (key: string) => {
      stored.delete(key);
    }),
    deletePrefix: vi.fn().mockResolvedValue(undefined),
  } as unknown as StorageDriver;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();
const ADMIN_A_ID = newId();
const UPLOADER_A_ID = newId();
const USER_A_ID = newId();
const ADMIN_B_ID = newId();
const MTA_ID = newId();
const DEPT_A_ID = newId();
const DEPT_B_ID = newId();
const PASSWORD = 'senha-forte-de-teste-123';

/** Cota folgada para os testes que não exercitam cota. */
const BIG_QUOTA = 1024 * 1024 * 1024;

/** Três partes: duas cheias de 10 MiB e uma de 1.000 bytes. */
const FILE_SIZE = 2 * UPLOAD_CHUNK_SIZE_BYTES + 1000;

const UPLOAD_TMP_DIR = path.join(os.tmpdir(), `dmdoc-upload-parts-test-${crypto.randomUUID()}`);

let app: FastifyInstance;
let testDb: TestDb;
let storage: StorageDriver;
let tokenAdminA: string;
let tokenUploaderA: string;
let tokenUserA: string;
let tokenAdminB: string;
let tokenMta: string;

beforeAll(async () => {
  testDb = await startTestDb();
  storage = createMemoryStorage();
  app = await buildApp({
    config: testConfig({ UPLOAD_TMP_DIR }),
    db: testDb.db,
    queue: null,
    storage: staticStorage(storage),
    uploadCleanupIntervalMs: 0,
  });
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
  await rm(UPLOAD_TMP_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  stored.clear();
  const db = testDb.db;
  await db`DELETE FROM upload_sessions`;
  await db`DELETE FROM document_events`;
  await db`DELETE FROM audit_logs`;
  await db`DELETE FROM documents`;
  await db`DELETE FROM department_permissions`;
  await db`DELETE FROM departments`;
  await db`DELETE FROM users`;
  await db`DELETE FROM tenants WHERE id IN (${TENANT_A}, ${TENANT_B})`;

  await db`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
    VALUES
      (${TENANT_A}, 'Empresa A', ${BIG_QUOTA}, 20, true, NOW()),
      (${TENANT_B}, 'Empresa B', ${BIG_QUOTA}, 20, true, NOW())
  `;
  await db`
    INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
    VALUES
      (${DEPT_A_ID}, ${TENANT_A}, NULL, 'Financeiro A', 0, '{}'::text[], false, NOW()),
      (${DEPT_B_ID}, ${TENANT_B}, NULL, 'Financeiro B', 0, '{}'::text[], false, NOW())
  `;
  await seedUser(db, { id: ADMIN_A_ID, tenantId: TENANT_A, email: 'admin-a@up.com', password: PASSWORD, role: 'TENANT_ADMIN' });
  await seedUser(db, { id: UPLOADER_A_ID, tenantId: TENANT_A, email: 'uploader-a@up.com', password: PASSWORD, role: 'UPLOADER' });
  await seedUser(db, { id: USER_A_ID, tenantId: TENANT_A, email: 'user-a@up.com', password: PASSWORD, role: 'USER' });
  await seedUser(db, { id: ADMIN_B_ID, tenantId: TENANT_B, email: 'admin-b@up.com', password: PASSWORD, role: 'TENANT_ADMIN' });
  await seedUser(db, {
    id: MTA_ID,
    tenantId: null,
    email: 'mta@up.com',
    password: PASSWORD,
    role: 'MULTI_TENANT_ADMIN',
    allowedTenantIds: [TENANT_A],
  });
  await db`
    INSERT INTO department_permissions (user_id, department_id, tenant_id, can_read, can_write)
    VALUES (${UPLOADER_A_ID}, ${DEPT_A_ID}, ${TENANT_A}, true, true)
  `;

  tokenAdminA = await login('admin-a@up.com');
  tokenUploaderA = await login('uploader-a@up.com');
  tokenUserA = await login('user-a@up.com');
  tokenAdminB = await login('admin-b@up.com');
  tokenMta = await login('mta@up.com');
});

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return res.json().accessToken as string;
}

// ---------------------------------------------------------------------------
// Helpers do fluxo
// ---------------------------------------------------------------------------

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function randomContent(size = FILE_SIZE): Buffer {
  return crypto.randomBytes(size);
}

function partOf(content: Buffer, n: number): Buffer {
  return content.subarray((n - 1) * UPLOAD_CHUNK_SIZE_BYTES, n * UPLOAD_CHUNK_SIZE_BYTES);
}

async function initUpload(
  token: string,
  overrides: Record<string, unknown> = {}
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'POST',
    url: '/documents/uploads',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      filename: 'video grande.mp4',
      mimeType: 'video/mp4',
      sizeBytes: FILE_SIZE,
      departmentId: DEPT_A_ID,
      ...overrides,
    },
  });
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
}

async function putPart(token: string, uploadId: string, n: number | string, body: Buffer): Promise<number> {
  const res = await app.inject({
    method: 'PUT',
    url: `/documents/uploads/${uploadId}/parts/${n}`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    payload: body,
  });
  return res.statusCode;
}

async function getUpload(token: string, uploadId: string): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'GET',
    url: `/documents/uploads/${uploadId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
}

async function complete(token: string, uploadId: string): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'POST',
    url: `/documents/uploads/${uploadId}/complete`,
    headers: { authorization: `Bearer ${token}` },
  });
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
}

async function abort(token: string, uploadId: string): Promise<number> {
  const res = await app.inject({
    method: 'DELETE',
    url: `/documents/uploads/${uploadId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  return res.statusCode;
}

/** Consulta o GET até sair de COMPLETING (como o front faz). */
async function waitFinished(token: string, uploadId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i += 1) {
    const { body } = await getUpload(token, uploadId);
    if (body['status'] !== 'COMPLETING') return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('upload não terminou a tempo');
}

async function uploadAllParts(token: string, uploadId: string, content: Buffer): Promise<void> {
  // Fora de ordem de propósito: a montagem é por número, não por chegada.
  for (const n of [3, 1, 2]) {
    expect(await putPart(token, uploadId, n, partOf(content, n))).toBe(204);
  }
}

function sessionDir(tenantId: string, uploadId: string): string {
  return path.join(UPLOAD_TMP_DIR, tenantId, uploadId);
}

async function countEvents(tenantId: string): Promise<Array<{ deduplicated: boolean }>> {
  return testDb.db<Array<{ deduplicated: boolean }>>`
    SELECT deduplicated FROM document_events WHERE tenant_id = ${tenantId} ORDER BY created_at
  `;
}

// ---------------------------------------------------------------------------
// Fluxo feliz
// ---------------------------------------------------------------------------

describe('upload em partes — fluxo feliz', () => {
  it('3 partes fora de ordem → complete 202 → COMPLETED com documento PENDING e hash igual ao original', async () => {
    const content = randomContent();
    const init = await initUpload(tokenAdminA, { indexValues: { numero: '123', valor: 10 } });
    expect(init.statusCode).toBe(201);
    expect(init.body['chunkSizeBytes']).toBe(UPLOAD_CHUNK_SIZE_BYTES);
    expect(init.body['totalParts']).toBe(3);
    expect(typeof init.body['expiresAt']).toBe('string');
    const uploadId = init.body['uploadId'] as string;

    await uploadAllParts(tokenAdminA, uploadId, content);
    const status = await getUpload(tokenAdminA, uploadId);
    expect(status.body['status']).toBe('OPEN');
    expect(status.body['receivedParts']).toEqual([1, 2, 3]);

    const res = await complete(tokenAdminA, uploadId);
    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({ uploadId, status: 'COMPLETING' });

    const done = await waitFinished(tokenAdminA, uploadId);
    expect(done['status']).toBe('COMPLETED');
    expect(done['deduplicated']).toBe(false);
    const document = done['document'] as Record<string, unknown>;
    expect(document['status']).toBe('PENDING');
    expect(document['tenantId']).toBe(TENANT_A);
    expect(document['departmentId']).toBe(DEPT_A_ID);
    expect(document['sizeBytes']).toBe(FILE_SIZE);
    expect(document['mimeType']).toBe('video/mp4');
    expect(document['originalFilename']).toBe('video grande.mp4');
    expect(document['contentHash']).toBe(sha256(content));
    expect(document['indexValues']).toEqual({ numero: '123', valor: 10 });

    // Objeto gravado por stream (putFile, nunca put) com o mesmo SHA-256.
    expect(storage.putFile).toHaveBeenCalledOnce();
    expect(storage.put).not.toHaveBeenCalled();
    const object = stored.get(document['storageKey'] as string);
    expect(object).toBeDefined();
    expect(sha256(object!)).toBe(sha256(content));

    // Exatamente um evento de upload, não deduplicado.
    expect(await countEvents(TENANT_A)).toEqual([{ deduplicated: false }]);
    // Partes apagadas.
    expect(existsSync(sessionDir(TENANT_A, uploadId))).toBe(false);
  });

  it('index_values da sessão é gravado como objeto jsonb (sql.json), não string', async () => {
    const init = await initUpload(tokenAdminA, { indexValues: { numero: '42' } });
    const rows = await testDb.db<Array<{ t: string }>>`
      SELECT jsonb_typeof(index_values) AS t FROM upload_sessions WHERE id = ${init.body['uploadId'] as string}
    `;
    expect(rows[0]?.t).toBe('object');
  });

  it('reenvio do mesmo conteúdo → COMPLETED deduplicado, mesmo documento e um evento a mais', async () => {
    const content = randomContent();
    const first = await initUpload(tokenAdminA);
    await uploadAllParts(tokenAdminA, first.body['uploadId'] as string, content);
    await complete(tokenAdminA, first.body['uploadId'] as string);
    const firstDone = await waitFinished(tokenAdminA, first.body['uploadId'] as string);
    const firstDoc = firstDone['document'] as Record<string, unknown>;

    const second = await initUpload(tokenUploaderA, { filename: 'outro nome.mp4' });
    expect(second.statusCode).toBe(201);
    const secondId = second.body['uploadId'] as string;
    await uploadAllParts(tokenUploaderA, secondId, content);
    expect((await complete(tokenUploaderA, secondId)).statusCode).toBe(202);
    const secondDone = await waitFinished(tokenUploaderA, secondId);

    expect(secondDone['status']).toBe('COMPLETED');
    expect(secondDone['deduplicated']).toBe(true);
    expect((secondDone['document'] as Record<string, unknown>)['id']).toBe(firstDoc['id']);
    expect(storage.putFile).toHaveBeenCalledOnce();
    expect(await countEvents(TENANT_A)).toEqual([{ deduplicated: false }, { deduplicated: true }]);
    const docs = await testDb.db`SELECT id FROM documents WHERE tenant_id = ${TENANT_A}`;
    expect(docs).toHaveLength(1);
    expect(existsSync(sessionDir(TENANT_A, secondId))).toBe(false);
  });

  it('MULTI_TENANT_ADMIN abre sessão informando a empresa permitida', async () => {
    const init = await initUpload(tokenMta, { tenantId: TENANT_A });
    expect(init.statusCode).toBe(201);
    const outra = await initUpload(tokenMta, { tenantId: TENANT_B, departmentId: DEPT_B_ID });
    expect(outra.statusCode).toBe(404);
  });

  it('mimeType application/octet-stream é aceito como no upload simples', async () => {
    const init = await initUpload(tokenAdminA, { mimeType: 'application/octet-stream' });
    expect(init.statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Validação e estados
// ---------------------------------------------------------------------------

describe('upload em partes — validação e estados', () => {
  it('parte com tamanho diferente do esperado → 422 e não conta como recebida', async () => {
    const init = await initUpload(tokenAdminA);
    const uploadId = init.body['uploadId'] as string;
    expect(await putPart(tokenAdminA, uploadId, 1, Buffer.alloc(1234))).toBe(422);
    expect(await putPart(tokenAdminA, uploadId, 3, Buffer.alloc(1001))).toBe(422);
    const status = await getUpload(tokenAdminA, uploadId);
    expect(status.body['receivedParts']).toEqual([]);
    expect(existsSync(path.join(sessionDir(TENANT_A, uploadId), '1.part'))).toBe(false);
  });

  it('número de parte fora do intervalo → 400', async () => {
    const init = await initUpload(tokenAdminA);
    const uploadId = init.body['uploadId'] as string;
    expect(await putPart(tokenAdminA, uploadId, 0, Buffer.alloc(10))).toBe(400);
    expect(await putPart(tokenAdminA, uploadId, 4, Buffer.alloc(10))).toBe(400);
    expect(await putPart(tokenAdminA, uploadId, 'abc', Buffer.alloc(10))).toBe(400);
  });

  it('reenviar a mesma parte sobrescreve (idempotente)', async () => {
    const content = randomContent();
    const init = await initUpload(tokenAdminA);
    const uploadId = init.body['uploadId'] as string;
    expect(await putPart(tokenAdminA, uploadId, 3, Buffer.alloc(1000, 7))).toBe(204);
    await uploadAllParts(tokenAdminA, uploadId, content);
    expect((await getUpload(tokenAdminA, uploadId)).body['receivedParts']).toEqual([1, 2, 3]);
    await complete(tokenAdminA, uploadId);
    const done = await waitFinished(tokenAdminA, uploadId);
    expect((done['document'] as Record<string, unknown>)['contentHash']).toBe(sha256(content));
  });

  it('complete com parte faltando → 409; PUT depois de concluído → 409', async () => {
    const content = randomContent();
    const init = await initUpload(tokenAdminA);
    const uploadId = init.body['uploadId'] as string;
    expect(await putPart(tokenAdminA, uploadId, 1, partOf(content, 1))).toBe(204);
    expect((await complete(tokenAdminA, uploadId)).statusCode).toBe(409);

    await uploadAllParts(tokenAdminA, uploadId, content);
    expect((await complete(tokenAdminA, uploadId)).statusCode).toBe(202);
    await waitFinished(tokenAdminA, uploadId);
    expect(await putPart(tokenAdminA, uploadId, 1, partOf(content, 1))).toBe(409);
    expect((await complete(tokenAdminA, uploadId)).statusCode).toBe(409);
  });

  it('dois complete simultâneos: um 202, o outro 409, e um único documento', async () => {
    const content = randomContent();
    const init = await initUpload(tokenAdminA);
    const uploadId = init.body['uploadId'] as string;
    await uploadAllParts(tokenAdminA, uploadId, content);

    const results = await Promise.all([complete(tokenAdminA, uploadId), complete(tokenAdminA, uploadId)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([202, 409]);
    const done = await waitFinished(tokenAdminA, uploadId);
    expect(done['status']).toBe('COMPLETED');
    expect(await testDb.db`SELECT id FROM documents WHERE tenant_id = ${TENANT_A}`).toHaveLength(1);
    expect(await countEvents(TENANT_A)).toHaveLength(1);
  });

  it('DELETE de sessão aberta → 204, ABORTED e partes apagadas; DELETE em COMPLETING/COMPLETED → 409', async () => {
    const content = randomContent();
    const init = await initUpload(tokenAdminA);
    const uploadId = init.body['uploadId'] as string;
    expect(await putPart(tokenAdminA, uploadId, 1, partOf(content, 1))).toBe(204);
    expect(existsSync(sessionDir(TENANT_A, uploadId))).toBe(true);
    expect(await abort(tokenAdminA, uploadId)).toBe(204);
    expect((await getUpload(tokenAdminA, uploadId)).body['status']).toBe('ABORTED');
    expect(existsSync(sessionDir(TENANT_A, uploadId))).toBe(false);
    expect(await putPart(tokenAdminA, uploadId, 1, partOf(content, 1))).toBe(409);

    const other = await initUpload(tokenAdminA);
    const otherId = other.body['uploadId'] as string;
    await testDb.db`UPDATE upload_sessions SET status = 'COMPLETING', completing_started_at = now() WHERE id = ${otherId}`;
    expect(await abort(tokenAdminA, otherId)).toBe(409);
    await testDb.db`UPDATE upload_sessions SET status = 'COMPLETED' WHERE id = ${otherId}`;
    expect(await abort(tokenAdminA, otherId)).toBe(409);
  });

  it('corpo de abertura inválido → 400; tamanho acima de MAX_UPLOAD_MB → 413 JSON', async () => {
    const semNome = await initUpload(tokenAdminA, { filename: '' });
    expect(semNome.statusCode).toBe(400);
    const tamanhoInvalido = await initUpload(tokenAdminA, { sizeBytes: 0 });
    expect(tamanhoInvalido.statusCode).toBe(400);
    const grande = await initUpload(tokenAdminA, { sizeBytes: 501 * 1024 * 1024 });
    expect(grande.statusCode).toBe(413);
    expect((grande.body['error'] as Record<string, unknown>)['code']).toBe('FILE_TOO_LARGE');
    expect(await testDb.db`SELECT id FROM upload_sessions`).toHaveLength(0);
  });

  it('departamento de outra empresa ou inexistente → 404 na abertura', async () => {
    expect((await initUpload(tokenAdminA, { departmentId: DEPT_B_ID })).statusCode).toBe(404);
    expect((await initUpload(tokenAdminA, { departmentId: newId() })).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Cota
// ---------------------------------------------------------------------------

describe('upload em partes — cota de disco', () => {
  it('cota estourada pelo tamanho declarado → 422 QUOTA_EXCEEDED na abertura, sem sessão', async () => {
    await testDb.db`UPDATE tenants SET disk_quota_bytes = ${FILE_SIZE - 1} WHERE id = ${TENANT_A}`;
    const init = await initUpload(tokenAdminA);
    expect(init.statusCode).toBe(422);
    expect((init.body['error'] as Record<string, unknown>)['code']).toBe('QUOTA_EXCEEDED');
    expect(await testDb.db`SELECT id FROM upload_sessions`).toHaveLength(0);
    expect(await countEvents(TENANT_A)).toHaveLength(0);
  });

  it('cota estourada na conclusão → FAILED QUOTA_EXCEEDED, sem objeto, sem documento, sem evento e sem diretório', async () => {
    const content = randomContent();
    const init = await initUpload(tokenAdminA);
    const uploadId = init.body['uploadId'] as string;
    await uploadAllParts(tokenAdminA, uploadId, content);

    // A cota encolhe entre a abertura e a conclusão (outro upload ocupou o espaço).
    await testDb.db`UPDATE tenants SET disk_quota_bytes = ${FILE_SIZE - 1} WHERE id = ${TENANT_A}`;
    expect((await complete(tokenAdminA, uploadId)).statusCode).toBe(202);
    const done = await waitFinished(tokenAdminA, uploadId);

    expect(done['status']).toBe('FAILED');
    expect((done['error'] as Record<string, unknown>)['code']).toBe('QUOTA_EXCEEDED');
    expect(done['document']).toBeUndefined();
    expect(storage.putFile).not.toHaveBeenCalled();
    expect(stored.size).toBe(0);
    expect(await testDb.db`SELECT id FROM documents WHERE tenant_id = ${TENANT_A}`).toHaveLength(0);
    expect(await countEvents(TENANT_A)).toHaveLength(0);
    expect(existsSync(sessionDir(TENANT_A, uploadId))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Isolamento
// ---------------------------------------------------------------------------

describe('upload em partes — isolamento', () => {
  async function expectAllRoutes404(token: string, uploadId: string, part: Buffer): Promise<void> {
    expect((await getUpload(token, uploadId)).statusCode).toBe(404);
    expect(await putPart(token, uploadId, 1, part)).toBe(404);
    expect((await complete(token, uploadId)).statusCode).toBe(404);
    expect(await abort(token, uploadId)).toBe(404);
  }

  it('sessão de OUTRA empresa → 404 em GET, PUT, complete e DELETE', async () => {
    const content = randomContent();
    const init = await initUpload(tokenAdminA);
    const uploadId = init.body['uploadId'] as string;
    await uploadAllParts(tokenAdminA, uploadId, content);

    await expectAllRoutes404(tokenAdminB, uploadId, partOf(content, 1));
    // Nada mudou na sessão do dono.
    const status = await getUpload(tokenAdminA, uploadId);
    expect(status.body['status']).toBe('OPEN');
  });

  it('sessão de OUTRO usuário da mesma empresa → 404 em GET, PUT, complete e DELETE', async () => {
    const content = randomContent();
    const init = await initUpload(tokenAdminA);
    const uploadId = init.body['uploadId'] as string;
    await uploadAllParts(tokenAdminA, uploadId, content);

    await expectAllRoutes404(tokenUploaderA, uploadId, partOf(content, 1));
    expect((await getUpload(tokenAdminA, uploadId)).body['status']).toBe('OPEN');
  });

  it('MULTI_TENANT_ADMIN sem a empresa da sessão na lista → 404', async () => {
    const init = await initUpload(tokenMta, { tenantId: TENANT_A });
    const uploadId = init.body['uploadId'] as string;
    await testDb.db`UPDATE users SET allowed_tenant_ids = ${[TENANT_B]}::uuid[] WHERE id = ${MTA_ID}`;
    const token = await login('mta@up.com');
    expect((await getUpload(token, uploadId)).statusCode).toBe(404);
  });

  it('id malformado → 404', async () => {
    expect((await getUpload(tokenAdminA, 'nao-e-uuid')).statusCode).toBe(404);
  });

  it('USER (somente leitura) → 403 antes de qualquer leitura', async () => {
    const init = await initUpload(tokenAdminA);
    const uploadId = init.body['uploadId'] as string;
    expect((await initUpload(tokenUserA)).statusCode).toBe(403);
    expect((await getUpload(tokenUserA, uploadId)).statusCode).toBe(403);
    expect(await putPart(tokenUserA, uploadId, 1, Buffer.alloc(10))).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Limpeza periódica
// ---------------------------------------------------------------------------

describe('upload em partes — limpeza de sessões', () => {
  it('sessão OPEN vencida vira EXPIRED e some do disco', async () => {
    const content = randomContent();
    const init = await initUpload(tokenAdminA);
    const uploadId = init.body['uploadId'] as string;
    expect(await putPart(tokenAdminA, uploadId, 1, partOf(content, 1))).toBe(204);
    expect(existsSync(sessionDir(TENANT_A, uploadId))).toBe(true);

    await testDb.db`UPDATE upload_sessions SET expires_at = now() - interval '1 minute' WHERE id = ${uploadId}`;
    // Antes da limpeza o cliente já vê EXPIRED e não consegue mais enviar.
    expect((await getUpload(tokenAdminA, uploadId)).body['status']).toBe('EXPIRED');
    expect(await putPart(tokenAdminA, uploadId, 2, partOf(content, 2))).toBe(409);

    const result = await cleanupUploadSessions({ sql: testDb.db, uploadTmpDir: UPLOAD_TMP_DIR, log: app.log });
    expect(result.expired).toBe(1);
    const rows = await testDb.db<Array<{ status: string }>>`SELECT status FROM upload_sessions WHERE id = ${uploadId}`;
    expect(rows[0]?.status).toBe('EXPIRED');
    expect(existsSync(sessionDir(TENANT_A, uploadId))).toBe(false);
  });

  it('sessão presa em COMPLETING além do TTL vira FAILED; diretório órfão é apagado', async () => {
    const content = randomContent();
    const init = await initUpload(tokenAdminA);
    const uploadId = init.body['uploadId'] as string;
    expect(await putPart(tokenAdminA, uploadId, 1, partOf(content, 1))).toBe(204);
    await testDb.db`
      UPDATE upload_sessions
         SET status = 'COMPLETING', completing_started_at = now() - interval '25 hours'
       WHERE id = ${uploadId}
    `;

    // Diretório de uma sessão que não existe mais (ex.: empresa purgada).
    const orphan = sessionDir(TENANT_B, crypto.randomUUID());
    await import('node:fs/promises').then((fs) => fs.mkdir(orphan, { recursive: true }));

    const result = await cleanupUploadSessions({ sql: testDb.db, uploadTmpDir: UPLOAD_TMP_DIR, log: app.log });
    expect(result.failed).toBe(1);
    expect(result.orphanDirs).toBe(1);
    const done = await getUpload(tokenAdminA, uploadId);
    expect(done.body['status']).toBe('FAILED');
    expect((done.body['error'] as Record<string, unknown>)['code']).toBe('COMPLETION_INTERRUPTED');
    expect(existsSync(sessionDir(TENANT_A, uploadId))).toBe(false);
    expect(existsSync(orphan)).toBe(false);
  });

  it('sessão aberta dentro do prazo não é tocada', async () => {
    const content = randomContent();
    const init = await initUpload(tokenAdminA);
    const uploadId = init.body['uploadId'] as string;
    expect(await putPart(tokenAdminA, uploadId, 1, partOf(content, 1))).toBe(204);
    const result = await cleanupUploadSessions({ sql: testDb.db, uploadTmpDir: UPLOAD_TMP_DIR, log: app.log });
    expect(result).toEqual({ expired: 0, failed: 0, orphanDirs: 0 });
    expect(existsSync(path.join(sessionDir(TENANT_A, uploadId), '1.part'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Convivência com o upload simples
// ---------------------------------------------------------------------------

describe('upload em partes — convivência com POST /documents', () => {
  it('conteúdo já enviado pelo upload simples é deduplicado na conclusão', async () => {
    const content = randomContent();
    const form = new FormData();
    form.append('file', content, { filename: 'a.mp4', contentType: 'video/mp4' });
    form.append('departmentId', DEPT_A_ID);
    const simple = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...(form.getHeaders() as Record<string, string>) },
      payload: form.getBuffer(),
    });
    expect(simple.statusCode).toBe(201);

    const init = await initUpload(tokenAdminA);
    const uploadId = init.body['uploadId'] as string;
    await uploadAllParts(tokenAdminA, uploadId, content);
    await complete(tokenAdminA, uploadId);
    const done = await waitFinished(tokenAdminA, uploadId);
    expect(done['deduplicated']).toBe(true);
    expect((done['document'] as Record<string, unknown>)['id']).toBe((simple.json() as Record<string, unknown>)['id']);
  });
});
