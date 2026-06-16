import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, type TestDb } from '../test/helpers.js';
import { newId } from '@dmdoc/db-mongo';

/**
 * Testes E2E de exclusão de departamento.
 *
 * Regra de negócio (atual): ao excluir um departamento, apenas o próprio
 * departamento vira `deleted: true`. Documentos e permissões vinculados são
 * PRESERVADOS (continuam `deleted: false`) — assim os documentos já carregados
 * não somem e continuam encontráveis na busca e nas listagens por quem tem
 * `canRead`. A exclusão é bloqueada (409) se houver sub-departamentos ativos.
 */

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const ADMIN_A_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const PASSWORD = 'senha-muito-secreta-123';

let app: FastifyInstance;
let testDb: TestDb;
let tokenA: string;

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
  await testDb.db.collection('documents').deleteMany({});
  await testDb.db.collection('department_permissions').deleteMany({});

  await testDb.db.collection('tenants').insertOne({
    id: TENANT_A,
    name: 'Empresa A',
    diskQuotaBytes: 10 * 1024 ** 3,
    userQuota: 20,
    active: true,
    createdAt: new Date(),
  });

  await seedUser(testDb.db, {
    id: ADMIN_A_ID,
    tenantId: TENANT_A,
    email: 'admin-a@empresa.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
  });

  tokenA = await login('admin-a@empresa.com');
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

