import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { startTestDb, seedUser, testConfig, type TestDb } from '../../test/helpers.js';

/**
 * Testes E2E de GET/PATCH /admin/platform-settings — Fase 6.9, entregável 68.
 *
 * `platform_settings` é um registro SINGLETON semeado pela migration
 * 0004_ai_feature_flags.sql — estes testes nunca fazem INSERT, só leem e
 * atualizam a linha existente. Como o banco de teste é compartilhado entre
 * arquivos de teste, todo teste que altera uma flag restaura o default
 * (`true`) em `afterEach` para não vazar estado para outros arquivos.
 */

const SUPER_ADMIN_ID = 'd0000000-0000-0000-0000-00000000a001';
const TENANT_ADMIN_ID = 'd0000000-0000-0000-0000-00000000a002';
const TENANT_ID = 'd0000000-0000-0000-0000-00000000a003';
const PASSWORD = 'super-senha-segura-99';

let app: FastifyInstance;
let testDb: TestDb;
let superAdminToken: string;
let tenantAdminToken: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = await buildApp({ config: testConfig(), db: testDb.db });

  await testDb.db`DELETE FROM audit_logs WHERE user_id IN (${SUPER_ADMIN_ID}, ${TENANT_ADMIN_ID})`;
  await testDb.db`DELETE FROM users WHERE id IN (${SUPER_ADMIN_ID}, ${TENANT_ADMIN_ID})`;
  await testDb.db`DELETE FROM tenants WHERE id = ${TENANT_ID}`;

  await testDb.db`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
    VALUES (${TENANT_ID}, 'Empresa Platform Settings Test', ${10 * 1024 ** 3}, 20, true, NOW())
    ON CONFLICT (id) DO NOTHING
  `;

  await seedUser(testDb.db, {
    id: SUPER_ADMIN_ID,
    tenantId: null,
    email: 'superadmin-platform-settings@plataforma.com',
    password: PASSWORD,
    role: 'SUPER_ADMIN',
  });
  await seedUser(testDb.db, {
    id: TENANT_ADMIN_ID,
    tenantId: TENANT_ID,
    email: 'tenantadmin-platform-settings@plataforma.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
  });

  const superRes = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'superadmin-platform-settings@plataforma.com', password: PASSWORD },
  });
  expect(superRes.statusCode).toBe(200);
  superAdminToken = superRes.json().accessToken as string;

  const tenantRes = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'tenantadmin-platform-settings@plataforma.com', password: PASSWORD },
  });
  expect(tenantRes.statusCode).toBe(200);
  tenantAdminToken = tenantRes.json().accessToken as string;
});

afterAll(async () => {
  await testDb.db`
    UPDATE platform_settings
    SET ai_classification_enabled = true, ai_title_suggestion_enabled = true, ai_index_suggestion_enabled = true
  `;
  await testDb.db`DELETE FROM audit_logs WHERE user_id IN (${SUPER_ADMIN_ID}, ${TENANT_ADMIN_ID})`;
  await testDb.db`DELETE FROM users WHERE id IN (${SUPER_ADMIN_ID}, ${TENANT_ADMIN_ID})`;
  await testDb.db`DELETE FROM tenants WHERE id = ${TENANT_ID}`;
  await app.close();
  await testDb.stop();
});

afterEach(async () => {
  // Restaura o singleton para os defaults — evita vazar estado entre testes.
  await testDb.db`
    UPDATE platform_settings
    SET ai_classification_enabled = true, ai_title_suggestion_enabled = true, ai_index_suggestion_enabled = true
  `;
  // Limpa os audit logs gerados pelo teste — os testes de auditoria sempre
  // consultam a linha mais recente por essa action, mas limpar evita acúmulo
  // entre execuções e mantém os testes independentes de ordem.
  await testDb.db`DELETE FROM audit_logs WHERE action = 'platform_settings.update'`;
});

