import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { EvaluatedDocumentEntriesRepository } from '@dmdoc/db-pg';
import type { StorageDriver } from '@dmdoc/storage';
import { buildApp } from '../app.js';
import { AuditLogger } from '../auth/audit.js';
import { resetDomainTables, seedUser, startTestDb, staticStorage, testConfig, type TestDb } from '../test/helpers.js';
import { todayInSaoPaulo } from './reports-evaluated-documents.js';

// ---------------------------------------------------------------------------
// Mock de storage — nunca toca S3 real
// ---------------------------------------------------------------------------
function createMockS3(): StorageDriver {
  return {
    provider: 's3',
    put: async () => undefined,
    getDownloadUrl: async () => 'https://mock',
    delete: async () => undefined,
  } as unknown as StorageDriver;
}

// ---------------------------------------------------------------------------
// Fixtures — ids aleatórios por arquivo (evita colisão no dmdoc_test)
// ---------------------------------------------------------------------------
const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();
const TENANT_OUTSIDE_MTA = TENANT_B;

const ADMIN_A_ID = crypto.randomUUID();
const ADMIN_B_ID = crypto.randomUUID();
const UPLOADER_A_ID = crypto.randomUUID();
const USER_A_ID = crypto.randomUUID(); // "Beatriz"
const USER_A2_ID = crypto.randomUUID(); // "Carlos"
const INACTIVE_A_ID = crypto.randomUUID();
const DELETED_A_ID = crypto.randomUUID();
const USER_B_ID = crypto.randomUUID();
const SUPER_ID = crypto.randomUUID();
const MTA_ID = crypto.randomUUID();

const PASSWORD = 'senha-forte-de-teste-avaliados';
const BASE = '/reports/evaluated-documents';
const JUSTIFICATION = 'Correção solicitada pelo cliente por e-mail';

let app: FastifyInstance;
let testDb: TestDb;
let tokenAdminA: string;
let tokenAdminB: string;
let tokenUploaderA: string;
let tokenUserA: string;
let tokenSuper: string;
let tokenMta: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = await buildApp({
    config: testConfig(),
    db: testDb.db,
    queue: null,
    storage: staticStorage(createMockS3()),
  });
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(async () => {
  await resetDomainTables(testDb.db);

  await testDb.db`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
    VALUES
      (${TENANT_A}, 'Empresa A', ${100 * 1024 * 1024}, ${50}, true, NOW()),
      (${TENANT_B}, 'Empresa B', ${100 * 1024 * 1024}, ${50}, true, NOW())
  `;

  const seeds: Array<Parameters<typeof seedUser>[1]> = [
    { id: ADMIN_A_ID, tenantId: TENANT_A, email: 'eval-admin-a@e.com', role: 'TENANT_ADMIN', name: 'Admin A', password: PASSWORD },
    { id: ADMIN_B_ID, tenantId: TENANT_B, email: 'eval-admin-b@e.com', role: 'TENANT_ADMIN', name: 'Admin B', password: PASSWORD },
    { id: UPLOADER_A_ID, tenantId: TENANT_A, email: 'eval-uploader-a@e.com', role: 'UPLOADER', name: 'Uploader A', password: PASSWORD },
    { id: USER_A_ID, tenantId: TENANT_A, email: 'eval-beatriz@e.com', role: 'USER', name: 'Beatriz', password: PASSWORD },
    { id: USER_A2_ID, tenantId: TENANT_A, email: 'eval-carlos@e.com', role: 'USER', name: 'Carlos', password: PASSWORD },
    { id: INACTIVE_A_ID, tenantId: TENANT_A, email: 'eval-inativo@e.com', role: 'USER', name: 'Inativo', password: PASSWORD, active: false },
    { id: DELETED_A_ID, tenantId: TENANT_A, email: 'eval-excluido@e.com', role: 'USER', name: 'Excluído', password: PASSWORD },
    { id: USER_B_ID, tenantId: TENANT_B, email: 'eval-user-b@e.com', role: 'USER', name: 'Usuário B', password: PASSWORD },
    { id: SUPER_ID, tenantId: null, email: 'eval-super@e.com', role: 'SUPER_ADMIN', name: 'Super', password: PASSWORD },
    {
      id: MTA_ID, tenantId: null, email: 'eval-mta@e.com', role: 'MULTI_TENANT_ADMIN', name: 'MTA Operador',
      password: PASSWORD, allowedTenantIds: [TENANT_A],
    },
  ];
  for (const s of seeds) await seedUser(testDb.db, s);
  await testDb.db`UPDATE users SET deleted = true WHERE id = ${DELETED_A_ID}`;

  [tokenAdminA, tokenAdminB, tokenUploaderA, tokenUserA, tokenSuper, tokenMta] = await Promise.all([
    login('eval-admin-a@e.com'),
    login('eval-admin-b@e.com'),
    login('eval-uploader-a@e.com'),
    login('eval-beatriz@e.com'),
    login('eval-super@e.com'),
    login('eval-mta@e.com'),
  ]);
});

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return (res.json() as { accessToken: string }).accessToken;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