describe('DELETE /departments/:id — preserva documentos e permissões', () => {
  it('exclui apenas o departamento; documentos e permissões continuam deleted:false', async () => {
    const deptId = newId();
    const docId = newId();
    const permUserId = newId();

    await testDb.db.collection('departments').insertOne({
      id: deptId,
      tenantId: TENANT_A,
      parentId: null,
      name: 'Financeiro',
      level: 0,
      tags: [],
      deleted: false,
      createdAt: new Date(),
    });

    await testDb.db.collection('documents').insertOne({
      id: docId,
      tenantId: TENANT_A,
      departmentId: deptId,
      filename: 'nota-fiscal.pdf',
      deleted: false,
      createdAt: new Date(),
    });

    await testDb.db.collection('department_permissions').insertOne({
      userId: permUserId,
      departmentId: deptId,
      tenantId: TENANT_A,
      canRead: true,
      canWrite: false,
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/departments/${deptId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(204);

    // (a) o departamento está logicamente excluído
    const dept = await testDb.db.collection('departments').findOne({ id: deptId });
    expect(dept?.deleted).toBe(true);

    // (b) o documento foi PRESERVADO — continua deleted:false e com o departmentId
    const doc = await testDb.db.collection('documents').findOne({ id: docId });
    expect(doc?.deleted).toBe(false);
    expect(doc?.departmentId).toBe(deptId);

    // (c) a permissão foi PRESERVADA — continua presente
    const perm = await testDb.db
      .collection('department_permissions')
      .findOne({ departmentId: deptId, userId: permUserId });
    expect(perm).not.toBeNull();
    expect(perm?.deleted).not.toBe(true);
    expect(perm?.canRead).toBe(true);
  });

  it('bloqueia exclusão (409) quando há sub-departamentos ativos', async () => {
    const parentId = newId();
    const childId = newId();

    await testDb.db.collection('departments').insertMany([
      {
        id: parentId,
        tenantId: TENANT_A,
        parentId: null,
        name: 'Jurídico',
        level: 0,
        tags: [],
        deleted: false,
        createdAt: new Date(),
      },
      {
        id: childId,
        tenantId: TENANT_A,
        parentId,
        name: 'Contratos',
        level: 1,
        tags: [],
        deleted: false,
        createdAt: new Date(),
      },
    ]);

    const res = await app.inject({
      method: 'DELETE',
      url: `/departments/${parentId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');

    // O pai NÃO foi excluído
    const parent = await testDb.db.collection('departments').findOne({ id: parentId });
    expect(parent?.deleted).toBe(false);
  });

  it('departamento inexistente → 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/departments/${newId()}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('GET /departments — documentCount', () => {
  it('retorna a contagem direta de documentos (deleted:false) por departamento', async () => {
    const deptComDocs = newId();
    const deptVazio = newId();

    await testDb.db.collection('departments').insertMany([
      {
        id: deptComDocs,
        tenantId: TENANT_A,
        parentId: null,
        name: 'Financeiro',
        level: 0,
        tags: [],
        deleted: false,
        createdAt: new Date(),
      },
      {
        id: deptVazio,
        tenantId: TENANT_A,
        parentId: null,
        name: 'RH',
        level: 0,
        tags: [],
        deleted: false,
        createdAt: new Date(),
      },
    ]);

    await testDb.db.collection('documents').insertMany([
      { id: newId(), tenantId: TENANT_A, departmentId: deptComDocs, deleted: false, createdAt: new Date() },
      { id: newId(), tenantId: TENANT_A, departmentId: deptComDocs, deleted: false, createdAt: new Date() },
      // documento excluído logicamente não deve ser contado
      { id: newId(), tenantId: TENANT_A, departmentId: deptComDocs, deleted: true, createdAt: new Date() },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/departments',
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(200);
    const items = res.json() as Array<{ id: string; documentCount: number }>;

    const comDocs = items.find((d) => d.id === deptComDocs);
    const vazio = items.find((d) => d.id === deptVazio);

    expect(comDocs?.documentCount).toBe(2);
    expect(vazio?.documentCount).toBe(0);
  });
});

describe('GET /departments?writable=true — filtro por acesso de escrita (ACL)', () => {
  const UPLOADER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

  // Monta uma árvore com duas raízes:
  //   Financeiro (raiz)          ← concedida ao uploader nos testes
  //     └─ Contas a Pagar
  //          └─ Notas (neta)
  //     └─ Folha (será soft-deletada em um dos testes)
  //   RH (raiz)                  ← NÃO concedida ao uploader
  //     └─ Recrutamento
  const FINANCEIRO = '21111111-1111-1111-1111-111111111111';
  const CONTAS_PAGAR = '22222222-2222-2222-2222-222222222222';
  const NOTAS = '23333333-3333-3333-3333-333333333333';
  const FOLHA = '24444444-4444-4444-4444-444444444444';
  const RH = '25555555-5555-5555-5555-555555555555';
  const RECRUTAMENTO = '26666666-6666-6666-6666-666666666666';

  async function seedTree(): Promise<void> {
    await testDb.db.collection('departments').insertMany([
      { id: FINANCEIRO, tenantId: TENANT_A, parentId: null, name: 'Financeiro', level: 0, tags: [], deleted: false, createdAt: new Date() },
      { id: CONTAS_PAGAR, tenantId: TENANT_A, parentId: FINANCEIRO, name: 'Contas a Pagar', level: 1, tags: [], deleted: false, createdAt: new Date() },
      { id: NOTAS, tenantId: TENANT_A, parentId: CONTAS_PAGAR, name: 'Notas', level: 2, tags: [], deleted: false, createdAt: new Date() },
      { id: FOLHA, tenantId: TENANT_A, parentId: FINANCEIRO, name: 'Folha', level: 1, tags: [], deleted: false, createdAt: new Date() },
      { id: RH, tenantId: TENANT_A, parentId: null, name: 'RH', level: 0, tags: [], deleted: false, createdAt: new Date() },
      { id: RECRUTAMENTO, tenantId: TENANT_A, parentId: RH, name: 'Recrutamento', level: 1, tags: [], deleted: false, createdAt: new Date() },
    ]);
  }

  async function seedUploader(): Promise<string> {
    await seedUser(testDb.db, {
      id: UPLOADER_ID,
      tenantId: TENANT_A,
      email: 'uploader-a@empresa.com',
      password: PASSWORD,
      role: 'UPLOADER',
    });
    return login('uploader-a@empresa.com');
  }

  async function grantRoot(rootId: string): Promise<void> {
    await testDb.db.collection('department_permissions').insertOne({
      userId: UPLOADER_ID,
      departmentId: rootId,
      tenantId: TENANT_A,
      canRead: true,
      canWrite: true,
    });
  }

  it('(a) UPLOADER com uma raiz concedida → recebe apenas a subárvore daquela raiz, todos ativos', async () => {
    await seedTree();
    const token = await seedUploader();
    await grantRoot(FINANCEIRO);

    const res = await app.inject({
      method: 'GET',
      url: '/departments?writable=true',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map((d) => d.id).sort();

    // Subárvore de Financeiro: a própria raiz + Contas a Pagar + Notas + Folha.
    // RH e Recrutamento (outra raiz, não concedida) NÃO aparecem.
    expect(ids).toEqual([FINANCEIRO, CONTAS_PAGAR, NOTAS, FOLHA].sort());
    expect(ids).not.toContain(RH);
    expect(ids).not.toContain(RECRUTAMENTO);
  });

  it('(b) UPLOADER sem nenhuma raiz concedida → lista vazia (200)', async () => {
    await seedTree();
    const token = await seedUploader();
    // sem grantRoot

    const res = await app.inject({
      method: 'GET',
      url: '/departments?writable=true',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('(c) departamento soft-deletado dentro da subárvore NÃO aparece no modo writable', async () => {
    await seedTree();
    const token = await seedUploader();
    await grantRoot(FINANCEIRO);

    // Soft-delete de "Folha" (filho direto de Financeiro, dentro da subárvore).
    await testDb.db
      .collection('departments')
      .updateOne({ id: FOLHA }, { $set: { deleted: true } });

    const res = await app.inject({
      method: 'GET',
      url: '/departments?writable=true',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map((d) => d.id).sort();

    // Folha foi excluída logicamente → some do writable, mesmo estando na subárvore.
    expect(ids).toEqual([FINANCEIRO, CONTAS_PAGAR, NOTAS].sort());
    expect(ids).not.toContain(FOLHA);
  });

  it('(d) TENANT_ADMIN com writable=true → recebe todos os departamentos ativos do tenant (sem restrição de ACL)', async () => {
    await seedTree();

    const res = await app.inject({
      method: 'GET',
      url: '/departments?writable=true',
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map((d) => d.id).sort();

    expect(ids).toEqual(
      [FINANCEIRO, CONTAS_PAGAR, NOTAS, FOLHA, RH, RECRUTAMENTO].sort()
    );
  });

  it('(e) GET /departments sem writable continua retornando todos os departamentos do tenant (comportamento inalterado)', async () => {
    await seedTree();
    const token = await seedUploader();
    await grantRoot(FINANCEIRO); // mesmo com ACL, sem ?writable o filtro não se aplica

    const res = await app.inject({
      method: 'GET',
      url: '/departments',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map((d) => d.id).sort();

    // Sem ?writable: comportamento atual — todos os departamentos do tenant,
    // independente da ACL de escrita.
    expect(ids).toEqual(
      [FINANCEIRO, CONTAS_PAGAR, NOTAS, FOLHA, RH, RECRUTAMENTO].sort()
    );
  });
});
