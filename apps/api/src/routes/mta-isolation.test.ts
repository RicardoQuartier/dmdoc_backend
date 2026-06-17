import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, type TestDb } from '../test/helpers.js';
import { newId } from '@dmdoc/db-mongo';

/**
 * Testes E2E de isolamento do papel MULTI_TENANT_ADMIN (MTA).
 *
 * Reaproveita o mesmo harness do `isolation.test.ts` (buildApp + memory-server,
 * seedUser com hash argon2 real, login via /auth/login). A diferença é o sujeito:
 * aqui o ator é um MTA com `tenantId: null` no token e uma lista
 * `allowedTenantIds`. As invariantes verificadas (spec §10):
 *
 *  - LEITURA sem `?tenantId` → mode `allowed`: filtro `{ tenantId: { $in } }`
 *    sempre presente; o MTA enxerga itens de TODOS os tenants da lista e SÓ deles.
 *  - Recurso de tenant fora da lista é tratado como inexistente → 404 (nunca 403).
 *  - ESCRITA sem `?tenantId` → 404; ESCRITA com `?tenantId` ∉ lista → 404.
 *  - `allowedTenantIds: []` → listas vazias com 200 (não 403, não 500).
 *  - Endpoint de gestão de empresas (`/admin/tenants`, SUPER_ADMIN-only) → 403.
 *
 * Três tenants: A e B ∈ lista do MTA; C ∉ lista (tenant de terceiro que nunca
 * pode vazar).
 */

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const TENANT_C = '33333333-3333-3333-3333-333333333333';

const MTA_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const MTA_EMPTY_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

const DEPT_A_ID = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1';
const DEPT_B_ID = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1';
const DEPT_C_ID = 'c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1';

const DOC_A_ID = 'a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2';
const DOC_B_ID = 'b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2';
const DOC_C_ID = 'c2c2c2c2-c2c2-c2c2-c2c2-c2c2c2c2c2c2';

const PASSWORD = 'senha-muito-secreta-123';

let app: FastifyInstance;
let testDb: TestDb;
let mtaToken: string;
let mtaEmptyToken: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = await buildApp({ config: testConfig(), db: testDb.db });
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(async () => {
  await testDb.db.collection('users').deleteMany({});
  await testDb.db.collection('tenants').deleteMany({});
  await testDb.db.collection('departments').deleteMany({});
  await testDb.db.collection('document_types').deleteMany({});
  await testDb.db.collection('documents').deleteMany({});
  await testDb.db.collection('department_permissions').deleteMany({});

  // Três tenants: A e B atribuídos ao MTA; C é de terceiro.
  await testDb.db.collection('tenants').insertMany([
    { id: TENANT_A, name: 'Empresa A', diskQuotaBytes: 10 * 1024 ** 3, userQuota: 20, active: true, createdAt: new Date() },
    { id: TENANT_B, name: 'Empresa B', diskQuotaBytes: 10 * 1024 ** 3, userQuota: 20, active: true, createdAt: new Date() },
    { id: TENANT_C, name: 'Empresa C', diskQuotaBytes: 10 * 1024 ** 3, userQuota: 20, active: true, createdAt: new Date() },
  ]);

  // MTA com acesso a A e B (não a C). tenantId é null para papel global.
  await seedUser(testDb.db, {
    id: MTA_ID,
    tenantId: null,
    email: 'mta@plataforma.com',
    password: PASSWORD,
    role: 'MULTI_TENANT_ADMIN',
    allowedTenantIds: [TENANT_A, TENANT_B],
  });

  // MTA sem nenhuma empresa atribuída — deve enxergar listas vazias.
  await seedUser(testDb.db, {
    id: MTA_EMPTY_ID,
    tenantId: null,
    email: 'mta-vazio@plataforma.com',
    password: PASSWORD,
    role: 'MULTI_TENANT_ADMIN',
    allowedTenantIds: [],
  });

  // Departamentos: um por tenant (necessário para a checagem de leitura do
  // documento singular, que valida que o dept existe no tenant do doc).
  await testDb.db.collection('departments').insertMany([
    deptDoc(DEPT_A_ID, TENANT_A, 'Dept A'),
    deptDoc(DEPT_B_ID, TENANT_B, 'Dept B'),
    deptDoc(DEPT_C_ID, TENANT_C, 'Dept C'),
  ]);

  // Documentos: um por tenant. O de C nunca pode aparecer para o MTA.
  await testDb.db.collection('documents').insertMany([
    docDoc(DOC_A_ID, TENANT_A, DEPT_A_ID, ['tag-a']),
    docDoc(DOC_B_ID, TENANT_B, DEPT_B_ID, ['tag-b']),
    docDoc(DOC_C_ID, TENANT_C, DEPT_C_ID, ['tag-c', 'segredo-c']),
  ]);

  mtaToken = await login('mta@plataforma.com');
  mtaEmptyToken = await login('mta-vazio@plataforma.com');
});

