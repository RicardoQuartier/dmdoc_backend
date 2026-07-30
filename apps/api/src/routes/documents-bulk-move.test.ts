import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import {
  startTestDb,
  seedUser,
  testConfig,
  resetDomainTables,
  type TestDb,
  staticStorage,
} from '../test/helpers.js';
import type { StorageDriver } from '@dmdoc/storage';
import { newId } from '@dmdoc/db-pg';

/**
 * E2E do move em massa (épico E-9 / T-111): `POST /documents/bulk-move`.
 *
 * A operação é SÍNCRONA e roda numa única transação — não há lote, fila nem
 * polling. A matriz de casos espelha `bulk-delete.test.ts`, porque os riscos
 * são os mesmos de qualquer `= ANY` em massa:
 *   - ALL-OR-NOTHING: um id fora do escopo (inexistente, de outra empresa, sem
 *     ACL) recusa a seleção INTEIRA — nenhum dos ids válidos é movido;
 *   - escopo cirúrgico: só os ids enviados mudam de departamento; documento
 *     não selecionado no MESMO departamento de origem nem sequer é reescrito;
 *   - isolamento multi-tenant: id de outra empresa → 404, nunca 403;
 *   - seleção cross-tenant de um SUPER_ADMIN → 422 (uso inválido da API, não
 *     vazamento);
 *   - contagem vinda do `RETURNING` (dedupe de ids; documento que já estava no
 *     destino não conta como movido);
 *   - sincronização `documents` × `chunks` na mesma transação — é
 *     `chunks.department_id` que a busca usa para filtrar acesso.
 *
 * -------------------------------------------------------------------------
 * DIVERGÊNCIA DELIBERADA EM RELAÇÃO AO `bulk-delete`
 * -------------------------------------------------------------------------
 * `POST /documents/bulk-delete` exige `ADMIN_ROLES` (UPLOADER e USER levam
 * 403). `POST /documents/bulk-move` NÃO exige: mover é REVERSÍVEL (basta mover
 * de volta) e o `UPLOADER` já pode enviar documento em qualquer departamento
 * onde tem ACL — mover é a mesma capacidade. O gate aqui é apenas ACL de
 * ESCRITA na ORIGEM e no DESTINO, e o papel `USER` (somente leitura) continua
 * barrado com 404 (nunca 403 — spec §10, invariante 4). Há um teste dedicado
 * que exercita as duas rotas com o MESMO UPLOADER para fixar a assimetria.
 *
 * Teto: `BULK_MOVE_MAX = 100`, e não os 500 dos demais `BULK_*_MAX` — mover
 * reescreve `chunks`, e cada linha carrega um `vector(1536)`.
 */

