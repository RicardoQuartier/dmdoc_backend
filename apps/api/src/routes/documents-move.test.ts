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
 * E2E de `PATCH /documents/:id/move` (épico E-9 / T-111).
 *
 * O que estes testes protegem — nesta ordem de importância:
 *
 *   1. SINCRONIZAÇÃO `documents` × `chunks`. É `chunks.department_id` (coluna
 *      denormalizada) que a busca usa para filtrar acesso. Mover o documento
 *      sem reescrever os chunks produziria VAZAMENTO (quem perdeu o acesso
 *      continua recebendo o texto no RAG) e SUMIÇO (quem ganhou não acha por
 *      conteúdo). Por isso TODA asserção de move olha as duas tabelas — nunca
 *      só o corpo da resposta.
 *   2. ACL nos DOIS lados: escrita na ORIGEM **e** no DESTINO. Falta em
 *      qualquer um → 404, NUNCA 403 (spec §10, invariante 4) e NADA escrito.
 *   3. O papel `USER` (somente leitura) é barrado mesmo com a raiz concedida —
 *      o gate de papel é fail-closed dentro de `assertCanWriteDepartment`.
 *   4. Destino soft-deletado → 404. `resolveAccessibleDepartmentIds`
 *      deliberadamente NÃO filtra `departments.deleted` (para preservar acesso
 *      a documentos órfãos, ver `auth/department-access.ts:76-79`), então a
 *      checagem de destino ATIVO é independente da ACL — e este arquivo cobre
 *      os dois ramos (com ACL e sem ACL/admin).
 *   5. Idempotência: destino já é o departamento atual → 200 sem audit e sem
 *      reescrever chunk nenhum (provado por `xmin`, a versão física da linha).
 *   6. Documento em `PENDING` é movido sem 409 — decisão do épico: a corrida
 *      com o worker foi fechada no `persist` do pipeline, que relê o
 *      departamento sob `FOR SHARE`.
 *
 * PERMISSÃO — divergência deliberada do `bulk-delete` (que exige `ADMIN_ROLES`):
 * mover é reversível, então basta ACL de escrita nos dois lados. O `UPLOADER`
 * move; o `USER` não.
 *
 * Fixture do TENANT_A (recriada a cada teste):
 *   DEPT_ORIGEM (raiz) · DEPT_DESTINO (raiz) · DEPT_ISOLADO (raiz, sem
 *   concessão a nenhum UPLOADER) · DEPT_ARQUIVADO (raiz, `deleted = true`,
 *   concedido ao UPLOADER_AMBOS de propósito).
 * TENANT_B: DEPT_B e DEPT_B2 — nunca alcançáveis a partir de A.
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
const UPLOADER_AMBOS_ID = crypto.randomUUID();
const UPLOADER_SO_ORIGEM_ID = crypto.randomUUID();
const UPLOADER_SO_DESTINO_ID = crypto.randomUUID();
const USER_AMBOS_ID = crypto.randomUUID();
const ADMIN_B_ID = crypto.randomUUID();
const SUPER_ID = crypto.randomUUID();

const DEPT_ORIGEM = newId();
const DEPT_DESTINO = newId();
const DEPT_ISOLADO = newId();
const DEPT_ARQUIVADO = newId();
const DEPT_B = newId();
const DEPT_B2 = newId();

const PASSWORD = 'senha-forte-de-teste-123';
const DISK_QUOTA = 10 * 1024 * 1024;
/** Vetor de 1536 dimensões — `chunks.embedding` é NOT NULL. */
const ZERO_EMBEDDING = `[${new Array(1536).fill(0).join(',')}]`;

let app: FastifyInstance;
let testDb: TestDb;
let s3Mock: StorageDriver;

let tokenAdminA: string;
let tokenUploaderAmbos: string;
let tokenUploaderSoOrigem: string;
let tokenUploaderSoDestino: string;
let tokenUserAmbos: string;
let tokenSuper: string;

// TENANT_A / DEPT_ORIGEM
let DOC_1 = '';
let DOC_VIZINHO = '';
let DOC_PENDING = '';
// TENANT_A / DEPT_DESTINO — usado na idempotência
let DOC_JA_NO_DESTINO = '';
// TENANT_A / DEPT_ISOLADO
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

type DocStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';

/**
 * Cria um documento com `chunkCount` chunks no MESMO departamento — o estado
 * consistente que o pipeline produz. Vários chunks por documento são
 * essenciais: um `UPDATE chunks` que esquecesse do `= ANY` ou parasse no
 * primeiro chunk passaria despercebido com um chunk só.
 */
async function seedDocument(params: {
  tenantId: string;
  departmentId: string;
  uploadedById: string;
  status?: DocStatus;
  chunkCount?: number;
}): Promise<string> {
  const { tenantId, departmentId, uploadedById } = params;
  const status = params.status ?? 'READY';
  const chunkCount = params.chunkCount ?? 3;
  const id = newId();
  const hash = crypto.randomBytes(32).toString('hex');

  await testDb.db`
    INSERT INTO documents (
      id, tenant_id, department_id, document_type_id, filename, original_filename,
      content_hash, size_bytes, mime_type, storage_key, status, failure_reason,
      uploaded_by_id, uploaded_at, index_values, tags, deleted
    ) VALUES (
      ${id}, ${tenantId}, ${departmentId}, NULL, ${'f-' + id + '.pdf'}, 'doc.pdf',
      ${hash}, ${1234}, 'application/pdf', ${'s3/' + id}, ${status}, NULL,
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

/** Departamento gravado em `documents` (fonte de verdade dos metadados). */
async function docDepartment(documentId: string): Promise<string> {
  const rows = await testDb.db<Array<{ department_id: string }>>`
    SELECT department_id FROM documents WHERE id = ${documentId}
  `;
  return rows[0]!.department_id;
}

/**
 * Departamentos DISTINTOS dos chunks do documento, com a contagem total. Se o
 * UPDATE de chunks tiver rodado pela metade, `departments` volta com dois
 * valores — e a asserção quebra.
 */
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

/**
 * Versão física de cada linha de chunk (`xmin`). É a prova mais forte de que
 * NADA foi reescrito: um `UPDATE` que não muda valor algum ainda assim geraria
 * uma tupla nova, com `xmin` diferente.
 */
async function chunkVersions(documentId: string): Promise<string[]> {
  const rows = await testDb.db<Array<{ id: string; xmin: string }>>`
    SELECT id, xmin::text AS xmin FROM chunks WHERE document_id = ${documentId} ORDER BY chunk_index
  `;
  return rows.map((r) => `${r.id}:${r.xmin}`);
}

async function countAudit(action: string): Promise<number> {
  const rows = await testDb.db<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM audit_logs WHERE action = ${action}
  `;
  return Number(rows[0]?.n ?? 0);
}

/** Estado completo do documento: departamento + chunks. */
async function snapshot(
  documentId: string
): Promise<{ department: string; departments: string[]; total: number }> {
  const chunks = await chunkState(documentId);
  return { department: await docDepartment(documentId), ...chunks };
}

function move(token: string, documentId: string, departmentId: unknown) {
  return app.inject({
    method: 'PATCH',
    url: `/documents/${documentId}/move`,
    headers: { authorization: `Bearer ${token}` },
    payload: { departmentId },
  });
}