// ---------------------------------------------------------------------------
// Helpers de seed
// ---------------------------------------------------------------------------

function deptDoc(id: string, tenantId: string, name: string): Record<string, unknown> {
  return {
    id,
    tenantId,
    parentId: null,
    name,
    level: 0,
    tags: [],
    deleted: false,
    createdAt: new Date(),
  };
}

function docDoc(
  id: string,
  tenantId: string,
  departmentId: string,
  tags: string[],
): Record<string, unknown> {
  return {
    id,
    tenantId,
    departmentId,
    documentTypeId: null,
    filename: `${id}.pdf`,
    originalFilename: `${id}.pdf`,
    contentHash: id.replace(/-/g, '').padEnd(64, '0'),
    sizeBytes: 1024,
    mimeType: 'application/pdf',
    s3Key: `tenants/${tenantId}/documents/${id}/file.pdf`,
    status: 'READY',
    failureReason: null,
    tags,
    mongoContentId: null,
    indexValues: {},
    uploadedById: MTA_ID,
    uploadedAt: new Date(),
    processedAt: new Date(),
    costUsdCents: 0,
    deleted: false,
  };
}

async function login(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return res.json().accessToken as string;
}

// ===========================================================================
// Caso 1 — MTA vê documentos dos tenants atribuídos e APENAS deles
// ===========================================================================