function createMockS3(): StorageDriver {
  return {
    provider: 's3',
    put: vi.fn().mockResolvedValue(undefined),
    getDownloadUrl: vi.fn().mockResolvedValue('https://mock-signed-url'),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as StorageDriver;
}

// UUIDs de tenant por arquivo — evita colisão no `dmdoc_test` compartilhado.
const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();

const ADMIN_A_ID = crypto.randomUUID();
const UPLOADER_A_ID = crypto.randomUUID();
const USER_A_ID = crypto.randomUUID();
const ADMIN_B_ID = crypto.randomUUID();
const SUPER_ID = crypto.randomUUID();
const MTA_ID = crypto.randomUUID();

const DEPT_ORIGEM = newId();
const DEPT_ORIGEM_2 = newId();
const DEPT_DESTINO = newId();
const DEPT_ISOLADO = newId();
const DEPT_ARQUIVADO = newId();
const DEPT_B = newId();

const PASSWORD = 'senha-forte-de-teste-123';
const DISK_QUOTA = 10 * 1024 * 1024;
/** Vetor de 1536 dimensões — `chunks.embedding` é NOT NULL. */
const ZERO_EMBEDDING = `[${new Array(1536).fill(0).join(',')}]`;

let app: FastifyInstance;
let testDb: TestDb;
let s3Mock: StorageDriver;

let tokenAdminA: string;
let tokenUploaderA: string;
let tokenUserA: string;
let tokenSuper: string;
let tokenMta: string;

// TENANT_A / DEPT_ORIGEM (o UPLOADER tem ACL aqui)
let DOC_1 = '';
let DOC_2 = '';
let DOC_3 = '';
// TENANT_A / DEPT_ORIGEM_2 (também com ACL) — prova o audit com duas origens
let DOC_OUTRA_ORIGEM = '';
// TENANT_A / DEPT_DESTINO — já está no destino
let DOC_JA_NO_DESTINO = '';
// TENANT_A / DEPT_ISOLADO — sem concessão ao UPLOADER
let DOC_ISOLADO = '';
// TENANT_B
let DOC_B = '';

async function login(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return res.json().accessToken as string;
}

/** Cria documento + chunks no MESMO departamento (estado consistente). */
async function seedDocument(params: {
  tenantId: string;
  departmentId: string;
  uploadedById: string;
  chunkCount?: number;
}): Promise<string> {
  const { tenantId, departmentId, uploadedById } = params;
  const chunkCount = params.chunkCount ?? 2;
  const id = newId();
  const hash = crypto.randomBytes(32).toString('hex');

  await testDb.db`
    INSERT INTO documents (
      id, tenant_id, department_id, document_type_id, filename, original_filename,
      content_hash, size_bytes, mime_type, storage_key, status, failure_reason,
      uploaded_by_id, uploaded_at, index_values, tags, deleted
    ) VALUES (
      ${id}, ${tenantId}, ${departmentId}, NULL, ${'f-' + id + '.pdf'}, 'doc.pdf',
      ${hash}, ${1234}, 'application/pdf', ${'s3/' + id}, 'READY', NULL,
      ${uploadedById}, NOW(), '{}'::jsonb, '{}'::text[], false
    )
  `;

  for (let i = 0; i < chunkCount; i += 1) {
    await testDb.db`
      INSERT INTO chunks (
        id, document_id, tenant_id, department_id, chunk_index, text, embedding, token_count
      ) VALUES (
        ${newId()}, ${id}, ${tenantId}, ${departmentId}, ${i},
        ${`trecho ${i} do documento ${id}`}, ${ZERO_EMBEDDING}::vector, 5
      )
    `;
  }

  return id;
}

async function docDepartment(documentId: string): Promise<string> {
  const rows = await testDb.db<Array<{ department_id: string }>>`
    SELECT department_id FROM documents WHERE id = ${documentId}
  `;
  return rows[0]!.department_id;
}

/** Departamentos DISTINTOS dos chunks + total de chunks do documento. */
async function chunkState(
  documentId: string
): Promise<{ departments: string[]; total: number }> {
  const rows = await testDb.db<Array<{ department_id: string; n: number }>>`
    SELECT department_id, count(*)::int AS n
    FROM chunks
    WHERE document_id = ${documentId}
    GROUP BY department_id
    ORDER BY department_id
  `;
  return {
    departments: rows.map((r) => r.department_id),
    total: rows.reduce((acc, r) => acc + Number(r.n), 0),
  };
}

/** Versão física (`xmin`) de cada chunk — prova que a linha NÃO foi reescrita. */
async function chunkVersions(documentId: string): Promise<string[]> {
  const rows = await testDb.db<Array<{ id: string; xmin: string }>>`
    SELECT id, xmin::text AS xmin FROM chunks WHERE document_id = ${documentId} ORDER BY chunk_index
  `;
  return rows.map((r) => `${r.id}:${r.xmin}`);
}

/** Documento inteiro num objeto só: departamento + estado dos chunks. */
async function snapshot(
  documentId: string
): Promise<{ department: string; departments: string[]; total: number }> {
  const chunks = await chunkState(documentId);
  return { department: await docDepartment(documentId), ...chunks };
}

async function countAudit(action: string): Promise<number> {
  const rows = await testDb.db<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM audit_logs WHERE action = ${action}
  `;
  return Number(rows[0]?.n ?? 0);
}

async function grant(userId: string, departmentId: string): Promise<void> {
  await testDb.db`
    INSERT INTO department_permissions (id, tenant_id, user_id, department_id, can_read, can_write, deleted)
    VALUES (${newId()}, ${TENANT_A}, ${userId}, ${departmentId}, true, true, false)
  `;
}

function bulkMove(token: string, documentIds: unknown, departmentId: unknown) {
  return app.inject({
    method: 'POST',
    url: '/documents/bulk-move',
    headers: { authorization: `Bearer ${token}` },
    payload: { documentIds, departmentId },
  });
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
      (${DEPT_ORIGEM}, ${TENANT_A}, NULL, 'Origem A', 0, '{}'::text[], false, NOW()),
      (${DEPT_ORIGEM_2}, ${TENANT_A}, NULL, 'Origem A2', 0, '{}'::text[], false, NOW()),
      (${DEPT_DESTINO}, ${TENANT_A}, NULL, 'Destino A', 0, '{}'::text[], false, NOW()),
      (${DEPT_ISOLADO}, ${TENANT_A}, NULL, 'Isolado A', 0, '{}'::text[], false, NOW()),
      (${DEPT_ARQUIVADO}, ${TENANT_A}, NULL, 'Arquivado A', 0, '{}'::text[], true, NOW()),
      (${DEPT_B}, ${TENANT_B}, NULL, 'Financeiro B', 0, '{}'::text[], false, NOW())
  `;

  await seedUser(testDb.db, { id: ADMIN_A_ID, tenantId: TENANT_A, email: 'admin-a@bulkmove.com', password: PASSWORD, role: 'TENANT_ADMIN' });
  await seedUser(testDb.db, { id: UPLOADER_A_ID, tenantId: TENANT_A, email: 'uploader-a@bulkmove.com', password: PASSWORD, role: 'UPLOADER' });
  await seedUser(testDb.db, { id: USER_A_ID, tenantId: TENANT_A, email: 'user-a@bulkmove.com', password: PASSWORD, role: 'USER' });
  await seedUser(testDb.db, { id: ADMIN_B_ID, tenantId: TENANT_B, email: 'admin-b@bulkmove.com', password: PASSWORD, role: 'TENANT_ADMIN' });
  await seedUser(testDb.db, { id: SUPER_ID, tenantId: null, email: 'super@bulkmove.com', password: PASSWORD, role: 'SUPER_ADMIN' });
  await seedUser(testDb.db, {
    id: MTA_ID,
    tenantId: null,
    email: 'mta@bulkmove.com',
    password: PASSWORD,
    role: 'MULTI_TENANT_ADMIN',
    allowedTenantIds: [TENANT_A],
  });

  // ACL de escrita do UPLOADER nas duas origens e no destino — mas NÃO em
  // DEPT_ISOLADO, que é o departamento usado para provar o all-or-nothing.
  // O USER recebe as mesmas raízes: seu 404 vem do PAPEL, não de falta de ACL.
  await grant(UPLOADER_A_ID, DEPT_ORIGEM);
  await grant(UPLOADER_A_ID, DEPT_ORIGEM_2);
  await grant(UPLOADER_A_ID, DEPT_DESTINO);
  await grant(USER_A_ID, DEPT_ORIGEM);
  await grant(USER_A_ID, DEPT_DESTINO);

  DOC_1 = await seedDocument({ tenantId: TENANT_A, departmentId: DEPT_ORIGEM, uploadedById: ADMIN_A_ID, chunkCount: 3 });
  DOC_2 = await seedDocument({ tenantId: TENANT_A, departmentId: DEPT_ORIGEM, uploadedById: ADMIN_A_ID, chunkCount: 2 });
  DOC_3 = await seedDocument({ tenantId: TENANT_A, departmentId: DEPT_ORIGEM, uploadedById: ADMIN_A_ID, chunkCount: 1 });
  DOC_OUTRA_ORIGEM = await seedDocument({ tenantId: TENANT_A, departmentId: DEPT_ORIGEM_2, uploadedById: ADMIN_A_ID, chunkCount: 2 });
  DOC_JA_NO_DESTINO = await seedDocument({ tenantId: TENANT_A, departmentId: DEPT_DESTINO, uploadedById: ADMIN_A_ID, chunkCount: 2 });
  DOC_ISOLADO = await seedDocument({ tenantId: TENANT_A, departmentId: DEPT_ISOLADO, uploadedById: ADMIN_A_ID, chunkCount: 2 });
  DOC_B = await seedDocument({ tenantId: TENANT_B, departmentId: DEPT_B, uploadedById: ADMIN_B_ID, chunkCount: 2 });

  tokenAdminA = await login('admin-a@bulkmove.com');
  tokenUploaderA = await login('uploader-a@bulkmove.com');
  tokenUserA = await login('user-a@bulkmove.com');
  tokenSuper = await login('super@bulkmove.com');
  tokenMta = await login('mta@bulkmove.com');
});

