import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, type TestDb } from '../test/helpers.js';

/**
 * Testes E2E de GET/PATCH /tenant/ai-settings — Fase 6.9, entregável 69.
 *
 * A rota nunca aceita tenantId como parâmetro — opera sempre sobre o próprio
 * tenant do token do usuário autenticado (TENANT_ADMIN). O teste de isolamento
 * confirma que um TENANT_ADMIN da empresa A não consegue ler nem alterar as
 * flags da empresa B, mesmo sem a rota aceitar tenantId explícito.
 */

const TENANT_A = '33333333-3333-3333-3333-333333333333';
const TENANT_B = '44444444-4444-4444-4444-444444444444';
const ADMIN_A_ID = 'e0000000-0000-0000-0000-00000000a001';
const ADMIN_B_ID = 'e0000000-0000-0000-0000-00000000a002';
const SUPER_ADMIN_ID = 'e0000000-0000-0000-0000-00000000a003';
const PASSWORD = 'senha-forte-de-teste-789';

let app: FastifyInstance;
let testDb: TestDb;
let tokenAdminA: string;
let tokenAdminB: string;
let tokenSuperAdmin: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = await buildApp({ config: testConfig(), db: testDb.db, queue: null });
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(async () => {
  await testDb.db`DELETE FROM audit_logs WHERE user_id IN (${ADMIN_A_ID}, ${ADMIN_B_ID}, ${SUPER_ADMIN_ID})`;
  await testDb.db`DELETE FROM users WHERE id IN (${ADMIN_A_ID}, ${ADMIN_B_ID}, ${SUPER_ADMIN_ID})`;
  await testDb.db`DELETE FROM tenants WHERE id IN (${TENANT_A}, ${TENANT_B})`;

  await testDb.db`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
    VALUES
      (${TENANT_A}, 'Empresa A AI Settings', ${10 * 1024 ** 3}, 20, true, NOW()),
      (${TENANT_B}, 'Empresa B AI Settings', ${10 * 1024 ** 3}, 20, true, NOW())
    ON CONFLICT (id) DO NOTHING
  `;

  await seedUser(testDb.db, {
    id: ADMIN_A_ID, tenantId: TENANT_A, email: 'admin-a-ai@test.com',
    password: PASSWORD, role: 'TENANT_ADMIN',
  });
  await seedUser(testDb.db, {
    id: ADMIN_B_ID, tenantId: TENANT_B, email: 'admin-b-ai@test.com',
    password: PASSWORD, role: 'TENANT_ADMIN',
  });
  await seedUser(testDb.db, {
    id: SUPER_ADMIN_ID, tenantId: null, email: 'super-ai@test.com',
    password: PASSWORD, role: 'SUPER_ADMIN',
  });

  const loginA = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email: 'admin-a-ai@test.com', password: PASSWORD },
  });
  tokenAdminA = (loginA.json() as { accessToken: string }).accessToken;

  const loginB = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email: 'admin-b-ai@test.com', password: PASSWORD },
  });
  tokenAdminB = (loginB.json() as { accessToken: string }).accessToken;

  const loginSA = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email: 'super-ai@test.com', password: PASSWORD },
  });
  tokenSuperAdmin = (loginSA.json() as { accessToken: string }).accessToken;
});