describe('MTA — GET /documents (mode allowed)', () => {
  it('agrega documentos de TODOS os tenants atribuídos e nunca de terceiros', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/documents',
      headers: { authorization: `Bearer ${mtaToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{ id: string; tenantId: string }>;
      total: number;
    };
    const ids = body.items.map((d) => d.id);

    // Vê A e B (tenants da lista)
    expect(ids).toContain(DOC_A_ID);
    expect(ids).toContain(DOC_B_ID);

    // NUNCA vê C (tenant fora da lista)
    expect(ids).not.toContain(DOC_C_ID);

    // Invariante: o filtro $in nunca é omitido — todo item pertence à lista.
    expect(body.items.every((d) => d.tenantId === TENANT_A || d.tenantId === TENANT_B)).toBe(true);
    expect(body.items.some((d) => d.tenantId === TENANT_C)).toBe(false);
    expect(body.total).toBe(2);
  });
});

// ===========================================================================
// Caso 2 — MTA acessando documento de tenant NÃO atribuído → 404
// ===========================================================================

describe('MTA — GET /documents/:id (singular, findDocumentInTenants)', () => {
  it('documento de tenant atribuído (A) → 200', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/documents/${DOC_A_ID}`,
      headers: { authorization: `Bearer ${mtaToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(DOC_A_ID);
  });

  it('documento de tenant NÃO atribuído (C) → 404, nunca 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/documents/${DOC_C_ID}`,
      headers: { authorization: `Bearer ${mtaToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('DELETE de documento de tenant NÃO atribuído (C) → 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/documents/${DOC_C_ID}`,
      headers: { authorization: `Bearer ${mtaToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

// ===========================================================================
// Caso 3 — Busca (POST /search) não vaza documentos de terceiros
//
// O pipeline de conteúdo (lexical/vector/hybrid) depende de índices Atlas Search
// (`$search`/`$vectorSearch`) que NÃO existem no mongodb-memory-server. Portanto
// não é possível exercitar a agregação de chunks de forma determinística aqui.
//
// O que É determinístico e testável: a etapa de FILTROS ESTRUTURADOS
// (`resolveFilteredDocumentIds`), que roda um `find` comum na coleção `documents`
// aplicando `{ tenantId: { $in: allowedTenantIds } }`. Quando os filtros casam
// SOMENTE documentos de um tenant fora da lista, a rota faz curto-circuito e
// retorna vazio ANTES de tocar no `$search` — provando que o `$in` exclui o
// terceiro tenant. Esse é o ponto de isolamento crítico da busca.
// ===========================================================================

describe('MTA — POST /search (isolamento via filtros estruturados)', () => {
  it('filtro por tag exclusiva de tenant não atribuído (C) → resultado vazio (não vaza C)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/search',
      headers: { authorization: `Bearer ${mtaToken}` },
      payload: {
        query: 'segredo',
        searchMode: 'lexical',
        generateAnswer: false,
        filters: { tags: ['segredo-c'] },
      },
    });

    // O doc com 'segredo-c' pertence ao tenant C (fora da lista). O $in de
    // allowedTenantIds o exclui → filterDocumentIds === [] → curto-circuito.
    expect(res.statusCode).toBe(200);
    const body = res.json() as { answer: unknown; chunks: unknown[] };
    expect(body.answer).toBeNull();
    expect(body.chunks).toEqual([]);
  });

  it('filtro por departamento de tenant não atribuído (C) → resultado vazio', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/search',
      headers: { authorization: `Bearer ${mtaToken}` },
      payload: {
        query: 'qualquer',
        searchMode: 'lexical',
        generateAnswer: false,
        filters: { departmentIds: [DEPT_C_ID] },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { answer: unknown; chunks: unknown[] };
    expect(body.answer).toBeNull();
    expect(body.chunks).toEqual([]);
  });
});

// ===========================================================================
// Caso 4 — MTA escrita com tenantId fora da lista / sem tenantId → 404
// ===========================================================================

describe('MTA — escrita (PATCH/DELETE/POST) exige tenantId ∈ allowedTenantIds', () => {
  it('PATCH /departments/:id com ?tenantId fora da lista (C) → 404', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/departments/${DEPT_C_ID}?tenantId=${TENANT_C}`,
      headers: { authorization: `Bearer ${mtaToken}` },
      payload: { name: 'Tentativa Cross-Tenant' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('DELETE /departments/:id com ?tenantId fora da lista (C) → 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/departments/${DEPT_C_ID}?tenantId=${TENANT_C}`,
      headers: { authorization: `Bearer ${mtaToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('POST /departments SEM tenantId → 404 (MTA não tem empresa padrão em escrita)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/departments',
      headers: { authorization: `Bearer ${mtaToken}` },
      payload: { name: 'Novo Dept', parentId: null, tags: [] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('PATCH /departments/:id SEM ?tenantId → 404', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/departments/${DEPT_A_ID}`,
      headers: { authorization: `Bearer ${mtaToken}` },
      payload: { name: 'Sem tenant explícito' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('POST /departments com tenantId ∈ lista (A) → 201 (caminho feliz, contraprova)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/departments',
      headers: { authorization: `Bearer ${mtaToken}` },
      payload: { name: 'Dept válido em A', parentId: null, tags: [], tenantId: TENANT_A },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { tenantId: string };
    expect(body.tenantId).toBe(TENANT_A);
  });
});

// ===========================================================================
// Caso 5 — Token MTA com allowedTenantIds: [] → listas vazias 200
// ===========================================================================

describe('MTA — allowedTenantIds vazio (sem acesso a nenhuma empresa)', () => {
  it('GET /documents → 200 com lista vazia (não 403, não 500)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/documents',
      headers: { authorization: `Bearer ${mtaEmptyToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[]; total: number };
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('GET /departments → 200 com lista vazia (não 403, não 500)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/departments',
      headers: { authorization: `Bearer ${mtaEmptyToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('GET /documents/:id de qualquer tenant → 404 (lista vazia não casa nada)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/documents/${DOC_A_ID}`,
      headers: { authorization: `Bearer ${mtaEmptyToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

// ===========================================================================
// Extra — MTA vê departamentos de TODOS os tenants atribuídos (mode allowed)
// ===========================================================================

describe('MTA — GET /departments (mode allowed)', () => {
  it('agrega departamentos de A e B e nunca de C', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/departments',
      headers: { authorization: `Bearer ${mtaToken}` },
    });

    expect(res.statusCode).toBe(200);
    const items = res.json() as Array<{ id: string; tenantId: string }>;
    const ids = items.map((d) => d.id);

    expect(ids).toContain(DEPT_A_ID);
    expect(ids).toContain(DEPT_B_ID);
    expect(ids).not.toContain(DEPT_C_ID);
    expect(items.every((d) => d.tenantId === TENANT_A || d.tenantId === TENANT_B)).toBe(true);
  });

  it('com ?tenantId ∈ lista (A) → mode single, só departamentos de A', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/departments?tenantId=${TENANT_A}`,
      headers: { authorization: `Bearer ${mtaToken}` },
    });

    expect(res.statusCode).toBe(200);
    const items = res.json() as Array<{ id: string; tenantId: string }>;
    expect(items.every((d) => d.tenantId === TENANT_A)).toBe(true);
    expect(items.map((d) => d.id)).toContain(DEPT_A_ID);
    expect(items.map((d) => d.id)).not.toContain(DEPT_B_ID);
  });

  it('com ?tenantId ∉ lista (C) → 404 (recurso fora do escopo, nunca 403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/departments?tenantId=${TENANT_C}`,
      headers: { authorization: `Bearer ${mtaToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

// ===========================================================================
// Extra — MTA não acessa gestão de empresas (/admin/tenants, SUPER_ADMIN-only)
//
// A tarefa menciona "/admin/companies"; o path real no código é "/admin/tenants"
// (a entidade empresa é `tenant`). O guard `requireRole(request, 'SUPER_ADMIN')`
// NÃO concede passe-livre ao MTA → ForbiddenError 403.
// ===========================================================================

describe('MTA — gestão de empresas é vedada', () => {
  it('GET /admin/tenants → 403 (somente SUPER_ADMIN gerencia empresas)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/tenants',
      headers: { authorization: `Bearer ${mtaToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('POST /admin/tenants → 403 (MTA não cria empresas)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      headers: { authorization: `Bearer ${mtaToken}` },
      payload: { name: 'Nova Empresa', diskQuotaBytes: 1024, userQuota: 5 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });
});
