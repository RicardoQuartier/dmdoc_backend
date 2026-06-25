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
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const ADMIN_A_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const UPLOADER_A_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const USER_A_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
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

describe('GET /departments?writable=true — filtro de escrita (seletor de upload)', () => {
  /**
   * Regra de negócio (wiki "Permissões por departamento (ACL)" → seção
   * "Seletor de departamento no upload"):
   *   - Admin (TENANT_ADMIN / SUPER_ADMIN / MTA): todos os departamentos ATIVOS
   *     do escopo, sem restrição de ACL.
   *   - UPLOADER / USER: apenas a subárvore expandida das RAÍZES CONCEDIDAS
   *     (ativas). Sem nenhuma raiz concedida → lista vazia (200, não erro).
   *   - Multi-tenant: continua escopado por tenant (nunca vaza de outro tenant).
   *
   * Bug corrigido: o handler ignorava `?writable=true` e devolvia TODOS os
   * departamentos do tenant para USER/UPLOADER, contrariando a ACL.
   */

  // Árvore do TENANT_A:
  //   Financeiro (raiz) → Contas a Pagar (filho)
  //   RH (raiz, NÃO concedida)
  const FINANCEIRO = '33333333-3333-3333-3333-333333333331';
  const CONTAS_A_PAGAR = '33333333-3333-3333-3333-333333333332';
  const RH = '33333333-3333-3333-3333-333333333333';
  // Departamento do TENANT_B (não deve vazar para atores do TENANT_A)
  const DEPT_TENANT_B = '44444444-4444-4444-4444-444444444444';

  async function seedTreeAndActors(): Promise<void> {
    await testDb.db.collection('tenants').insertOne({
      id: TENANT_B,
      name: 'Empresa B',
      diskQuotaBytes: 10 * 1024 ** 3,
      userQuota: 20,
      active: true,
      createdAt: new Date(),
    });

    await testDb.db.collection('departments').insertMany([
      {
        id: FINANCEIRO,
        tenantId: TENANT_A,
        parentId: null,
        name: 'Financeiro',
        level: 0,
        tags: [],
        deleted: false,
        createdAt: new Date(),
      },
      {
        id: CONTAS_A_PAGAR,
        tenantId: TENANT_A,
        parentId: FINANCEIRO,
        name: 'Contas a Pagar',
        level: 1,
        tags: [],
        deleted: false,
        createdAt: new Date(),
      },
      {
        id: RH,
        tenantId: TENANT_A,
        parentId: null,
        name: 'RH',
        level: 0,
        tags: [],
        deleted: false,
        createdAt: new Date(),
      },
      {
        id: DEPT_TENANT_B,
        tenantId: TENANT_B,
        parentId: null,
        name: 'Financeiro B',
        level: 0,
        tags: [],
        deleted: false,
        createdAt: new Date(),
      },
    ]);

    await seedUser(testDb.db, {
      id: UPLOADER_A_ID,
      tenantId: TENANT_A,
      email: 'uploader-a@empresa.com',
      password: PASSWORD,
      role: 'UPLOADER',
    });

    await seedUser(testDb.db, {
      id: USER_A_ID,
      tenantId: TENANT_A,
      email: 'user-a@empresa.com',
      password: PASSWORD,
      role: 'USER',
    });
  }

  async function grantRoot(userId: string, departmentId: string): Promise<void> {
    await testDb.db.collection('department_permissions').insertOne({
      userId,
      departmentId,
      tenantId: TENANT_A,
      canRead: true,
      canWrite: true,
    });
  }

  it('USER sem nenhuma raiz concedida → [] (200)', async () => {
    await seedTreeAndActors();
    const token = await login('user-a@empresa.com');

    const res = await app.inject({
      method: 'GET',
      url: '/departments?writable=true',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('UPLOADER sem nenhuma raiz concedida → [] (200)', async () => {
    await seedTreeAndActors();
    const token = await login('uploader-a@empresa.com');

    const res = await app.inject({
      method: 'GET',
      url: '/departments?writable=true',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('UPLOADER com 1 raiz concedida → somente a subárvore (raiz + filhos), nunca outras raízes', async () => {
    await seedTreeAndActors();
    await grantRoot(UPLOADER_A_ID, FINANCEIRO);
    const token = await login('uploader-a@empresa.com');

    const res = await app.inject({
      method: 'GET',
      url: '/departments?writable=true',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map((d) => d.id).sort();
    // subárvore de Financeiro: ele próprio + Contas a Pagar; RH NÃO entra.
    expect(ids).toEqual([FINANCEIRO, CONTAS_A_PAGAR].sort());
  });

  it('USER com raiz concedida → subárvore expandida (ACL leitura==escrita)', async () => {
    await seedTreeAndActors();
    await grantRoot(USER_A_ID, FINANCEIRO);
    const token = await login('user-a@empresa.com');

    const res = await app.inject({
      method: 'GET',
      url: '/departments?writable=true',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map((d) => d.id).sort();
    expect(ids).toEqual([FINANCEIRO, CONTAS_A_PAGAR].sort());
  });

  it('TENANT_ADMIN → todos os departamentos ATIVOS do tenant (sem restrição de ACL)', async () => {
    await seedTreeAndActors();

    const res = await app.inject({
      method: 'GET',
      url: '/departments?writable=true',
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map((d) => d.id).sort();
    expect(ids).toEqual([FINANCEIRO, CONTAS_A_PAGAR, RH].sort());
    // jamais inclui o departamento do TENANT_B
    expect(ids).not.toContain(DEPT_TENANT_B);
  });

  it('multi-tenant: UPLOADER do TENANT_A com raiz concedida nunca enxerga depto do TENANT_B', async () => {
    await seedTreeAndActors();
    await grantRoot(UPLOADER_A_ID, FINANCEIRO);
    const token = await login('uploader-a@empresa.com');

    const res = await app.inject({
      method: 'GET',
      url: '/departments?writable=true',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map((d) => d.id);
    expect(ids).not.toContain(DEPT_TENANT_B);
  });

  it('subárvore concedida exclui departamento soft-deletado (destino de upload exige ativo)', async () => {
    await seedTreeAndActors();
    // soft-delete do filho Contas a Pagar
    await testDb.db
      .collection('departments')
      .updateOne({ id: CONTAS_A_PAGAR }, { $set: { deleted: true } });
    await grantRoot(UPLOADER_A_ID, FINANCEIRO);
    const token = await login('uploader-a@empresa.com');

    const res = await app.inject({
      method: 'GET',
      url: '/departments?writable=true',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map((d) => d.id);
    expect(ids).toEqual([FINANCEIRO]);
    expect(ids).not.toContain(CONTAS_A_PAGAR);
  });

  it('GET /departments sem ?writable retorna todos os deptos do tenant para o UPLOADER (ACL não se aplica)', async () => {
    await seedTreeAndActors();
    await grantRoot(UPLOADER_A_ID, FINANCEIRO);
    const token = await login('uploader-a@empresa.com');

    const res = await app.inject({
      method: 'GET',
      url: '/departments',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map((d) => d.id).sort();
    // Sem ?writable: comportamento de gestão — todos os departamentos do tenant,
    // independente da ACL de escrita.
    expect(ids).toEqual([FINANCEIRO, CONTAS_A_PAGAR, RH].sort());
  });
});