describe('GET /admin/platform-settings', () => {
  it('retorna 401 sem token', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/platform-settings' });
    expect(res.statusCode).toBe(401);
  });

  it('retorna 403 para TENANT_ADMIN', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/platform-settings',
      headers: { authorization: `Bearer ${tenantAdminToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('retorna o singleton com as 3 flags habilitadas por default', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/platform-settings',
      headers: { authorization: `Bearer ${superAdminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      aiClassificationEnabled: true,
      aiTitleSuggestionEnabled: true,
      aiIndexSuggestionEnabled: true,
    });
    expect(typeof body['id']).toBe('string');
  });
});

describe('PATCH /admin/platform-settings', () => {
  it('retorna 403 para TENANT_ADMIN', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/admin/platform-settings',
      headers: { authorization: `Bearer ${tenantAdminToken}` },
      payload: { aiClassificationEnabled: false },
    });
    expect(res.statusCode).toBe(403);
  });

  it('atualiza apenas o campo informado, preservando os demais', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/admin/platform-settings',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { aiClassificationEnabled: false },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      aiClassificationEnabled: false,
      aiTitleSuggestionEnabled: true,
      aiIndexSuggestionEnabled: true,
    });

    // Confirma persistência direta no banco.
    const rows = await testDb.db<
      Array<{
        ai_classification_enabled: boolean;
        ai_title_suggestion_enabled: boolean;
        ai_index_suggestion_enabled: boolean;
      }>
    >`SELECT ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled FROM platform_settings`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ai_classification_enabled: false,
      ai_title_suggestion_enabled: true,
      ai_index_suggestion_enabled: true,
    });
  });

  it('aceita subconjunto com múltiplas flags de uma vez', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/admin/platform-settings',
      headers: { authorization: `Bearer ${superAdminToken}` },
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

  it('sem payload retorna o estado atual sem alterar nada', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/admin/platform-settings',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      aiClassificationEnabled: true,
      aiTitleSuggestionEnabled: true,
      aiIndexSuggestionEnabled: true,
    });
  });

  it('nunca cria uma segunda linha — sempre atualiza o singleton existente', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/admin/platform-settings',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { aiClassificationEnabled: false },
    });
    await app.inject({
      method: 'PATCH',
      url: '/admin/platform-settings',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: { aiClassificationEnabled: true },
    });

    const rows = await testDb.db`SELECT id FROM platform_settings`;
    expect(rows).toHaveLength(1);
  });

  it('registra um AuditLog com ator, flags alteradas e valores antes/depois', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/admin/platform-settings',
      headers: { authorization: `Bearer ${superAdminToken}` },
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
      WHERE action = 'platform_settings.update'
      ORDER BY created_at DESC
      LIMIT 1
    `;

    expect(rows).toHaveLength(1);
    const log = rows[0]!;
    const metadata = JSON.parse(log.metadata) as {
      actorRole?: string;
      changes?: Record<string, { before: boolean; after: boolean }>;
    };
    expect(log.tenant_id).toBeNull();
    expect(log.user_id).toBe(SUPER_ADMIN_ID);
    expect(log.resource).toBe('platform_settings');
    expect(metadata.actorRole).toBe('SUPER_ADMIN');
    expect(metadata.changes).toMatchObject({
      aiClassificationEnabled: { before: true, after: false },
      aiTitleSuggestionEnabled: { before: true, after: false },
    });
    // Apenas os campos informados no PATCH entram no diff.
    expect(metadata.changes).not.toHaveProperty('aiIndexSuggestionEnabled');
  });

  it('PATCH sem payload não registra AuditLog (nada mudou)', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/admin/platform-settings',
      headers: { authorization: `Bearer ${superAdminToken}` },
      payload: {},
    });

    const rows = await testDb.db`
      SELECT id FROM audit_logs WHERE action = 'platform_settings.update'
    `;
    expect(rows).toHaveLength(0);
  });
});