/** Concede a raiz `departmentId` ao usuário (ACL por raiz, herança dinâmica). */
async function grant(userId: string, departmentId: string): Promise<void> {
  await testDb.db`
    INSERT INTO department_permissions (id, tenant_id, user_id, department_id, can_read, can_write, deleted)
    VALUES (${newId()}, ${TENANT_A}, ${userId}, ${departmentId}, true, true, false)
  `;
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

  // DEPT_ARQUIVADO nasce soft-deletado: é o caso que a ACL não pega.
  await testDb.db`
    INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
    VALUES
      (${DEPT_ORIGEM}, ${TENANT_A}, NULL, 'Origem A', 0, '{}'::text[], false, NOW()),
      (${DEPT_DESTINO}, ${TENANT_A}, NULL, 'Destino A', 0, '{}'::text[], false, NOW()),
      (${DEPT_ISOLADO}, ${TENANT_A}, NULL, 'Isolado A', 0, '{}'::text[], false, NOW()),
      (${DEPT_ARQUIVADO}, ${TENANT_A}, NULL, 'Arquivado A', 0, '{}'::text[], true, NOW()),
      (${DEPT_B}, ${TENANT_B}, NULL, 'Financeiro B', 0, '{}'::text[], false, NOW()),
      (${DEPT_B2}, ${TENANT_B}, NULL, 'Juridico B', 0, '{}'::text[], false, NOW())
  `;

  await seedUser(testDb.db, { id: ADMIN_A_ID, tenantId: TENANT_A, email: 'admin-a@move.com', password: PASSWORD, role: 'TENANT_ADMIN' });
  await seedUser(testDb.db, { id: UPLOADER_AMBOS_ID, tenantId: TENANT_A, email: 'up-ambos@move.com', password: PASSWORD, role: 'UPLOADER' });
  await seedUser(testDb.db, { id: UPLOADER_SO_ORIGEM_ID, tenantId: TENANT_A, email: 'up-origem@move.com', password: PASSWORD, role: 'UPLOADER' });
  await seedUser(testDb.db, { id: UPLOADER_SO_DESTINO_ID, tenantId: TENANT_A, email: 'up-destino@move.com', password: PASSWORD, role: 'UPLOADER' });
  await seedUser(testDb.db, { id: USER_AMBOS_ID, tenantId: TENANT_A, email: 'user-ambos@move.com', password: PASSWORD, role: 'USER' });
  await seedUser(testDb.db, { id: ADMIN_B_ID, tenantId: TENANT_B, email: 'admin-b@move.com', password: PASSWORD, role: 'TENANT_ADMIN' });
  await seedUser(testDb.db, { id: SUPER_ID, tenantId: null, email: 'super@move.com', password: PASSWORD, role: 'SUPER_ADMIN' });

  // ACL por raiz. O UPLOADER_AMBOS também recebe a raiz ARQUIVADA de propósito:
  // sem isso o 404 do destino soft-deletado poderia vir da ACL, e não da
  // checagem independente de destino ativo que se quer provar.
  await grant(UPLOADER_AMBOS_ID, DEPT_ORIGEM);
  await grant(UPLOADER_AMBOS_ID, DEPT_DESTINO);
  await grant(UPLOADER_AMBOS_ID, DEPT_ARQUIVADO);
  await grant(UPLOADER_SO_ORIGEM_ID, DEPT_ORIGEM);
  await grant(UPLOADER_SO_DESTINO_ID, DEPT_DESTINO);
  await grant(USER_AMBOS_ID, DEPT_ORIGEM);
  await grant(USER_AMBOS_ID, DEPT_DESTINO);

  DOC_1 = await seedDocument({ tenantId: TENANT_A, departmentId: DEPT_ORIGEM, uploadedById: ADMIN_A_ID });
  DOC_VIZINHO = await seedDocument({ tenantId: TENANT_A, departmentId: DEPT_ORIGEM, uploadedById: ADMIN_A_ID, chunkCount: 2 });
  DOC_PENDING = await seedDocument({ tenantId: TENANT_A, departmentId: DEPT_ORIGEM, uploadedById: ADMIN_A_ID, status: 'PENDING', chunkCount: 0 });
  DOC_JA_NO_DESTINO = await seedDocument({ tenantId: TENANT_A, departmentId: DEPT_DESTINO, uploadedById: ADMIN_A_ID, chunkCount: 2 });
  DOC_ISOLADO = await seedDocument({ tenantId: TENANT_A, departmentId: DEPT_ISOLADO, uploadedById: ADMIN_A_ID });
  DOC_B = await seedDocument({ tenantId: TENANT_B, departmentId: DEPT_B, uploadedById: ADMIN_B_ID });

  tokenAdminA = await login('admin-a@move.com');
  tokenUploaderAmbos = await login('up-ambos@move.com');
  tokenUploaderSoOrigem = await login('up-origem@move.com');
  tokenUploaderSoDestino = await login('up-destino@move.com');
  tokenUserAmbos = await login('user-ambos@move.com');
  tokenSuper = await login('super@move.com');
});

