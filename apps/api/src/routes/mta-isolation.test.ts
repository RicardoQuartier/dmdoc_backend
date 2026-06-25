import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, type TestDb } from '../test/helpers.js';
import { newId } from '@dmdoc/db-pg';

/**
 * Testes E2E de isolamento do papel MULTI_TENANT_ADMIN (MTA).
 *
 * Reaproveita o mesmo harness do `isolation.test.ts` (buildApp, seedUser com
 * hash argon2 real, login via /auth/login). A diferença é o sujeito:
 * aqui o ator é um MTA com `tenantId: null` no token e uma lista
 * `allowedTenantIds`. As invariantes verificadas (spec §10):
 *
 *  - LEITURA sem `?tenantId` → mode `allowed`: filtro `tenant_id = ANY(...)` SQL
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
  await testDb.db`DELETE FROM department_permissions`;
  await testDb.db`DELETE FROM documents`;
  await testDb.db`DELETE FROM document_types`;
  await testDb.db`DELETE FROM departments`;
  await testDb.db`DELETE FROM users WHERE tenant_id IS NOT NULL OR role IN ('MULTI_TENANT_ADMIN','TENANT_ADMIN','UPLOADER','USER')`;
  await testDb.db`DELETE FROM tenants WHERE id IN (${TENANT_A}, ${TENANT_B}, ${TENANT_C})`;

  // Três tenants: A e B atribuídos ao MTA; C é de terceiro.
  await testDb.db`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
    VALUES
      (${TENANT_A}, 'Empresa A', ${10 * 1024 ** 3}, 20, true, NOW()),
      (${TENANT_B}, 'Empresa B', ${10 * 1024 ** 3}, 20, true, NOW()),
      (${TENANT_C}, 'Empresa C', ${10 * 1024 ** 3}, 20, true, NOW())
    ON CONFLICT (id) DO NOTHING
  `;

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

  // Departamentos: um por tenant
  await testDb.db`
    INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
    VALUES
      (${DEPT_A_ID}, ${TENANT_A}, NULL, 'Dept A', 0, '{}'::text[], false, NOW()),
      (${DEPT_B_ID}, ${TENANT_B}, NULL, 'Dept B', 0, '{}'::text[], false, NOW()),
      (${DEPT_C_ID}, ${TENANT_C}, NULL, 'Dept C', 0, '{}'::text[], false, NOW())
  `;

  // Documentos: um por tenant. O de C nunca pode aparecer para o MTA.
  const hashA = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);
  const hashC = 'c'.repeat(64);
  await testDb.db`
    INSERT INTO documents (
      id, tenant_id, department_id, document_type_id,
      original_filename, content_hash, size_bytes, mime_type,
      s3_key, status, failure_reason, tags, index_values,
      uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
    ) VALUES
      (${DOC_A_ID}, ${TENANT_A}, ${DEPT_A_ID}, NULL, 'a.pdf', ${hashA}, 1024, 'application/pdf', ${`tenants/${TENANT_A}/${DOC_A_ID}.pdf`}, 'READY', NULL, '{"tag-a"}'::text[], '{}'::jsonb, ${MTA_ID}, NOW(), NOW(), 0, false),
      (${DOC_B_ID}, ${TENANT_B}, ${DEPT_B_ID}, NULL, 'b.pdf', ${hashB}, 1024, 'application/pdf', ${`tenants/${TENANT_B}/${DOC_B_ID}.pdf`}, 'READY', NULL, '{"tag-b"}'::text[], '{}'::jsonb, ${MTA_ID}, NOW(), NOW(), 0, false),
      (${DOC_C_ID}, ${TENANT_C}, ${DEPT_C_ID}, NULL, 'c.pdf', ${hashC}, 1024, 'application/pdf', ${`tenants/${TENANT_C}/${DOC_C_ID}.pdf`}, 'READY', NULL, '{"tag-c","segredo-c"}'::text[], '{}'::jsonb, ${MTA_ID}, NOW(), NOW(), 0, false)
  `;

  mtaToken = await login('mta@plataforma.com');
  mtaEmptyToken = await login('mta-vazio@plataforma.com');
});

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

    // Invariante: todo item pertence à lista.
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

    // O doc com 'segredo-c' pertence ao tenant C (fora da lista). O ANY(...)
    // SQL o exclui → filterDocumentIds === [] → curto-circuito.
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

// Suppress unused import warning - newId used for hash generation
void newId;