async function call(
  token: string,
  method: Method,
  url: string,
  payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload } : {}),
  });
}

/** Insere um lançamento direto pelo repositório (fixture, sem passar pela API). */
async function insertEntry(tenantId: string, userId: string, evaluatedOn: string, pageCount: number): Promise<string> {
  const repo = new EvaluatedDocumentEntriesRepository(testDb.db, { tenantId });
  const entry = await repo.create({ userId, evaluatedOn, pageCount, createdById: null });
  return entry.id;
}

/** Soma `days` a uma data `YYYY-MM-DD` (calendário puro, sem fuso). */
function shiftDay(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

interface ListBody {
  tenantId: string;
  totals: { entries: number; pages: number };
  byUser: Array<{ userId: string | null; label: string | null; entries: number; pages: number }>;
  items: Array<{
    id: string;
    evaluatedOn: string;
    userId: string | null;
    userName: string | null;
    pageCount: number;
    createdById: string | null;
    createdByName: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

type Item = ListBody['items'][number];

async function list(token: string, qs = ''): Promise<ListBody> {
  const res = await call(token, 'GET', `${BASE}${qs}`);
  expect(res.statusCode).toBe(200);
  return res.json() as ListBody;
}

// ---------------------------------------------------------------------------
// Gate de papel
// ---------------------------------------------------------------------------
describe('documentos avaliados — gate de papel', () => {
  it('401 sem token', async () => {
    const res = await app.inject({ method: 'GET', url: BASE });
    expect(res.statusCode).toBe(401);
  });

  it.each([
    ['UPLOADER', () => tokenUploaderA],
    ['USER', () => tokenUserA],
  ])('%s recebe 403 nas 5 rotas, antes de qualquer leitura', async (_role, token) => {
    const entryId = await insertEntry(TENANT_A, USER_A_ID, '2026-01-10', 10);
    const today = todayInSaoPaulo();
    const routes: Array<[Method, string, Record<string, unknown> | undefined]> = [
      ['GET', BASE, undefined],
      ['GET', `${BASE}/users`, undefined],
      ['POST', BASE, { userId: USER_A_ID, evaluatedOn: today, pageCount: 5 }],
      ['PATCH', `${BASE}/${entryId}`, { pageCount: 11, justification: JUSTIFICATION }],
      ['DELETE', `${BASE}/${entryId}`, { justification: JUSTIFICATION }],
    ];
    for (const [method, url, payload] of routes) {
      const res = await call(token(), method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    // Nada foi alterado.
    const body = await list(tokenAdminA);
    expect(body.totals).toEqual({ entries: 1, pages: 10 });
  });

  it('TENANT_ADMIN, MTA (com tenantId) e SA (com tenantId) → 200', async () => {
    await list(tokenAdminA);
    await list(tokenMta, `?tenantId=${TENANT_A}`);
    await list(tokenSuper, `?tenantId=${TENANT_A}`);
  });
});

// ---------------------------------------------------------------------------
// Escopo de empresa (404, nunca 403)
// ---------------------------------------------------------------------------
describe('documentos avaliados — escopo de empresa', () => {
  it('SA e MTA sem tenantId → 404 em GET, GET /users e POST', async () => {
    const today = todayInSaoPaulo();
    for (const token of [tokenSuper, tokenMta]) {
      expect((await call(token, 'GET', BASE)).statusCode).toBe(404);
      expect((await call(token, 'GET', `${BASE}/users`)).statusCode).toBe(404);
      expect(
        (await call(token, 'POST', BASE, { userId: USER_A_ID, evaluatedOn: today, pageCount: 3 })).statusCode,
      ).toBe(404);
    }
  });

  it('MTA com tenantId fora do allowedTenantIds → 404', async () => {
    const entryB = await insertEntry(TENANT_B, USER_B_ID, '2026-01-10', 10);
    const q = `?tenantId=${TENANT_OUTSIDE_MTA}`;
    expect((await call(tokenMta, 'GET', `${BASE}${q}`)).statusCode).toBe(404);
    expect((await call(tokenMta, 'GET', `${BASE}/users${q}`)).statusCode).toBe(404);
    expect(
      (await call(tokenMta, 'POST', BASE, {
        tenantId: TENANT_OUTSIDE_MTA, userId: USER_B_ID, evaluatedOn: '2026-01-10', pageCount: 3,
      })).statusCode,
    ).toBe(404);
    expect(
      (await call(tokenMta, 'PATCH', `${BASE}/${entryB}${q}`, { pageCount: 1, justification: JUSTIFICATION })).statusCode,
    ).toBe(404);
    expect((await call(tokenMta, 'DELETE', `${BASE}/${entryB}${q}`, { justification: JUSTIFICATION })).statusCode).toBe(404);
  });

  it('admin da A: 404 em GET-lista e GET /users com tenantId da B', async () => {
    expect((await call(tokenAdminA, 'GET', `${BASE}?tenantId=${TENANT_B}`)).statusCode).toBe(404);
    expect((await call(tokenAdminA, 'GET', `${BASE}/users?tenantId=${TENANT_B}`)).statusCode).toBe(404);
  });

  it('admin da A: 404 em PATCH e DELETE de lançamento da B, que fica intacto', async () => {
    const entryB = await insertEntry(TENANT_B, USER_B_ID, '2026-01-10', 10);

    const patch = await call(tokenAdminA, 'PATCH', `${BASE}/${entryB}`, { pageCount: 99, justification: JUSTIFICATION });
    expect(patch.statusCode).toBe(404);
    const del = await call(tokenAdminA, 'DELETE', `${BASE}/${entryB}`, { justification: JUSTIFICATION });
    expect(del.statusCode).toBe(404);

    const bodyB = await list(tokenAdminB);
    expect(bodyB.totals).toEqual({ entries: 1, pages: 10 });
    expect(bodyB.items[0]!.pageCount).toBe(10);

    // A não enxerga nada da B.
    const bodyA = await list(tokenAdminA);
    expect(bodyA.totals).toEqual({ entries: 0, pages: 0 });
  });

  it('id que não é UUID → 404 (PATCH e DELETE)', async () => {
    expect(
      (await call(tokenAdminA, 'PATCH', `${BASE}/nao-e-uuid`, { pageCount: 2, justification: JUSTIFICATION })).statusCode,
    ).toBe(404);
    expect((await call(tokenAdminA, 'DELETE', `${BASE}/nao-e-uuid`, { justification: JUSTIFICATION })).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /users — seletor
// ---------------------------------------------------------------------------
describe('GET /reports/evaluated-documents/users', () => {
  it('lista só usuários ativos, não excluídos, da empresa, ordenados por nome', async () => {
    const res = await call(tokenAdminA, 'GET', `${BASE}/users`);
    expect(res.statusCode).toBe(200);
    const users = res.json() as Array<{ id: string; name: string; email: string }>;
    expect(users.map((u) => u.name)).toEqual(['Admin A', 'Beatriz', 'Carlos', 'Uploader A']);
    expect(Object.keys(users[0]!).sort()).toEqual(['email', 'id', 'name']);
  });

  it('MTA com tenantId vê a mesma lista (papéis globais não pertencem à empresa)', async () => {
    const res = await call(tokenMta, 'GET', `${BASE}/users?tenantId=${TENANT_A}`);
    expect(res.statusCode).toBe(200);
    const names = (res.json() as Array<{ name: string }>).map((u) => u.name);
    expect(names).toEqual(['Admin A', 'Beatriz', 'Carlos', 'Uploader A']);
  });
});

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------
describe('POST /reports/evaluated-documents', () => {
  it('cria com data de hoje (America/Sao_Paulo) → 201 com o item', async () => {
    const today = todayInSaoPaulo();
    const res = await call(tokenAdminA, 'POST', BASE, { userId: USER_A_ID, evaluatedOn: today, pageCount: 120 });
    expect(res.statusCode).toBe(201);
    const item = res.json() as Item;
    expect(item).toMatchObject({
      evaluatedOn: today,
      userId: USER_A_ID,
      userName: 'Beatriz',
      pageCount: 120,
      createdById: ADMIN_A_ID,
      createdByName: 'Admin A',
    });

    const body = await list(tokenAdminA);
    expect(body.totals).toEqual({ entries: 1, pages: 120 });
    expect(body.items[0]!.id).toBe(item.id);
  });

  it('userId de outra empresa, inexistente, inativo ou excluído → 404', async () => {
    for (const userId of [USER_B_ID, crypto.randomUUID(), INACTIVE_A_ID, DELETED_A_ID]) {
      const res = await call(tokenAdminA, 'POST', BASE, { userId, evaluatedOn: '2026-01-10', pageCount: 3 });
      expect(res.statusCode, userId).toBe(404);
    }
    expect((await list(tokenAdminA)).totals.entries).toBe(0);
  });

  it('data futura, pageCount inválido, data inexistente ou campo extra → 422', async () => {
    const tomorrow = shiftDay(todayInSaoPaulo(), 1);
    const invalid: Array<Record<string, unknown>> = [
      { userId: USER_A_ID, evaluatedOn: tomorrow, pageCount: 3 },
      { userId: USER_A_ID, evaluatedOn: '2026-01-10', pageCount: 0 },
      { userId: USER_A_ID, evaluatedOn: '2026-01-10', pageCount: -5 },
      { userId: USER_A_ID, evaluatedOn: '2026-01-10', pageCount: 1.5 },
      { userId: USER_A_ID, evaluatedOn: '2026-01-10', pageCount: 1_000_001 },
      { userId: USER_A_ID, evaluatedOn: '2026-02-30', pageCount: 3 },
      { userId: USER_A_ID, evaluatedOn: '10/01/2026', pageCount: 3 },
      { userId: USER_A_ID, evaluatedOn: '2026-01-10', pageCount: 3, extra: true },
      { evaluatedOn: '2026-01-10', pageCount: 3 },
    ];
    for (const payload of invalid) {
      const res = await call(tokenAdminA, 'POST', BASE, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(422);
    }
    expect((await list(tokenAdminA)).totals.entries).toBe(0);
  });

  it('MTA lança na empresa permitida; o nome do MTA não aparece para o TENANT_ADMIN (hierarquia)', async () => {
    const res = await call(tokenMta, 'POST', BASE, {
      tenantId: TENANT_A, userId: USER_A2_ID, evaluatedOn: '2026-02-01', pageCount: 7,
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as Item).createdByName).toBe('MTA Operador');

    const asAdmin = await list(tokenAdminA);
    expect(asAdmin.items[0]!.createdById).toBe(MTA_ID);
    expect(asAdmin.items[0]!.createdByName).toBeNull();
    expect(asAdmin.items[0]!.userName).toBe('Carlos');

    const asMta = await list(tokenMta, `?tenantId=${TENANT_A}`);
    expect(asMta.items[0]!.createdByName).toBe('MTA Operador');
  });
});

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------
describe('PATCH /reports/evaluated-documents/:id', () => {
  it('corrige com justificativa → 200 com o item atualizado', async () => {
    const id = await insertEntry(TENANT_A, USER_A_ID, '2026-01-10', 10);
    const res = await call(tokenAdminA, 'PATCH', `${BASE}/${id}`, {
      userId: USER_A2_ID, pageCount: 15, justification: `  ${JUSTIFICATION}  `,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, userId: USER_A2_ID, userName: 'Carlos', pageCount: 15, evaluatedOn: '2026-01-10' });

    const body = await list(tokenAdminA);
    expect(body.totals).toEqual({ entries: 1, pages: 15 });
    expect(body.byUser).toEqual([{ userId: USER_A2_ID, label: 'Carlos', entries: 1, pages: 15 }]);
  });

  it('justificativa curta (após trim) ou ausente → 422 e nada muda', async () => {
    const id = await insertEntry(TENANT_A, USER_A_ID, '2026-01-10', 10);
    for (const payload of [
      { pageCount: 11, justification: '   curta   ' },
      { pageCount: 11 },
      { pageCount: 11, justification: 'x'.repeat(501) },
    ]) {
      const res = await call(tokenAdminA, 'PATCH', `${BASE}/${id}`, payload);
      expect(res.statusCode, JSON.stringify(payload).slice(0, 60)).toBe(422);
    }
    expect((await list(tokenAdminA)).totals.pages).toBe(10);
  });

  it('sem campo a alterar ou com os mesmos valores → 422', async () => {
    const id = await insertEntry(TENANT_A, USER_A_ID, '2026-01-10', 10);
    expect((await call(tokenAdminA, 'PATCH', `${BASE}/${id}`, { justification: JUSTIFICATION })).statusCode).toBe(422);
    const same = await call(tokenAdminA, 'PATCH', `${BASE}/${id}`, {
      userId: USER_A_ID, evaluatedOn: '2026-01-10', pageCount: 10, justification: JUSTIFICATION,
    });
    expect(same.statusCode).toBe(422);
  });

  it('data futura ou pageCount 0 → 422; userId de outra empresa → 404', async () => {
    const id = await insertEntry(TENANT_A, USER_A_ID, '2026-01-10', 10);
    const tomorrow = shiftDay(todayInSaoPaulo(), 1);
    expect(
      (await call(tokenAdminA, 'PATCH', `${BASE}/${id}`, { evaluatedOn: tomorrow, justification: JUSTIFICATION })).statusCode,
    ).toBe(422);
    expect(
      (await call(tokenAdminA, 'PATCH', `${BASE}/${id}`, { pageCount: 0, justification: JUSTIFICATION })).statusCode,
    ).toBe(422);
    expect(
      (await call(tokenAdminA, 'PATCH', `${BASE}/${id}`, { userId: USER_B_ID, justification: JUSTIFICATION })).statusCode,
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE (corpo JSON em DELETE)
// ---------------------------------------------------------------------------
describe('DELETE /reports/evaluated-documents/:id', () => {
  it('exclui com corpo JSON → 204; o lançamento some de totals, byUser e items; 2ª exclusão → 404', async () => {
    const keep = await insertEntry(TENANT_A, USER_A_ID, '2026-01-10', 10);
    const gone = await insertEntry(TENANT_A, USER_A2_ID, '2026-01-11', 20);

    const res = await call(tokenAdminA, 'DELETE', `${BASE}/${gone}`, { justification: JUSTIFICATION });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    const body = await list(tokenAdminA);
    expect(body.totals).toEqual({ entries: 1, pages: 10 });
    expect(body.byUser.map((r) => r.userId)).toEqual([USER_A_ID]);
    expect(body.items.map((i) => i.id)).toEqual([keep]);

    const again = await call(tokenAdminA, 'DELETE', `${BASE}/${gone}`, { justification: JUSTIFICATION });
    expect(again.statusCode).toBe(404);
  });

  it('aceita corpo JSON cru com Content-Type explícito', async () => {
    const id = await insertEntry(TENANT_A, USER_A_ID, '2026-01-10', 10);
    const res = await app.inject({
      method: 'DELETE',
      url: `${BASE}/${id}`,
      headers: { authorization: `Bearer ${tokenAdminA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ justification: JUSTIFICATION }),
    });
    expect(res.statusCode).toBe(204);
  });

  it('sem corpo, corpo JSON vazio ou justificativa curta → 4xx e o lançamento fica', async () => {
    const id = await insertEntry(TENANT_A, USER_A_ID, '2026-01-10', 10);

    const noBody = await call(tokenAdminA, 'DELETE', `${BASE}/${id}`);
    expect(noBody.statusCode).toBe(422);

    const emptyJson = await app.inject({
      method: 'DELETE',
      url: `${BASE}/${id}`,
      headers: { authorization: `Bearer ${tokenAdminA}`, 'content-type': 'application/json' },
      body: '',
    });
    expect(emptyJson.statusCode).toBe(400);

    const short = await call(tokenAdminA, 'DELETE', `${BASE}/${id}`, { justification: 'curta' });
    expect(short.statusCode).toBe(422);

    expect((await list(tokenAdminA)).totals.entries).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Filtros e paginação
// ---------------------------------------------------------------------------
describe('GET /reports/evaluated-documents — filtros e paginação', () => {
  beforeEach(async () => {
    await insertEntry(TENANT_A, USER_A_ID, '2026-01-10', 10);
    await insertEntry(TENANT_A, USER_A_ID, '2026-02-15', 20);
    await insertEntry(TENANT_A, USER_A2_ID, '2026-02-20', 5);
    await insertEntry(TENANT_A, USER_A2_ID, '2026-03-01', 7);
    await insertEntry(TENANT_B, USER_B_ID, '2026-02-15', 1000);
  });

  it('sem filtro: totais, byUser (páginas DESC) com rótulo e itens por data DESC — só da empresa', async () => {
    const body = await list(tokenAdminA);
    expect(body.tenantId).toBe(TENANT_A);
    expect(body.totals).toEqual({ entries: 4, pages: 42 });
    expect(body.byUser).toEqual([
      { userId: USER_A_ID, label: 'Beatriz', entries: 2, pages: 30 },
      { userId: USER_A2_ID, label: 'Carlos', entries: 2, pages: 12 },
    ]);
    expect(body.items.map((i) => i.evaluatedOn)).toEqual(['2026-03-01', '2026-02-20', '2026-02-15', '2026-01-10']);
    expect(body).toMatchObject({ page: 1, pageSize: 20, total: 4, pageCount: 1 });
  });

  it('período com bordas inclusivas reflete nos totais', async () => {
    const body = await list(tokenAdminA, '?dateFrom=2026-02-15&dateTo=2026-02-20');
    expect(body.totals).toEqual({ entries: 2, pages: 25 });
    expect(body.byUser).toEqual([
      { userId: USER_A_ID, label: 'Beatriz', entries: 1, pages: 20 },
      { userId: USER_A2_ID, label: 'Carlos', entries: 1, pages: 5 },
    ]);
  });

  it('userIds (CSV) reflete nos totais', async () => {
    const one = await list(tokenAdminA, `?userIds=${USER_A2_ID}`);
    expect(one.totals).toEqual({ entries: 2, pages: 12 });
    const both = await list(tokenAdminA, `?userIds=${USER_A_ID},${USER_A2_ID}&dateFrom=2026-02-01`);
    expect(both.totals).toEqual({ entries: 3, pages: 32 });
  });

  it('paginação não altera os totais do filtro', async () => {
    const body = await list(tokenAdminA, '?page=2&pageSize=1');
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.evaluatedOn).toBe('2026-02-20');
    expect(body).toMatchObject({ page: 2, pageSize: 1, total: 4, pageCount: 4 });
    expect(body.totals).toEqual({ entries: 4, pages: 42 });
  });

  it('dateFrom > dateTo, data malformada, pageSize > 100 ou userIds inválido → 422', async () => {
    for (const qs of [
      '?dateFrom=2026-03-01&dateTo=2026-02-01',
      '?dateFrom=2026-13-01',
      '?pageSize=101',
      '?page=0',
      '?userIds=nao-uuid',
    ]) {
      const res = await call(tokenAdminA, 'GET', `${BASE}${qs}`);
      expect(res.statusCode, qs).toBe(422);
    }
  });
});

// ---------------------------------------------------------------------------
// Auditoria
// ---------------------------------------------------------------------------
describe('documentos avaliados — auditoria', () => {
  it('create/update/delete gravam audit com metadata jsonb OBJETO e justificativa nas correções', async () => {
    const created = await call(tokenAdminA, 'POST', BASE, { userId: USER_A_ID, evaluatedOn: '2026-01-10', pageCount: 10 });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as Item).id;

    expect(
      (await call(tokenAdminA, 'PATCH', `${BASE}/${id}`, { pageCount: 12, justification: `  ${JUSTIFICATION} ` })).statusCode,
    ).toBe(200);
    expect(
      (await call(tokenAdminA, 'DELETE', `${BASE}/${id}`, { justification: 'Lançamento duplicado por engano' })).statusCode,
    ).toBe(204);

    const rows = await testDb.db<
      Array<{ action: string; tenant_id: string; user_id: string; resource: string; kind: string; metadata: Record<string, unknown> }>
    >`
      SELECT action, tenant_id, user_id, resource, jsonb_typeof(metadata) AS kind, metadata
        FROM audit_logs
       WHERE resource = ${`evaluated-documents/${id}`}
       ORDER BY created_at, action
    `;
    const byAction = new Map(rows.map((r) => [r.action, r]));
    expect([...byAction.keys()].sort()).toEqual([
      'evaluated_documents.create',
      'evaluated_documents.delete',
      'evaluated_documents.update',
    ]);
    for (const r of rows) {
      expect(r.kind).toBe('object');
      expect(r.tenant_id).toBe(TENANT_A);
      expect(r.user_id).toBe(ADMIN_A_ID);
    }

    expect(byAction.get('evaluated_documents.create')!.metadata).toEqual({
      userId: USER_A_ID, evaluatedOn: '2026-01-10', pageCount: 10,
    });
    expect(byAction.get('evaluated_documents.update')!.metadata).toEqual({
      justification: JUSTIFICATION,
      before: { userId: USER_A_ID, evaluatedOn: '2026-01-10', pageCount: 10 },
      after: { userId: USER_A_ID, evaluatedOn: '2026-01-10', pageCount: 12 },
    });
    expect(byAction.get('evaluated_documents.delete')!.metadata).toEqual({
      justification: 'Lançamento duplicado por engano',
      before: { userId: USER_A_ID, evaluatedOn: '2026-01-10', pageCount: 12 },
    });
  });

  it('operação recusada não grava audit', async () => {
    const id = await insertEntry(TENANT_A, USER_A_ID, '2026-01-10', 10);
    await call(tokenAdminA, 'PATCH', `${BASE}/${id}`, { pageCount: 11, justification: 'curta' });
    await call(tokenUploaderA, 'DELETE', `${BASE}/${id}`, { justification: JUSTIFICATION });
    await call(tokenAdminB, 'DELETE', `${BASE}/${id}`, { justification: JUSTIFICATION });
    const rows = await testDb.db`SELECT 1 FROM audit_logs WHERE resource = ${`evaluated-documents/${id}`}`;
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Atomicidade: escrita + audit na mesma transação
// ---------------------------------------------------------------------------
interface EntryRowSnapshot {
  user_id: string | null;
  page_count: number;
  deleted: boolean;
  updated_by_id: string | null;
  deleted_by_id: string | null;
}

async function rowOf(id: string): Promise<EntryRowSnapshot | undefined> {
  const rows = await testDb.db<EntryRowSnapshot[]>`
    SELECT user_id, page_count, deleted, updated_by_id, deleted_by_id
      FROM evaluated_document_entries
     WHERE id = ${id}
  `;
  return rows[0];
}

describe('documentos avaliados — escrita e audit são atômicos', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('PATCH: falha no audit → 500 e o lançamento fica inalterado no banco', async () => {
    const id = await insertEntry(TENANT_A, USER_A_ID, '2026-01-10', 10);
    const spy = vi.spyOn(AuditLogger.prototype, 'record').mockRejectedValueOnce(new Error('audit indisponível'));

    const res = await call(tokenAdminA, 'PATCH', `${BASE}/${id}`, {
      userId: USER_A2_ID, pageCount: 99, justification: JUSTIFICATION,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(500);
    expect(await rowOf(id)).toEqual({
      user_id: USER_A_ID, page_count: 10, deleted: false, updated_by_id: null, deleted_by_id: null,
    });
    expect((await list(tokenAdminA)).byUser).toEqual([{ userId: USER_A_ID, label: 'Beatriz', entries: 1, pages: 10 }]);

    // Com o audit de volta, a mesma correção passa (nada ficou travado).
    const retry = await call(tokenAdminA, 'PATCH', `${BASE}/${id}`, {
      userId: USER_A2_ID, pageCount: 99, justification: JUSTIFICATION,
    });
    expect(retry.statusCode).toBe(200);
    expect((await rowOf(id))!.page_count).toBe(99);
  });

  it('DELETE: falha no audit → 500 e o lançamento continua ativo', async () => {
    const id = await insertEntry(TENANT_A, USER_A_ID, '2026-01-10', 10);
    const spy = vi.spyOn(AuditLogger.prototype, 'record').mockRejectedValueOnce(new Error('audit indisponível'));

    const res = await call(tokenAdminA, 'DELETE', `${BASE}/${id}`, { justification: JUSTIFICATION });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(500);
    expect(await rowOf(id)).toEqual({
      user_id: USER_A_ID, page_count: 10, deleted: false, updated_by_id: null, deleted_by_id: null,
    });
    expect((await list(tokenAdminA)).totals).toEqual({ entries: 1, pages: 10 });

    const retry = await call(tokenAdminA, 'DELETE', `${BASE}/${id}`, { justification: JUSTIFICATION });
    expect(retry.statusCode).toBe(204);
    expect((await rowOf(id))!.deleted).toBe(true);
  });

  it('POST: falha no audit → 500 e nenhum lançamento é criado', async () => {
    vi.spyOn(AuditLogger.prototype, 'record').mockRejectedValueOnce(new Error('audit indisponível'));
    const res = await call(tokenAdminA, 'POST', BASE, { userId: USER_A_ID, evaluatedOn: '2026-01-10', pageCount: 10 });
    expect(res.statusCode).toBe(500);
    const rows = await testDb.db`SELECT 1 FROM evaluated_document_entries WHERE tenant_id = ${TENANT_A}`;
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Empresa do usuário: só a API garante (o banco tem FK simples em user_id)
// ---------------------------------------------------------------------------
describe('documentos avaliados — empresa do usuário validada pela API', () => {
  it('POST e PATCH com userId de outra empresa → 404 e nada é gravado', async () => {
    const post = await call(tokenAdminA, 'POST', BASE, { userId: USER_B_ID, evaluatedOn: '2026-01-10', pageCount: 3 });
    expect(post.statusCode).toBe(404);
    const created = await testDb.db`SELECT 1 FROM evaluated_document_entries WHERE user_id = ${USER_B_ID}`;
    expect(created).toHaveLength(0);

    const id = await insertEntry(TENANT_A, USER_A_ID, '2026-01-10', 10);
    const patch = await call(tokenAdminA, 'PATCH', `${BASE}/${id}`, { userId: USER_B_ID, justification: JUSTIFICATION });
    expect(patch.statusCode).toBe(404);
    expect((await rowOf(id))!.user_id).toBe(USER_A_ID);
  });
});

// ---------------------------------------------------------------------------
// Regressão B1: usuário local com lançamento promovido a papel global
// ---------------------------------------------------------------------------
describe('regressão — usuário promovido a MULTI_TENANT_ADMIN mantém os lançamentos', () => {
  it('SA promove via PATCH /users/:id → 200; o lançamento segue nos totais e o nome aparece para o SA', async () => {
    await insertEntry(TENANT_A, USER_A_ID, '2026-01-10', 10);
    await insertEntry(TENANT_A, USER_A2_ID, '2026-01-11', 5);

    const res = await call(tokenSuper, 'PATCH', `/users/${USER_A_ID}?tenantId=${TENANT_A}`, {
      role: 'MULTI_TENANT_ADMIN', allowedTenantIds: [TENANT_A],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ role: 'MULTI_TENANT_ADMIN', tenantId: null });

    const asSuper = await list(tokenSuper, `?tenantId=${TENANT_A}`);
    expect(asSuper.totals).toEqual({ entries: 2, pages: 15 });
    expect(asSuper.byUser).toEqual([
      { userId: USER_A_ID, label: 'Beatriz', entries: 1, pages: 10 },
      { userId: USER_A2_ID, label: 'Carlos', entries: 1, pages: 5 },
    ]);
    expect(asSuper.items.find((i) => i.userId === USER_A_ID)!.userName).toBe('Beatriz');

    // Para o TENANT_ADMIN o MTA está ACIMA: continua contando, mas sem nome.
    const asAdmin = await list(tokenAdminA);
    expect(asAdmin.totals).toEqual({ entries: 2, pages: 15 });
    expect(asAdmin.byUser.find((r) => r.userId === USER_A_ID)!.label).toBeNull();

    // E deixou de ser selecionável para novos lançamentos da empresa.
    const users = (await call(tokenAdminA, 'GET', `${BASE}/users`)).json() as Array<{ id: string }>;
    expect(users.map((u) => u.id)).not.toContain(USER_A_ID);
  });
});