describe('PATCH /documents/:id/move — move efetivo e sincronização dos chunks', () => {
  it('UPLOADER com ACL nos dois lados: 200 e TODOS os chunks no novo departamento', async () => {
    const res = await move(tokenUploaderAmbos, DOC_1, DEPT_DESTINO);

    expect(res.statusCode).toBe(200);
    expect(res.json().departmentId).toBe(DEPT_DESTINO);

    // A resposta não basta: a invariante vive no banco, nas DUAS tabelas.
    expect(await snapshot(DOC_1)).toEqual({
      department: DEPT_DESTINO,
      departments: [DEPT_DESTINO],
      total: 3,
    });
  });

  it('o documento vizinho, no mesmo departamento de origem, não é tocado', async () => {
    const versoesAntes = await chunkVersions(DOC_VIZINHO);

    const res = await move(tokenUploaderAmbos, DOC_1, DEPT_DESTINO);
    expect(res.statusCode).toBe(200);

    expect(await snapshot(DOC_VIZINHO)).toEqual({
      department: DEPT_ORIGEM,
      departments: [DEPT_ORIGEM],
      total: 2,
    });
    // Nem sequer reescritos: o `= ANY(targetIds)` não vaza para o departamento.
    expect(await chunkVersions(DOC_VIZINHO)).toEqual(versoesAntes);
  });

  it('TENANT_ADMIN move para departamento sem concessão nenhuma (admin não tem ACL)', async () => {
    const res = await move(tokenAdminA, DOC_1, DEPT_ISOLADO);

    expect(res.statusCode).toBe(200);
    expect(await snapshot(DOC_1)).toEqual({
      department: DEPT_ISOLADO,
      departments: [DEPT_ISOLADO],
      total: 3,
    });
  });

  it('documento em PENDING é movido sem 409 (a corrida com o worker é fechada no persist)', async () => {
    const res = await move(tokenUploaderAmbos, DOC_PENDING, DEPT_DESTINO);

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('PENDING');
    expect(await docDepartment(DOC_PENDING)).toBe(DEPT_DESTINO);
    // Sem chunks ainda — o move não pode falhar por isso.
    expect(await chunkState(DOC_PENDING)).toEqual({ departments: [], total: 0 });
  });

  it('SUPER_ADMIN move documento de uma empresa dentro dela (escopo global)', async () => {
    const res = await move(tokenSuper, DOC_B, DEPT_B2);

    expect(res.statusCode).toBe(200);
    expect(await snapshot(DOC_B)).toEqual({
      department: DEPT_B2,
      departments: [DEPT_B2],
      total: 3,
    });
  });

  it('mover ida e volta devolve o documento e os chunks ao departamento original', async () => {
    expect((await move(tokenUploaderAmbos, DOC_1, DEPT_DESTINO)).statusCode).toBe(200);
    expect((await move(tokenUploaderAmbos, DOC_1, DEPT_ORIGEM)).statusCode).toBe(200);

    expect(await snapshot(DOC_1)).toEqual({
      department: DEPT_ORIGEM,
      departments: [DEPT_ORIGEM],
      total: 3,
    });
    expect(await countAudit('document.move')).toBe(2);
  });
});

describe('PATCH /documents/:id/move — idempotência (destino já é o departamento atual)', () => {
  it('200 sem audit e sem reescrever chunk algum', async () => {
    const versoesAntes = await chunkVersions(DOC_JA_NO_DESTINO);

    const res = await move(tokenUploaderAmbos, DOC_JA_NO_DESTINO, DEPT_DESTINO);

    expect(res.statusCode).toBe(200);
    expect(res.json().departmentId).toBe(DEPT_DESTINO);

    // O `AND department_id <> destino` dos dois UPDATEs faz o no-op custar zero:
    // nenhuma linha, nenhum WAL, nenhum registro de auditoria.
    expect(await countAudit('document.move')).toBe(0);
    expect(await chunkVersions(DOC_JA_NO_DESTINO)).toEqual(versoesAntes);
    expect(await chunkState(DOC_JA_NO_DESTINO)).toEqual({
      departments: [DEPT_DESTINO],
      total: 2,
    });
  });
});

