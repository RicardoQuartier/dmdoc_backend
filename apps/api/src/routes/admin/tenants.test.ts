import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { buildApp } from '../../app.js';
import { startTestReplSetDb, seedUser, testConfig, type TestReplSetDb } from '../../test/helpers.js';
import { newId } from '@dmdoc/db-pg';

/**
 * Testes E2E de POST /admin/tenants com suporte a templateId.
 *
 * Usa startTestReplSetDb (que agora é um alias para startTestDb — PostgreSQL).
 * A criação de tenant com template usa sql.begin (transação PostgreSQL nativa).
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
  await testDb.db`DELETE FROM departments`;
  await testDb.db`DELETE FROM department_templates`;
  // audit_logs referencia tenants(id) via FK RESTRICT — limpar antes de tenants.
  await testDb.db`DELETE FROM audit_logs`;
  await testDb.db`DELETE FROM tenants`;
});

// ---------------------------------------------------------------------------
// Helper: insere um template de departamentos de 3 nós (raiz + 2 filhos)
// ---------------------------------------------------------------------------
async function seedTemplate(
  templateId: string,
  nodes: Array<{ refId: string; parentRefId: string | null; name: string; tags?: string[] }>,
) {
  await testDb.db`
    INSERT INTO department_templates (id, name, nodes, created_at, updated_at)
    VALUES (
      ${templateId},
      'Template de Teste',
      ${testDb.db.json(nodes.map((n) => ({ ...n, tags: n.tags ?? [] })))},
      NOW(),
      NOW()
    )
  `;
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

    const tenantId = body['id'] as string;
    const rows = await testDb.db`SELECT COUNT(*)::int AS cnt FROM departments WHERE tenant_id = ${tenantId}`;
    expect(rows[0]?.['cnt']).toBe(0);
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
    const depts = await testDb.db<Array<Record<string, unknown>>>`
      SELECT id, tenant_id, parent_id, name, level, tags, deleted
      FROM departments
      WHERE tenant_id = ${tenantId} AND deleted = false
    `;

    expect(depts).toHaveLength(3);

    // Verifica a raiz (level 0, parentId null)
    const raiz = depts.find((d) => d['name'] === 'Departamento A');
    expect(raiz).toBeDefined();
    expect(raiz!['level']).toBe(0);
    expect(raiz!['parent_id']).toBeNull();
    expect(raiz!['tenant_id']).toBe(tenantId);
    expect(raiz!['deleted']).toBe(false);
    expect(raiz!['tags']).toEqual(['tag1']);

    // Verifica os filhos (level 1, parentId = id da raiz)
    const filhoB = depts.find((d) => d['name'] === 'Departamento B');
    expect(filhoB).toBeDefined();
    expect(filhoB!['level']).toBe(1);
    expect(filhoB!['parent_id']).toBe(raiz!['id']);

    const filhoC = depts.find((d) => d['name'] === 'Departamento C');
    expect(filhoC).toBeDefined();
    expect(filhoC!['level']).toBe(1);
    expect(filhoC!['parent_id']).toBe(raiz!['id']);
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
    const deptsAlpha = await testDb.db<Array<Record<string, unknown>>>`
      SELECT id, tenant_id FROM departments WHERE tenant_id = ${tenantAlpha}
    `;
    const deptsBeta = await testDb.db<Array<Record<string, unknown>>>`
      SELECT id, tenant_id FROM departments WHERE tenant_id = ${tenantBeta}
    `;

    expect(deptsAlpha).toHaveLength(1);
    expect(deptsBeta).toHaveLength(1);
    expect(deptsAlpha[0]!['id']).not.toBe(deptsBeta[0]!['id']);
    expect(deptsAlpha[0]!['tenant_id']).toBe(tenantAlpha);
    expect(deptsBeta[0]!['tenant_id']).toBe(tenantBeta);
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

    const depts = await testDb.db<Array<Record<string, unknown>>>`
      SELECT id, parent_id, level FROM departments WHERE tenant_id = ${tenantId} ORDER BY level ASC
    `;

    expect(depts).toHaveLength(3);
    expect(depts[0]!['level']).toBe(0);
    expect(depts[1]!['level']).toBe(1);
    expect(depts[2]!['level']).toBe(2);

    // Verifica cadeia de parentIds
    expect(depts[0]!['parent_id']).toBeNull();
    expect(depts[1]!['parent_id']).toBe(depts[0]!['id']);
    expect(depts[2]!['parent_id']).toBe(depts[1]!['id']);
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
    const rows = await testDb.db`SELECT id FROM tenants WHERE name = 'Empresa Fantasma'`;
    expect(rows).toHaveLength(0);

    // Nenhum departamento deve ter sido criado
    const deptRows = await testDb.db`SELECT COUNT(*)::int AS cnt FROM departments`;
    expect(deptRows[0]?.['cnt']).toBe(0);
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
    const rows = await testDb.db`SELECT id FROM tenants WHERE name = 'Empresa Inválida'`;
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4b. Flags de IA por empresa — plus comercial exclusivo do SUPER_ADMIN
//     (GET /admin/tenants e PATCH /admin/tenants/:id)
// ---------------------------------------------------------------------------
describe('GET /admin/tenants — flags de IA (plus comercial por empresa)', () => {
  it('lista tenants incluindo as 3 flags de IA, default true', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { name: 'Empresa Flags IA Listagem' },
    });
    expect(created.statusCode).toBe(201);

    const list = await app.inject({
      method: 'GET',
      url: '/admin/tenants',
      headers: { authorization: `Bearer ${superAdminToken}` },
    });
    expect(list.statusCode).toBe(200);

    const items = list.json().items as Array<Record<string, unknown>>;
    const item = items.find((i) => i['name'] === 'Empresa Flags IA Listagem');
    expect(item).toMatchObject({
      aiClassificationEnabled: true,
      aiTitleSuggestionEnabled: true,
      aiIndexSuggestionEnabled: true,
    });
  });
});

describe('PATCH /admin/tenants/:id — flags de IA (plus comercial, exclusivo do SUPER_ADMIN)', () => {
  it('aceita subconjunto de campos incluindo flags de IA e persiste', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { name: 'Empresa PATCH Flags IA' },
    });
    const tenantId = (created.json() as Record<string, unknown>)['id'] as string;

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/tenants/${tenantId}`,
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { userQuota: 30, aiClassificationEnabled: false, aiIndexSuggestionEnabled: false },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      userQuota: 30,
      aiClassificationEnabled: false,
      aiTitleSuggestionEnabled: true,
      aiIndexSuggestionEnabled: false,
    });

    const rows = await testDb.db<
      Array<{
        ai_classification_enabled: boolean;
        ai_title_suggestion_enabled: boolean;
        ai_index_suggestion_enabled: boolean;
      }>
    >`
      SELECT ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled
      FROM tenants WHERE id = ${tenantId}
    `;
    expect(rows[0]).toMatchObject({
      ai_classification_enabled: false,
      ai_title_suggestion_enabled: true,
      ai_index_suggestion_enabled: false,
    });
  });

  it('registra um AuditLog com ator, e diff antes/depois apenas das flags de IA informadas', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { name: 'Empresa Audit Flags IA' },
    });
    const tenantId = (created.json() as Record<string, unknown>)['id'] as string;

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/tenants/${tenantId}`,
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { name: 'Empresa Audit Flags IA Renomeada', aiTitleSuggestionEnabled: false },
    });
    expect(res.statusCode).toBe(200);

    // `metadata` é jsonb, mas o cliente postgres.js usado aqui não registra um
    // parser automático para json/jsonb — a coluna volta como string bruta e
    // precisa de JSON.parse manual (mesmo comportamento de outras rotas).
    const rows = await testDb.db<
      Array<{
        tenant_id: string | null;
        user_id: string | null;
        action: string;
        resource: string | null;
        metadata: string;
      }>
    >`
      SELECT tenant_id, user_id, action, resource, metadata
      FROM audit_logs
      WHERE action = 'tenant.ai_settings.update' AND tenant_id = ${tenantId}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    expect(rows).toHaveLength(1);
    const log = rows[0]!;
    const metadata = JSON.parse(log.metadata) as {
      actorRole?: string;
      changes?: Record<string, { before: boolean; after: boolean }>;
    };
    expect(log.tenant_id).toBe(tenantId);
    expect(log.user_id).toBe(SUPER_ADMIN_ID);
    expect(log.resource).toBe(`tenants/${tenantId}`);
    expect(metadata.actorRole).toBe('SUPER_ADMIN');
    expect(metadata.changes).toMatchObject({
      aiTitleSuggestionEnabled: { before: true, after: false },
    });
    // Só a flag de IA informada entra no diff — `name` nunca foi auditado
    // nesta rota e não deve aparecer no diff de flags de IA.
    expect(metadata.changes).not.toHaveProperty('aiClassificationEnabled');
    expect(metadata.changes).not.toHaveProperty('aiIndexSuggestionEnabled');
    expect(metadata.changes).not.toHaveProperty('name');
  });

  it('PATCH sem flags de IA não registra AuditLog de tenant.ai_settings.update', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { name: 'Empresa Sem Flags IA' },
    });
    const tenantId = (created.json() as Record<string, unknown>)['id'] as string;

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/tenants/${tenantId}`,
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { userQuota: 55 },
    });
    expect(res.statusCode).toBe(200);

    const rows = await testDb.db`
      SELECT id FROM audit_logs WHERE action = 'tenant.ai_settings.update' AND tenant_id = ${tenantId}
    `;
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PATCH /admin/tenants/:id — auditoria de dados administrativos (name/cotas/active)
// ---------------------------------------------------------------------------

describe('PATCH /admin/tenants/:id — AuditLog de dados administrativos', () => {
  interface AuditRow {
    tenant_id: string | null;
    user_id: string | null;
    action: string;
    resource: string | null;
    metadata: string;
  }

  async function createTenant(name: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { name, diskQuotaBytes: 1_000_000, userQuota: 10 },
    });
    return (created.json() as Record<string, unknown>)['id'] as string;
  }

  async function fetchSettingsAudit(tenantId: string): Promise<AuditRow | undefined> {
    const rows = await testDb.db<AuditRow[]>`
      SELECT tenant_id, user_id, action, resource, metadata
      FROM audit_logs
      WHERE action = 'tenant.settings.update' AND tenant_id = ${tenantId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return rows[0];
  }

  it('alterar name gera AuditLog tenant.settings.update com before/after', async () => {
    const tenantId = await createTenant('Empresa Nome Antigo');
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/tenants/${tenantId}`,
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { name: 'Empresa Nome Novo' },
    });
    expect(res.statusCode).toBe(200);

    const log = await fetchSettingsAudit(tenantId);
    expect(log).toBeDefined();
    expect(log!.tenant_id).toBe(tenantId);
    expect(log!.user_id).toBe(SUPER_ADMIN_ID);
    expect(log!.resource).toBe(`tenants/${tenantId}`);
    const metadata = JSON.parse(log!.metadata) as {
      actorRole?: string;
      changes?: Record<string, { before: unknown; after: unknown }>;
    };
    expect(metadata.actorRole).toBe('SUPER_ADMIN');
    expect(metadata.changes).toMatchObject({
      name: { before: 'Empresa Nome Antigo', after: 'Empresa Nome Novo' },
    });
    // Campos não alterados não entram no diff
    expect(metadata.changes).not.toHaveProperty('diskQuotaBytes');
    expect(metadata.changes).not.toHaveProperty('userQuota');
    expect(metadata.changes).not.toHaveProperty('active');
  });

  it('alterar diskQuotaBytes e userQuota gera diff numérico correto', async () => {
    const tenantId = await createTenant('Empresa Cotas');
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/tenants/${tenantId}`,
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { diskQuotaBytes: 5_000_000, userQuota: 42 },
    });
    expect(res.statusCode).toBe(200);

    const log = await fetchSettingsAudit(tenantId);
    expect(log).toBeDefined();
    const metadata = JSON.parse(log!.metadata) as {
      changes?: Record<string, { before: unknown; after: unknown }>;
    };
    expect(metadata.changes).toMatchObject({
      diskQuotaBytes: { before: 1_000_000, after: 5_000_000 },
      userQuota: { before: 10, after: 42 },
    });
  });

  it('alterar active gera diff booleano', async () => {
    const tenantId = await createTenant('Empresa Ativa');
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/tenants/${tenantId}`,
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);

    const log = await fetchSettingsAudit(tenantId);
    expect(log).toBeDefined();
    const metadata = JSON.parse(log!.metadata) as {
      changes?: Record<string, { before: unknown; after: unknown }>;
    };
    expect(metadata.changes).toMatchObject({ active: { before: true, after: false } });
  });

  it('PATCH que só altera flag de IA NÃO gera tenant.settings.update', async () => {
    const tenantId = await createTenant('Empresa Só IA');
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/tenants/${tenantId}`,
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { aiClassificationEnabled: false },
    });
    expect(res.statusCode).toBe(200);

    const rows = await testDb.db`
      SELECT id FROM audit_logs WHERE action = 'tenant.settings.update' AND tenant_id = ${tenantId}
    `;
    expect(rows).toHaveLength(0);
  });

  it('PATCH com name + flag de IA gera os DOIS logs (settings e ai_settings)', async () => {
    const tenantId = await createTenant('Empresa Mista');
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/tenants/${tenantId}`,
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { name: 'Empresa Mista Renomeada', aiTitleSuggestionEnabled: false },
    });
    expect(res.statusCode).toBe(200);

    const settings = await testDb.db`
      SELECT id FROM audit_logs WHERE action = 'tenant.settings.update' AND tenant_id = ${tenantId}
    `;
    const aiSettings = await testDb.db`
      SELECT id FROM audit_logs WHERE action = 'tenant.ai_settings.update' AND tenant_id = ${tenantId}
    `;
    expect(settings).toHaveLength(1);
    expect(aiSettings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. DELETE /admin/tenants/:id — exclusão (soft-delete) + enfileiramento
// ---------------------------------------------------------------------------
describe('DELETE /admin/tenants/:id', () => {
  const MTA_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const MTA_PASSWORD = 'mta-senha-segura-77';

  let deleteApp: FastifyInstance;
  let mtaToken: string;
  const queueAddMock = vi.fn(async () => ({ id: 'job-1' }));
  const tenantDeletionQueue = {
    add: queueAddMock,
    close: async () => {},
  } as unknown as Queue;

  beforeAll(async () => {
    deleteApp = await buildApp({ config: testConfig(), db: testDb.db, tenantDeletionQueue });

    // MULTI_TENANT_ADMIN é papel global (tenant_id null) — não é SUPER_ADMIN,
    // então cai no 403; sem tenant_id evita conflito de FK na limpeza de tenants.
    await seedUser(testDb.db, {
      id: MTA_ID,
      tenantId: null,
      email: 'mta@plataforma.com',
      password: MTA_PASSWORD,
      role: 'MULTI_TENANT_ADMIN',
    });

    const res = await deleteApp.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'mta@plataforma.com', password: MTA_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    mtaToken = res.json().accessToken as string;
  });

  afterAll(async () => {
    await deleteApp.close();
  });

  beforeEach(() => {
    queueAddMock.mockClear();
  });

  async function createTenant(name: string): Promise<string> {
    const res = await deleteApp.inject({
      method: 'POST',
      url: '/admin/tenants',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as Record<string, unknown>)['id'] as string;
  }

  it('retorna 403 para papel não-SUPER_ADMIN', async () => {
    const tenantId = await createTenant('Empresa 403');

    const res = await deleteApp.inject({
      method: 'DELETE',
      url: `/admin/tenants/${tenantId}`,
      headers: { authorization: `Bearer ${mtaToken}` },
    });

    expect(res.statusCode).toBe(403);
    expect(queueAddMock).not.toHaveBeenCalled();

    // Tenant permanece intacto (não marcado como deleted)
    const rows = await testDb.db<Array<{ deleted: boolean }>>`SELECT deleted FROM tenants WHERE id = ${tenantId}`;
    expect(rows[0]?.deleted).toBe(false);
  });

  it('retorna 404 para id inexistente', async () => {
    const res = await deleteApp.inject({
      method: 'DELETE',
      url: `/admin/tenants/${newId()}`,
      headers: { authorization: `Bearer ${superAdminToken}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(queueAddMock).not.toHaveBeenCalled();
  });

  it('retorna 404 ao tentar excluir um tenant já excluído (idempotência)', async () => {
    const tenantId = await createTenant('Empresa Já Excluída');

    const first = await deleteApp.inject({
      method: 'DELETE',
      url: `/admin/tenants/${tenantId}`,
      headers: { authorization: `Bearer ${superAdminToken}` },
    });
    expect(first.statusCode).toBe(202);

    const second = await deleteApp.inject({
      method: 'DELETE',
      url: `/admin/tenants/${tenantId}`,
      headers: { authorization: `Bearer ${superAdminToken}` },
    });
    expect(second.statusCode).toBe(404);
    expect(second.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    // Só o primeiro disparo enfileirou o job
    expect(queueAddMock).toHaveBeenCalledTimes(1);
  });

  it('retorna 202, marca o tenant como deleted e enfileira o job de purga', async () => {
    const tenantId = await createTenant('Empresa Feliz');

    const res = await deleteApp.inject({
      method: 'DELETE',
      url: `/admin/tenants/${tenantId}`,
      headers: { authorization: `Bearer ${superAdminToken}` },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ id: tenantId, status: 'deleting' });

    // Tenant marcado deleted=true / active=false / deleted_at preenchido / renomeado
    const rows = await testDb.db<Array<{ deleted: boolean; active: boolean; deleted_at: Date | null; name: string }>>`
      SELECT deleted, active, deleted_at, name FROM tenants WHERE id = ${tenantId}
    `;
    expect(rows[0]?.deleted).toBe(true);
    expect(rows[0]?.active).toBe(false);
    expect(rows[0]?.deleted_at).not.toBeNull();
    expect(rows[0]?.name).toMatch(/^\[EXCLUÍDA-\d+\] Empresa Feliz$/);

    // Job enfileirado exatamente uma vez com o payload { tenantId }
    expect(queueAddMock).toHaveBeenCalledTimes(1);
    expect(queueAddMock).toHaveBeenCalledWith('purge', { tenantId }, expect.objectContaining({ attempts: 3 }));

    // AuditLog registrado
    const audit = await testDb.db<Array<{ action: string }>>`
      SELECT action FROM audit_logs WHERE tenant_id = ${tenantId} AND action = 'tenant.delete.requested'
    `;
    expect(audit).toHaveLength(1);
  });

  it('GET /admin/tenants não retorna empresas excluídas', async () => {
    const visivelId = await createTenant('Empresa Visível');
    const excluidaId = await createTenant('Empresa Sumida');

    const del = await deleteApp.inject({
      method: 'DELETE',
      url: `/admin/tenants/${excluidaId}`,
      headers: { authorization: `Bearer ${superAdminToken}` },
    });
    expect(del.statusCode).toBe(202);

    const list = await deleteApp.inject({
      method: 'GET',
      url: '/admin/tenants',
      headers: { authorization: `Bearer ${superAdminToken}` },
    });
    expect(list.statusCode).toBe(200);
    const ids = (list.json().items as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toContain(visivelId);
    expect(ids).not.toContain(excluidaId);
  });
});