describe('POST /documents/bulk-move — move em lote e escopo cirúrgico', () => {
  it('move 3 documentos: 200 { moved: 3, requested: 3 } com todos os chunks sincronizados', async () => {
    const res = await bulkMove(tokenAdminA, [DOC_1, DOC_2, DOC_3], DEPT_DESTINO);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ moved: 3, requested: 3 });

    expect(await snapshot(DOC_1)).toEqual({ department: DEPT_DESTINO, departments: [DEPT_DESTINO], total: 3 });
    expect(await snapshot(DOC_2)).toEqual({ department: DEPT_DESTINO, departments: [DEPT_DESTINO], total: 2 });
    expect(await snapshot(DOC_3)).toEqual({ department: DEPT_DESTINO, departments: [DEPT_DESTINO], total: 1 });
  });

  it('ESCOPO CIRÚRGICO: documento não selecionado no mesmo departamento de origem não se move nem é reescrito', async () => {
    const versoesAntes = await chunkVersions(DOC_3);

    const res = await bulkMove(tokenAdminA, [DOC_1, DOC_2], DEPT_DESTINO);
    expect(res.statusCode).toBe(200);
    expect(res.json().moved).toBe(2);

    // O bug clássico seria um UPDATE por departamento de origem em vez de por
    // id: DOC_3 está no MESMO DEPT_ORIGEM e não foi selecionado.
    expect(await snapshot(DOC_3)).toEqual({ department: DEPT_ORIGEM, departments: [DEPT_ORIGEM], total: 1 });
    expect(await chunkVersions(DOC_3)).toEqual(versoesAntes);
    // E o documento da outra empresa, idem.
    expect(await snapshot(DOC_B)).toEqual({ department: DEPT_B, departments: [DEPT_B], total: 2 });
  });

  it('ids duplicados contam uma vez só em requested e em moved', async () => {
    const res = await bulkMove(tokenAdminA, [DOC_1, DOC_1, DOC_2, DOC_1, DOC_2], DEPT_DESTINO);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ moved: 2, requested: 2 });
    expect(await docDepartment(DOC_1)).toBe(DEPT_DESTINO);
    expect(await docDepartment(DOC_2)).toBe(DEPT_DESTINO);
  });

  it('documento que já estava no destino não conta em moved (a contagem vem do RETURNING)', async () => {
    const res = await bulkMove(tokenAdminA, [DOC_1, DOC_JA_NO_DESTINO], DEPT_DESTINO);

    expect(res.statusCode).toBe(200);
    // `requested` conta documentos resolvidos; `moved`, linhas efetivamente
    // alteradas — o `AND department_id <> destino` exclui o que já estava lá.
    expect(res.json()).toEqual({ moved: 1, requested: 2 });
    expect(await docDepartment(DOC_JA_NO_DESTINO)).toBe(DEPT_DESTINO);
  });

  it('reconcilia chunks defasados de um documento que JÁ estava no destino', async () => {
    // Simula o resultado de um move que perdeu a corrida com o worker: o
    // documento está no destino, mas os chunks ficaram no departamento antigo.
    await testDb.db`
      UPDATE chunks SET department_id = ${DEPT_ORIGEM} WHERE document_id = ${DOC_JA_NO_DESTINO}
    `;

    const res = await bulkMove(tokenAdminA, [DOC_JA_NO_DESTINO], DEPT_DESTINO);

    expect(res.statusCode).toBe(200);
    // Não é "movido" (documents já estava certo), mas os chunks são corrigidos:
    // o UPDATE de chunks roda sobre os ids pedidos, não sobre o RETURNING.
    expect(res.json()).toEqual({ moved: 0, requested: 1 });
    expect(await chunkState(DOC_JA_NO_DESTINO)).toEqual({ departments: [DEPT_DESTINO], total: 2 });
  });

  it('move documentos de DUAS origens distintas de uma vez', async () => {
    const res = await bulkMove(tokenAdminA, [DOC_1, DOC_OUTRA_ORIGEM], DEPT_DESTINO);

    expect(res.statusCode).toBe(200);
    expect(res.json().moved).toBe(2);
    expect(await snapshot(DOC_1)).toEqual({ department: DEPT_DESTINO, departments: [DEPT_DESTINO], total: 3 });
    expect(await snapshot(DOC_OUTRA_ORIGEM)).toEqual({ department: DEPT_DESTINO, departments: [DEPT_DESTINO], total: 2 });
  });

  it('MTA com a empresa na lista permitida move normalmente', async () => {
    const res = await bulkMove(tokenMta, [DOC_1], DEPT_DESTINO);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ moved: 1, requested: 1 });
    expect(await snapshot(DOC_1)).toEqual({ department: DEPT_DESTINO, departments: [DEPT_DESTINO], total: 3 });
  });
});