describe('PATCH /documents/:id/move — ACL: 404, nunca 403, e nada escrito', () => {
  it('USER com a raiz concedida nos DOIS lados → 404 (papel é somente leitura)', async () => {
    const res = await move(tokenUserAmbos, DOC_1, DEPT_DESTINO);

    expect(res.statusCode).toBe(404);
    expect(await snapshot(DOC_1)).toEqual({
      department: DEPT_ORIGEM,
      departments: [DEPT_ORIGEM],
      total: 3,
    });
    expect(await countAudit('document.move')).toBe(0);
  });

  it('UPLOADER sem ACL na ORIGEM → 404 e nada escrito', async () => {
    // Tem a raiz do DESTINO, não a da ORIGEM: mover exige os dois lados.
    const res = await move(tokenUploaderSoDestino, DOC_1, DEPT_DESTINO);

    expect(res.statusCode).toBe(404);
    expect(await snapshot(DOC_1)).toEqual({
      department: DEPT_ORIGEM,
      departments: [DEPT_ORIGEM],
      total: 3,
    });
    expect(await countAudit('document.move')).toBe(0);
  });

  it('UPLOADER sem ACL no DESTINO → 404 e nada escrito', async () => {
    const res = await move(tokenUploaderSoOrigem, DOC_1, DEPT_ISOLADO);

    expect(res.statusCode).toBe(404);
    expect(await snapshot(DOC_1)).toEqual({
      department: DEPT_ORIGEM,
      departments: [DEPT_ORIGEM],
      total: 3,
    });
    expect(await countAudit('document.move')).toBe(0);
  });

  it('UPLOADER sem ACL em NENHUM dos lados → 404', async () => {
    const res = await move(tokenUploaderSoOrigem, DOC_ISOLADO, DEPT_ISOLADO);

    expect(res.statusCode).toBe(404);
    expect(await docDepartment(DOC_ISOLADO)).toBe(DEPT_ISOLADO);
  });

  it('destino SOFT-DELETADO → 404 mesmo com a raiz concedida (a ACL não filtra departments.deleted)', async () => {
    const res = await move(tokenUploaderAmbos, DOC_1, DEPT_ARQUIVADO);

    // Sem a checagem independente de destino ATIVO, este caso passaria: a raiz
    // arquivada está no conjunto acessível (`department-access.ts:76-79`).
    expect(res.statusCode).toBe(404);
    expect(await snapshot(DOC_1)).toEqual({
      department: DEPT_ORIGEM,
      departments: [DEPT_ORIGEM],
      total: 3,
    });
  });

  it('destino SOFT-DELETADO → 404 também para TENANT_ADMIN (ramo sem ACL)', async () => {
    const res = await move(tokenAdminA, DOC_1, DEPT_ARQUIVADO);

    expect(res.statusCode).toBe(404);
    expect(await snapshot(DOC_1)).toEqual({
      department: DEPT_ORIGEM,
      departments: [DEPT_ORIGEM],
      total: 3,
    });
  });

  it('destino inexistente → 404', async () => {
    const res = await move(tokenAdminA, DOC_1, crypto.randomUUID());

    expect(res.statusCode).toBe(404);
    expect(await docDepartment(DOC_1)).toBe(DEPT_ORIGEM);
  });
});

