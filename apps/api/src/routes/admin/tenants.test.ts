import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { startTestReplSetDb, seedUser, testConfig, type TestReplSetDb } from '../../test/helpers.js';
import { newId } from '@dmdoc/db-mongo';

/**
 * Testes E2E de POST /admin/tenants com suporte a templateId.
 *
 * Usa MongoMemoryReplSet (replica set de 1 nó) porque a criação de tenant
 * com template usa session.withTransaction, que exige replica set.
 *
 * Casos de teste:
 * 1. Criação sem templateId — backward compat (nenhum departamento criado).
 * 2. Criação com templateId válido — departamentos criados para o tenant.
 * 3. Criação com templateId inexistente — 404, tenant NÃO persiste (rollback).
 * 4. Rejeição de templateId com formato não-UUID (422 de validação Zod).
 */

const SUPER_ADMIN_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PASSWORD = 'super-senha-segura-99';

let app: FastifyInstance;
let testDb: TestReplSetDb;
let superAdminToken: string;

beforeAll(async () => {
  testDb = await startTestReplSetDb();
  app = await buildApp({ config: testConfig(), db: testDb.db });

  // Seed do SUPER_ADMIN — sem tenantId (null)
  await seedUser(testDb.db, {
    id: SUPER_ADMIN_ID,
    tenantId: null,
    email: 'superadmin@plataforma.com',
    password: PASSWORD,
    role: 'SUPER_ADMIN',
  });

  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'superadmin@plataforma.com', password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  superAdminToken = res.json().accessToken as string;
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(async () => {
  await testDb.db.collection('tenants').deleteMany({});
  await testDb.db.collection('departments').deleteMany({});
  await testDb.db.collection('department_templates').deleteMany({});
});

// ---------------------------------------------------------------------------
// Helper: insere um template de departamentos de 3 nós (raiz + 2 filhos)
// ---------------------------------------------------------------------------
async function seedTemplate(
  templateId: string,
  nodes: Array<{ refId: string; parentRefId: string | null; name: string; tags?: string[] }>,
) {
  await testDb.db.collection('department_templates').insertOne({
    id: templateId,
    name: 'Template de Teste',
    nodes: nodes.map((n) => ({ ...n, tags: n.tags ?? [] })),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

// ---------------------------------------------------------------------------
// 1. Criação sem templateId — backward compat
// ---------------------------------------------------------------------------
describe('POST /admin/tenants sem templateId', () => {
  it('cria o tenant e retorna 201 sem criar departamentos', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { name: 'Empresa Sem Template' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      name: 'Empresa Sem Template',
      active: true,
    });
    expect(typeof body['id']).toBe('string');

    const deptCount = await testDb.db
      .collection('departments')
      .countDocuments({ tenantId: body['id'] });
    expect(deptCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Criação com templateId válido — departamentos criados
// ---------------------------------------------------------------------------
describe('POST /admin/tenants com templateId válido', () => {
  it('cria o tenant e insere os departamentos do template', async () => {
    const templateId = newId();
    const refA = newId(); // raiz
    const refB = newId(); // filho de A
    const refC = newId(); // filho de A (irmão de B)

    await seedTemplate(templateId, [
      { refId: refA, parentRefId: null, name: 'Departamento A', tags: ['tag1'] },
      { refId: refB, parentRefId: refA, name: 'Departamento B' },
      { refId: refC, parentRefId: refA, name: 'Departamento C', tags: ['tag2'] },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { name: 'Empresa Com Template', templateId },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    const tenantId = body['id'] as string;
    expect(typeof tenantId).toBe('string');

    // Verifica que os departamentos foram criados para este tenant
    const depts = await testDb.db
      .collection('departments')
      .find({ tenantId, deleted: false })
      .toArray();

    expect(depts).toHaveLength(3);

    // Verifica a raiz (level 0, parentId null)
    const raiz = depts.find((d) => d['name'] === 'Departamento A');
    expect(raiz).toBeDefined();
    expect(raiz!['level']).toBe(0);
    expect(raiz!['parentId']).toBeNull();
    expect(raiz!['tenantId']).toBe(tenantId);
    expect(raiz!['deleted']).toBe(false);
    expect(raiz!['tags']).toEqual(['tag1']);

    // Verifica os filhos (level 1, parentId = id da raiz)
    const filhoB = depts.find((d) => d['name'] === 'Departamento B');
    expect(filhoB).toBeDefined();
    expect(filhoB!['level']).toBe(1);
    expect(filhoB!['parentId']).toBe(raiz!['id']);

    const filhoC = depts.find((d) => d['name'] === 'Departamento C');
    expect(filhoC).toBeDefined();
    expect(filhoC!['level']).toBe(1);
    expect(filhoC!['parentId']).toBe(raiz!['id']);
    expect(filhoC!['tags']).toEqual(['tag2']);
  });

  it('preserva isolamento multi-tenant: departamentos pertencem só ao novo tenant', async () => {
    const templateId = newId();
    const refRoot = newId();

    await seedTemplate(templateId, [
      { refId: refRoot, parentRefId: null, name: 'Raiz' },
    ]);

    // Primeiro tenant
    const res1 = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { name: 'Empresa Alpha', templateId },
    });
    expect(res1.statusCode).toBe(201);
    const tenantAlpha = (res1.json() as Record<string, unknown>)['id'] as string;

    // Segundo tenant com o mesmo template
    const res2 = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { name: 'Empresa Beta', templateId },
    });
    expect(res2.statusCode).toBe(201);
    const tenantBeta = (res2.json() as Record<string, unknown>)['id'] as string;

    // Cada tenant deve ter apenas seus próprios departamentos
    const deptsAlpha = await testDb.db
      .collection('departments')
      .find({ tenantId: tenantAlpha })
      .toArray();
    const deptsBeta = await testDb.db
      .collection('departments')
      .find({ tenantId: tenantBeta })
      .toArray();

    expect(deptsAlpha).toHaveLength(1);
    expect(deptsBeta).toHaveLength(1);
    expect(deptsAlpha[0]!['id']).not.toBe(deptsBeta[0]!['id']);
    expect(deptsAlpha[0]!['tenantId']).toBe(tenantAlpha);
    expect(deptsBeta[0]!['tenantId']).toBe(tenantBeta);
  });

  it('calcula corretamente level em árvore de 3 níveis', async () => {
    const templateId = newId();
    const refA = newId();
    const refB = newId();
    const refC = newId(); // neto de A

    await seedTemplate(templateId, [
      { refId: refA, parentRefId: null, name: 'Nível 0' },
      { refId: refB, parentRefId: refA, name: 'Nível 1' },
      { refId: refC, parentRefId: refB, name: 'Nível 2' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { name: 'Empresa 3 Níveis', templateId },
    });
    expect(res.statusCode).toBe(201);
    const tenantId = (res.json() as Record<string, unknown>)['id'] as string;

    const depts = await testDb.db
      .collection('departments')
      .find({ tenantId })
      .sort({ level: 1 })
      .toArray();

    expect(depts).toHaveLength(3);
    expect(depts[0]!['level']).toBe(0);
    expect(depts[1]!['level']).toBe(1);
    expect(depts[2]!['level']).toBe(2);

    // Verifica cadeia de parentIds
    expect(depts[0]!['parentId']).toBeNull();
    expect(depts[1]!['parentId']).toBe(depts[0]!['id']);
    expect(depts[2]!['parentId']).toBe(depts[1]!['id']);
  });
});

// ---------------------------------------------------------------------------
// 3. Criação com templateId inexistente — rollback da transação
// ---------------------------------------------------------------------------
describe('POST /admin/tenants com templateId inexistente', () => {
  it('retorna 404 e NÃO persiste o tenant', async () => {
    const inexistentTemplateId = newId();

    const res = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { name: 'Empresa Fantasma', templateId: inexistentTemplateId },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });

    // O tenant NÃO deve ter sido persistido (rollback da transação)
    const tenant = await testDb.db
      .collection('tenants')
      .findOne({ name: 'Empresa Fantasma' });
    expect(tenant).toBeNull();

    // Nenhum departamento deve ter sido criado
    const deptCount = await testDb.db.collection('departments').countDocuments({});
    expect(deptCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Validação de formato do templateId (Zod)
// ---------------------------------------------------------------------------
describe('POST /admin/tenants com templateId inválido', () => {
  it('retorna 422 se templateId não for um UUID válido', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { name: 'Empresa Inválida', templateId: 'nao-e-um-uuid' },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    });

    // Nenhum tenant criado
    const tenant = await testDb.db
      .collection('tenants')
      .findOne({ name: 'Empresa Inválida' });
    expect(tenant).toBeNull();
  });
});