describe('POST /documents/bulk-move — all-or-nothing', () => {
  it('id inexistente na seleção → 404 e NENHUM dos válidos é movido', async () => {
    const res = await bulkMove(tokenAdminA, [DOC_1, DOC_2, crypto.randomUUID()], DEPT_DESTINO);

    expect(res.statusCode).toBe(404);
    expect(await snapshot(DOC_1)).toEqual({ department: DEPT_ORIGEM, departments: [DEPT_ORIGEM], total: 3 });
    expect(await snapshot(DOC_2)).toEqual({ department: DEPT_ORIGEM, departments: [DEPT_ORIGEM], total: 2 });
    expect(await countAudit('document.bulk_move')).toBe(0);
  });

  it('ISOLAMENTO: id de outra empresa → 404, e nada escrito nem em A nem em B', async () => {
    const res = await bulkMove(tokenAdminA, [DOC_1, DOC_B], DEPT_DESTINO);

    expect(res.statusCode).toBe(404);
    expect(await snapshot(DOC_1)).toEqual({ department: DEPT_ORIGEM, departments: [DEPT_ORIGEM], total: 3 });
    expect(await snapshot(DOC_B)).toEqual({ department: DEPT_B, departments: [DEPT_B], total: 2 });
    expect(await countAudit('document.bulk_move')).toBe(0);
  });

  it('ISOLAMENTO: MTA sem a empresa na lista permitida → 404', async () => {
    const res = await bulkMove(tokenMta, [DOC_B], DEPT_B);

    expect(res.statusCode).toBe(404);
    expect(await snapshot(DOC_B)).toEqual({ department: DEPT_B, departments: [DEPT_B], total: 2 });
  });

  it('ACL: um documento em departamento SEM concessão → 404 e nenhum dos demais é movido', async () => {
    const res = await bulkMove(tokenUploaderA, [DOC_1, DOC_ISOLADO], DEPT_DESTINO);

    expect(res.statusCode).toBe(404);
    expect(await snapshot(DOC_1)).toEqual({ department: DEPT_ORIGEM, departments: [DEPT_ORIGEM], total: 3 });
    expect(await snapshot(DOC_ISOLADO)).toEqual({ department: DEPT_ISOLADO, departments: [DEPT_ISOLADO], total: 2 });
  });

  it('ACL: destino SEM concessão → 404 e nada movido', async () => {
    const res = await bulkMove(tokenUploaderA, [DOC_1, DOC_2], DEPT_ISOLADO);

    expect(res.statusCode).toBe(404);
    expect(await snapshot(DOC_1)).toEqual({ department: DEPT_ORIGEM, departments: [DEPT_ORIGEM], total: 3 });
    expect(await snapshot(DOC_2)).toEqual({ department: DEPT_ORIGEM, departments: [DEPT_ORIGEM], total: 2 });
  });

  it('destino soft-deletado → 404 e nada movido', async () => {
    const res = await bulkMove(tokenAdminA, [DOC_1, DOC_2], DEPT_ARQUIVADO);

    expect(res.statusCode).toBe(404);
    expect(await snapshot(DOC_1)).toEqual({ department: DEPT_ORIGEM, departments: [DEPT_ORIGEM], total: 3 });
    expect(await snapshot(DOC_2)).toEqual({ department: DEPT_ORIGEM, departments: [DEPT_ORIGEM], total: 2 });
  });

  it('documento já excluído na lista → 404 (a resolução filtra deleted = false)', async () => {
    await testDb.db`UPDATE documents SET deleted = true WHERE id = ${DOC_3}`;

    const res = await bulkMove(tokenAdminA, [DOC_1, DOC_3], DEPT_DESTINO);

    expect(res.statusCode).toBe(404);
    expect(await snapshot(DOC_1)).toEqual({ department: DEPT_ORIGEM, departments: [DEPT_ORIGEM], total: 3 });
  });

  it('SUPER_ADMIN com ids de DUAS empresas → 422 e nada movido', async () => {
    const res = await bulkMove(tokenSuper, [DOC_1, DOC_B], DEPT_DESTINO);

    expect(res.statusCode).toBe(422);
    expect(await snapshot(DOC_1)).toEqual({ department: DEPT_ORIGEM, departments: [DEPT_ORIGEM], total: 3 });
    expect(await snapshot(DOC_B)).toEqual({ department: DEPT_B, departments: [DEPT_B], total: 2 });
    expect(await countAudit('document.bulk_move')).toBe(0);
  });
});