describe('PATCH /documents/:id/move — isolamento multi-tenant', () => {
  it('destino de OUTRA empresa → 404 e o documento fica onde estava', async () => {
    const res = await move(tokenAdminA, DOC_1, DEPT_B);

    expect(res.statusCode).toBe(404);
    expect(await snapshot(DOC_1)).toEqual({
      department: DEPT_ORIGEM,
      departments: [DEPT_ORIGEM],
      total: 3,
    });
  });

  it('documento de OUTRA empresa → 404 e o documento de B fica intacto', async () => {
    const res = await move(tokenAdminA, DOC_B, DEPT_DESTINO);

    expect(res.statusCode).toBe(404);
    expect(await snapshot(DOC_B)).toEqual({
      department: DEPT_B,
      departments: [DEPT_B],
      total: 3,
    });
  });

  it('documento inexistente → 404', async () => {
    const res = await move(tokenAdminA, crypto.randomUUID(), DEPT_DESTINO);
    expect(res.statusCode).toBe(404);
  });

  it('documento soft-deletado → 404 (a resolução filtra deleted = false)', async () => {
    await testDb.db`UPDATE documents SET deleted = true WHERE id = ${DOC_1}`;

    const res = await move(tokenAdminA, DOC_1, DEPT_DESTINO);

    expect(res.statusCode).toBe(404);
    expect(await snapshot(DOC_1)).toEqual({
      department: DEPT_ORIGEM,
      departments: [DEPT_ORIGEM],
      total: 3,
    });
  });

  it('sem token → 401', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/documents/${DOC_1}/move`,
      payload: { departmentId: DEPT_DESTINO },
    });
    expect(res.statusCode).toBe(401);
    expect(await docDepartment(DOC_1)).toBe(DEPT_ORIGEM);
  });
});

describe('PATCH /documents/:id/move — validação de entrada', () => {
  it('departmentId ausente → 422', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/documents/${DOC_1}/move`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(await docDepartment(DOC_1)).toBe(DEPT_ORIGEM);
  });

  it('departmentId que não é uuid → 422 (e não um 500 do Postgres)', async () => {
    const res = await move(tokenAdminA, DOC_1, 'nao-e-uuid');
    expect(res.statusCode).toBe(422);
  });

  it(':id que não é uuid → 422 (a rota de move usa DocumentIdParamsSchema de verdade)', async () => {
    const res = await move(tokenAdminA, 'nao-e-uuid', DEPT_DESTINO);
    expect(res.statusCode).toBe(422);
  });
});

describe('PATCH /documents/:id/move — auditoria', () => {
  it('grava document.move com fromDepartmentId, toDepartmentId e chunksUpdated', async () => {
    const res = await move(tokenUploaderAmbos, DOC_1, DEPT_DESTINO);
    expect(res.statusCode).toBe(200);

    const logs = await testDb.db<
      Array<{ action: string; resource: string; metadata: string; tenant_id: string; user_id: string }>
    >`
      SELECT action, resource, metadata, tenant_id, user_id
      FROM audit_logs WHERE action = 'document.move'
    `;
    expect(logs).toHaveLength(1);
    expect(logs[0]!.resource).toBe(`documents/${DOC_1}`);
    expect(logs[0]!.tenant_id).toBe(TENANT_A);
    expect(logs[0]!.user_id).toBe(UPLOADER_AMBOS_ID);

    // `metadata` é jsonb gravado com JSON.stringify (ver auth/audit.ts) — a
    // leitura devolve a string JSON crua.
    const metadata = JSON.parse(logs[0]!.metadata) as {
      documentId: string;
      fromDepartmentId: string;
      toDepartmentId: string;
      chunksUpdated: number;
      status: string;
    };
    expect(metadata.documentId).toBe(DOC_1);
    // O `from` é o estado ANTES do UPDATE — o bug clássico aqui é registrar o
    // departamento novo dos dois lados, relendo a linha depois da transação.
    expect(metadata.fromDepartmentId).toBe(DEPT_ORIGEM);
    expect(metadata.toDepartmentId).toBe(DEPT_DESTINO);
    expect(metadata.chunksUpdated).toBe(3);
    expect(metadata.status).toBe('READY');
  });
});

describe('PATCH /documents/:id/move — invariante global chunks × documents', () => {
  it('nenhum chunk fica com departamento ou empresa divergente do documento', async () => {
    // Sequência que mistura move efetivo, no-op e recusa — todo caminho de
    // escrita do módulo passa por aqui antes da verificação final.
    expect((await move(tokenUploaderAmbos, DOC_1, DEPT_DESTINO)).statusCode).toBe(200);
    expect((await move(tokenUploaderAmbos, DOC_1, DEPT_DESTINO)).statusCode).toBe(200);
    expect((await move(tokenAdminA, DOC_VIZINHO, DEPT_ISOLADO)).statusCode).toBe(200);
    expect((await move(tokenUploaderSoOrigem, DOC_JA_NO_DESTINO, DEPT_ORIGEM)).statusCode).toBe(404);
    expect((await move(tokenSuper, DOC_B, DEPT_B2)).statusCode).toBe(200);

    const rows = await testDb.db<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.department_id <> d.department_id OR c.tenant_id <> d.tenant_id
    `;
    expect(Number(rows[0]!.n)).toBe(0);
  });
});