describe('GET /tenant/ai-settings', () => {
  it('retorna 401 sem token', async () => {
    const res = await app.inject({ method: 'GET', url: '/tenant/ai-settings' });
    expect(res.statusCode).toBe(401);
  });

  it('retorna as 3 flags do próprio tenant, todas true por default', async () => {
    const res = await app.inject({
      method: 'GET', url: '/tenant/ai-settings',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      tenantId: TENANT_A,
      aiClassificationEnabled: true,
      aiTitleSuggestionEnabled: true,
      aiIndexSuggestionEnabled: true,
    });
  });

  it('SUPER_ADMIN sem tenant no token recebe 404 (rota não aceita tenantId)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/tenant/ai-settings',
      headers: { authorization: `Bearer ${tokenSuperAdmin}` },
    });
    // requireRole permite SUPER_ADMIN passar, mas resolveTenantContext(write:false)
    // devolve mode 'all' — sem tenantId concreto a rota não tem o que responder.
    expect(res.statusCode).toBe(404);
  });

  describe('bloco `effective` — combinação platform_settings AND tenants', () => {
    // `platform_settings` é o singleton global (Fase 6.9, entregável 68) e é
    // compartilhado por todos os arquivos de teste no mesmo banco — sempre
    // restaurar o default (true) após alterar, para não vazar estado.
    afterEach(async () => {
      await testDb.db`
        UPDATE platform_settings
        SET ai_classification_enabled = true,
            ai_title_suggestion_enabled = true,
            ai_index_suggestion_enabled = true
      `;
    });

    it('platform desligado + tenant ligado → effective.<feature> false (AND), sem alterar a config própria do tenant', async () => {
      await testDb.db`UPDATE platform_settings SET ai_title_suggestion_enabled = false`;

      const res = await app.inject({
        method: 'GET', url: '/tenant/ai-settings',
        headers: { authorization: `Bearer ${tokenAdminA}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        tenantId: TENANT_A,
        // Config própria do tenant permanece true — o toggle dele não muda,
        // só o valor efetivo é afetado pelo kill switch de plataforma.
        aiClassificationEnabled: true,
        aiTitleSuggestionEnabled: true,
        aiIndexSuggestionEnabled: true,
        effective: {
          classificationEnabled: true,
          titleSuggestionEnabled: false,
          indexSuggestionEnabled: true,
        },
      });
    });
  });
});

describe('PATCH /tenant/ai-settings', () => {
  it('retorna 401 sem token', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/tenant/ai-settings',
      payload: { aiClassificationEnabled: false },
    });
    expect(res.statusCode).toBe(401);
  });

  it('atualiza apenas o campo informado, preservando os demais, escopado ao próprio tenant', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/tenant/ai-settings',
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { aiClassificationEnabled: false },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      tenantId: TENANT_A,
      aiClassificationEnabled: false,
      aiTitleSuggestionEnabled: true,
      aiIndexSuggestionEnabled: true,
    });

    const rows = await testDb.db<
      Array<{
        ai_classification_enabled: boolean;
        ai_title_suggestion_enabled: boolean;
        ai_index_suggestion_enabled: boolean;
      }>
    >`SELECT ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled FROM tenants WHERE id = ${TENANT_A}`;
    expect(rows[0]).toMatchObject({
      ai_classification_enabled: false,
      ai_title_suggestion_enabled: true,
      ai_index_suggestion_enabled: true,
    });
  });

  it('aceita subconjunto com múltiplas flags de uma vez', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/tenant/ai-settings',
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { aiTitleSuggestionEnabled: false, aiIndexSuggestionEnabled: false },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      aiClassificationEnabled: true,
      aiTitleSuggestionEnabled: false,
      aiIndexSuggestionEnabled: false,
    });
  });

  it('registra um AuditLog com ator, flags alteradas e valores antes/depois', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/tenant/ai-settings',
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { aiClassificationEnabled: false, aiTitleSuggestionEnabled: false },
    });
    expect(res.statusCode).toBe(200);

    // `metadata` é jsonb, mas o cliente postgres.js usado aqui não registra um
    // parser automático para json/jsonb (ver `createPgClient`) — a coluna
    // sempre volta como string bruta e precisa de JSON.parse manual.
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
      WHERE action = 'tenant.ai_settings.update'
      ORDER BY created_at DESC
      LIMIT 1
    `;

    expect(rows).toHaveLength(1);
    const log = rows[0]!;
    const metadata = JSON.parse(log.metadata) as {
      actorRole?: string;
      changes?: Record<string, { before: boolean; after: boolean }>;
    };
    expect(log.tenant_id).toBe(TENANT_A);
    expect(log.user_id).toBe(ADMIN_A_ID);
    expect(log.resource).toBe(`tenants/${TENANT_A}`);
    expect(metadata.actorRole).toBe('TENANT_ADMIN');
    expect(metadata.changes).toMatchObject({
      aiClassificationEnabled: { before: true, after: false },
      aiTitleSuggestionEnabled: { before: true, after: false },
    });
    // Apenas os campos informados no PATCH entram no diff.
    expect(metadata.changes).not.toHaveProperty('aiIndexSuggestionEnabled');
  });

  it('PATCH sem payload não registra AuditLog (nada mudou)', async () => {
    await app.inject({
      method: 'PATCH', url: '/tenant/ai-settings',
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: {},
    });

    const rows = await testDb.db`
      SELECT id FROM audit_logs WHERE action = 'tenant.ai_settings.update'
    `;
    expect(rows).toHaveLength(0);
  });

  it('ISOLAMENTO: TENANT_ADMIN da empresa A não altera nem enxerga as flags da empresa B', async () => {
    // Admin B desliga uma flag na própria empresa.
    const resB = await app.inject({
      method: 'PATCH', url: '/tenant/ai-settings',
      headers: { authorization: `Bearer ${tokenAdminB}` },
      payload: { aiIndexSuggestionEnabled: false },
    });
    expect(resB.statusCode).toBe(200);
    expect(resB.json()).toMatchObject({ tenantId: TENANT_B, aiIndexSuggestionEnabled: false });

    // Admin A altera a própria empresa — não tem como enviar tenantId, a rota
    // sempre resolve pelo token, então isso nunca afeta a empresa B.
    const resA = await app.inject({
      method: 'PATCH', url: '/tenant/ai-settings',
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { aiIndexSuggestionEnabled: false },
    });
    expect(resA.statusCode).toBe(200);
    expect(resA.json()).toMatchObject({ tenantId: TENANT_A });

    // Empresa B continua com o valor que o próprio admin B configurou, e o
    // GET de A nunca vaza dados de B: cada request só enxerga o próprio tenant.
    const getB = await app.inject({
      method: 'GET', url: '/tenant/ai-settings',
      headers: { authorization: `Bearer ${tokenAdminB}` },
    });
    expect(getB.statusCode).toBe(200);
    expect(getB.json()).toMatchObject({ tenantId: TENANT_B, aiIndexSuggestionEnabled: false });

    const getA = await app.inject({
      method: 'GET', url: '/tenant/ai-settings',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(getA.statusCode).toBe(200);
    expect(getA.json()).toMatchObject({ tenantId: TENANT_A, aiIndexSuggestionEnabled: false });

    // Confirma diretamente no banco que as empresas permanecem independentes.
    const rowA = await testDb.db<Array<{ ai_index_suggestion_enabled: boolean }>>`
      SELECT ai_index_suggestion_enabled FROM tenants WHERE id = ${TENANT_A}
    `;
    const rowB = await testDb.db<Array<{ ai_index_suggestion_enabled: boolean }>>`
      SELECT ai_index_suggestion_enabled FROM tenants WHERE id = ${TENANT_B}
    `;
    expect(rowA[0]?.ai_index_suggestion_enabled).toBe(false);
    expect(rowB[0]?.ai_index_suggestion_enabled).toBe(false);
  });

  it('SUPER_ADMIN sem tenant no token recebe 409 ao tentar PATCH (rota não aceita tenantId)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/tenant/ai-settings',
      headers: { authorization: `Bearer ${tokenSuperAdmin}` },
      payload: { aiClassificationEnabled: false },
    });
    // resolveTenantContext({ write: true }) para SUPER_ADMIN sem tenantId
    // explícito lança ConflictError (409) antes mesmo de chegar à checagem de
    // mode !== 'single' da rota — mesmo comportamento de PATCH/POST em /usage
    // e demais rotas de escrita que usam resolveTenantContext.
    expect(res.statusCode).toBe(409);
  });
});