describe('POST /documents/bulk-move — validação do body', () => {
  it('mais de 100 ids (BULK_MOVE_MAX) → 422 e nada movido', async () => {
    const demais = [DOC_1, ...Array.from({ length: 100 }, () => crypto.randomUUID())];
    expect(demais).toHaveLength(101);

    const res = await bulkMove(tokenAdminA, demais, DEPT_DESTINO);

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(await docDepartment(DOC_1)).toBe(DEPT_ORIGEM);
  });

  it('exatamente 100 ids passa da validação (o teto é inclusivo)', async () => {
    // Os 99 ids sintéticos não existem, então o all-or-nothing responde 404 —
    // o que importa é que NÃO é 422: o Zod aceitou o tamanho da lista.
    const noLimite = [DOC_1, ...Array.from({ length: 99 }, () => crypto.randomUUID())];
    expect(noLimite).toHaveLength(100);

    const res = await bulkMove(tokenAdminA, noLimite, DEPT_DESTINO);
    expect(res.statusCode).toBe(404);
  });

  it('lista vazia → 422', async () => {
    const res = await bulkMove(tokenAdminA, [], DEPT_DESTINO);
    expect(res.statusCode).toBe(422);
  });

  it('id que não é uuid → 422', async () => {
    const res = await bulkMove(tokenAdminA, ['nao-e-uuid'], DEPT_DESTINO);
    expect(res.statusCode).toBe(422);
    expect(await docDepartment(DOC_1)).toBe(DEPT_ORIGEM);
  });

  it('departmentId ausente → 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/documents/bulk-move',
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { documentIds: [DOC_1] },
    });
    expect(res.statusCode).toBe(422);
    expect(await docDepartment(DOC_1)).toBe(DEPT_ORIGEM);
  });

  it('sem token → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/documents/bulk-move',
      payload: { documentIds: [DOC_1], departmentId: DEPT_DESTINO },
    });
    expect(res.statusCode).toBe(401);
    expect(await docDepartment(DOC_1)).toBe(DEPT_ORIGEM);
  });
});

describe('POST /documents/bulk-move — papéis (divergência deliberada do bulk-delete)', () => {
  it('UPLOADER com ACL nos dois lados MOVE em lote: 200 e chunks sincronizados', async () => {
    const res = await bulkMove(tokenUploaderA, [DOC_1, DOC_2], DEPT_DESTINO);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ moved: 2, requested: 2 });
    expect(await snapshot(DOC_1)).toEqual({ department: DEPT_DESTINO, departments: [DEPT_DESTINO], total: 3 });
    expect(await snapshot(DOC_2)).toEqual({ department: DEPT_DESTINO, departments: [DEPT_DESTINO], total: 2 });
  });

  it('ASSIMETRIA: o MESMO UPLOADER que move em lote leva 403 no bulk-delete', async () => {
    // Move (reversível, exige só ACL nos dois lados) → 200.
    const resMove = await bulkMove(tokenUploaderA, [DOC_1], DEPT_DESTINO);
    expect(resMove.statusCode).toBe(200);

    // Exclusão em massa (irreversível, exige ADMIN_ROLES) → 403.
    const resDelete = await app.inject({
      method: 'POST',
      url: '/documents/bulk-delete',
      headers: { authorization: `Bearer ${tokenUploaderA}` },
      payload: { documentIds: [DOC_2] },
    });
    expect(resDelete.statusCode).toBe(403);
  });

  it('USER com as raízes concedidas → 404 (nunca 403) e nada movido', async () => {
    const res = await bulkMove(tokenUserA, [DOC_1, DOC_2], DEPT_DESTINO);

    expect(res.statusCode).toBe(404);
    expect(await snapshot(DOC_1)).toEqual({ department: DEPT_ORIGEM, departments: [DEPT_ORIGEM], total: 3 });
    expect(await snapshot(DOC_2)).toEqual({ department: DEPT_ORIGEM, departments: [DEPT_ORIGEM], total: 2 });
    expect(await countAudit('document.bulk_move')).toBe(0);
  });
});

describe('POST /documents/bulk-move — auditoria', () => {
  it('grava document.bulk_move com count, ids movidos e as origens distintas', async () => {
    const res = await bulkMove(tokenAdminA, [DOC_1, DOC_2, DOC_OUTRA_ORIGEM], DEPT_DESTINO);
    expect(res.statusCode).toBe(200);

    const logs = await testDb.db<
      Array<{ resource: string; metadata: string; tenant_id: string; user_id: string }>
    >`
      SELECT resource, metadata, tenant_id, user_id
      FROM audit_logs WHERE action = 'document.bulk_move'
    `;
    expect(logs).toHaveLength(1);
    expect(logs[0]!.resource).toBe('documents/bulk-move');
    expect(logs[0]!.tenant_id).toBe(TENANT_A);
    expect(logs[0]!.user_id).toBe(ADMIN_A_ID);

    // `metadata` é jsonb gravado com JSON.stringify (ver auth/audit.ts) — a
    // leitura devolve a string JSON crua.
    const metadata = JSON.parse(logs[0]!.metadata) as {
      documentIds: string[];
      count: number;
      toDepartmentId: string;
      fromDepartmentIds: string[];
      chunksUpdated: number;
    };
    expect(metadata.count).toBe(3);
    expect([...metadata.documentIds].sort()).toEqual([DOC_1, DOC_2, DOC_OUTRA_ORIGEM].sort());
    expect(metadata.toDepartmentId).toBe(DEPT_DESTINO);
    expect([...metadata.fromDepartmentIds].sort()).toEqual([DEPT_ORIGEM, DEPT_ORIGEM_2].sort());
    expect(metadata.chunksUpdated).toBe(7);
  });

  it('sem nenhum documento movido (todos já no destino) → nenhum registro de auditoria', async () => {
    const res = await bulkMove(tokenAdminA, [DOC_JA_NO_DESTINO], DEPT_DESTINO);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ moved: 0, requested: 1 });
    expect(await countAudit('document.bulk_move')).toBe(0);
  });
});

describe('POST /documents/bulk-move — invariante global chunks × documents', () => {
  it('nenhum chunk fica com departamento ou empresa divergente do documento', async () => {
    expect((await bulkMove(tokenAdminA, [DOC_1, DOC_2, DOC_JA_NO_DESTINO], DEPT_DESTINO)).statusCode).toBe(200);
    expect((await bulkMove(tokenUploaderA, [DOC_OUTRA_ORIGEM], DEPT_DESTINO)).statusCode).toBe(200);
    expect((await bulkMove(tokenUploaderA, [DOC_3, DOC_ISOLADO], DEPT_DESTINO)).statusCode).toBe(404);
    expect((await bulkMove(tokenSuper, [DOC_1, DOC_B], DEPT_DESTINO)).statusCode).toBe(422);

    const rows = await testDb.db<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.department_id <> d.department_id OR c.tenant_id <> d.tenant_id
    `;
    expect(Number(rows[0]!.n)).toBe(0);
  });
});
