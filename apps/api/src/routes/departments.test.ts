import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, resetDomainTables, type TestDb } from '../test/helpers.js';
import { newId } from '@dmdoc/db-pg';

/**
 * Testes E2E de exclusão de departamento.
 *
 * Regra de negócio (atual): ao excluir um departamento, apenas o próprio
 * departamento vira `deleted: true`. Documentos e permissões vinculados são
 * PRESERVADOS (continuam `deleted: false`) — assim os documentos já carregados
 * não somem e continuam encontráveis na busca e nas listagens por quem tem
 * `canRead`. A exclusão é bloqueada (409) se houver sub-departamentos ativos.
 */

// UUIDs de tenant por arquivo — evita colisão no `dmdoc_test` compartilhado.
const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();
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
  await resetDomainTables(testDb.db);

  await testDb.db`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
    VALUES (${TENANT_A}, 'Empresa A', ${10 * 1024 ** 3}, 20, true, NOW())
    ON CONFLICT (id) DO NOTHING
  `;

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

    await testDb.db`
      INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
      VALUES (${deptId}, ${TENANT_A}, NULL, 'Financeiro', 0, '{}'::text[], false, NOW())
    `;

    await testDb.db`
      INSERT INTO documents (
        id, tenant_id, department_id, document_type_id,
        filename, original_filename, content_hash, size_bytes, mime_type,
        s3_key, status, tags, index_values, uploaded_by_id, uploaded_at, deleted
      ) VALUES (
        ${docId}, ${TENANT_A}, ${deptId}, NULL,
        'nota-fiscal.pdf', 'nota-fiscal.pdf', ${newId()}, 1024, 'application/pdf',
        ${`tenants/${TENANT_A}/${docId}.pdf`}, 'READY', '{}'::text[], '{}'::jsonb,
        ${ADMIN_A_ID}, NOW(), false
      )
    `;

    // O usuário da permissão precisa existir (FK department_permissions.user_id).
    await seedUser(testDb.db, {
      id: permUserId,
      tenantId: TENANT_A,
      email: 'perm-user@empresa.com',
      password: PASSWORD,
      role: 'USER',
    });
    await testDb.db`
      INSERT INTO department_permissions (user_id, department_id, tenant_id, can_read, can_write)
      VALUES (${permUserId}, ${deptId}, ${TENANT_A}, true, false)
      ON CONFLICT (user_id, department_id) DO NOTHING
    `;

    const res = await app.inject({
      method: 'DELETE',
      url: `/departments/${deptId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(204);

    // (a) o departamento está logicamente excluído
    const deptRows = await testDb.db<Array<{ deleted: boolean }>>`SELECT deleted FROM departments WHERE id = ${deptId}`;
    expect(deptRows[0]?.deleted).toBe(true);

    // (b) o documento foi PRESERVADO — continua deleted:false e com o department_id
    const docRows = await testDb.db<Array<{ deleted: boolean; department_id: string }>>`
      SELECT deleted, department_id FROM documents WHERE id = ${docId}
    `;
    expect(docRows[0]?.deleted).toBe(false);
    expect(docRows[0]?.department_id).toBe(deptId);

    // (c) a permissão foi PRESERVADA — continua presente
    const permRows = await testDb.db<Array<{ can_read: boolean }>>`
      SELECT can_read FROM department_permissions WHERE department_id = ${deptId} AND user_id = ${permUserId}
    `;
    expect(permRows).toHaveLength(1);
    expect(permRows[0]?.can_read).toBe(true);
  });

  it('bloqueia exclusão (409) quando há sub-departamentos ativos', async () => {
    const parentId = newId();
    const childId = newId();

    await testDb.db`
      INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
      VALUES
        (${parentId}, ${TENANT_A}, NULL, 'Jurídico', 0, '{}'::text[], false, NOW()),
        (${childId}, ${TENANT_A}, ${parentId}, 'Contratos', 1, '{}'::text[], false, NOW())
    `;

    const res = await app.inject({
      method: 'DELETE',
      url: `/departments/${parentId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');

    // O pai NÃO foi excluído
    const rows = await testDb.db<Array<{ deleted: boolean }>>`SELECT deleted FROM departments WHERE id = ${parentId}`;
    expect(rows[0]?.deleted).toBe(false);
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

    await testDb.db`
      INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
      VALUES
        (${deptComDocs}, ${TENANT_A}, NULL, 'Financeiro', 0, '{}'::text[], false, NOW()),
        (${deptVazio}, ${TENANT_A}, NULL, 'RH', 0, '{}'::text[], false, NOW())
    `;

    // 2 documentos ativos + 1 deletado
    await testDb.db`
      INSERT INTO documents (id, tenant_id, department_id, document_type_id, filename, original_filename, content_hash, size_bytes, mime_type, s3_key, status, tags, index_values, uploaded_by_id, uploaded_at, deleted)
      VALUES
        (${newId()}, ${TENANT_A}, ${deptComDocs}, NULL, 'f1.pdf', 'f1.pdf', ${newId()}, 100, 'application/pdf', 'k1', 'READY', '{}'::text[], '{}'::jsonb, ${ADMIN_A_ID}, NOW(), false),
        (${newId()}, ${TENANT_A}, ${deptComDocs}, NULL, 'f2.pdf', 'f2.pdf', ${newId()}, 100, 'application/pdf', 'k2', 'READY', '{}'::text[], '{}'::jsonb, ${ADMIN_A_ID}, NOW(), false),
        (${newId()}, ${TENANT_A}, ${deptComDocs}, NULL, 'f3.pdf', 'f3.pdf', ${newId()}, 100, 'application/pdf', 'k3', 'READY', '{}'::text[], '{}'::jsonb, ${ADMIN_A_ID}, NOW(), true)
    `;

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
    await testDb.db`
      INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
      VALUES (${TENANT_B}, 'Empresa B', ${10 * 1024 ** 3}, 20, true, NOW())
      ON CONFLICT (id) DO NOTHING
    `;

    await testDb.db`
      INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
      VALUES
        (${FINANCEIRO}, ${TENANT_A}, NULL, 'Financeiro', 0, '{}'::text[], false, NOW()),
        (${CONTAS_A_PAGAR}, ${TENANT_A}, ${FINANCEIRO}, 'Contas a Pagar', 1, '{}'::text[], false, NOW()),
        (${RH}, ${TENANT_A}, NULL, 'RH', 0, '{}'::text[], false, NOW()),
        (${DEPT_TENANT_B}, ${TENANT_B}, NULL, 'Financeiro B', 0, '{}'::text[], false, NOW())
      ON CONFLICT (id) DO NOTHING
    `;

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
    await testDb.db`
      INSERT INTO department_permissions (user_id, department_id, tenant_id, can_read, can_write)
      VALUES (${userId}, ${departmentId}, ${TENANT_A}, true, true)
      ON CONFLICT (user_id, department_id) DO UPDATE
        SET can_read = true, can_write = true
    `;
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
    await testDb.db`UPDATE departments SET deleted = true WHERE id = ${CONTAS_A_PAGAR}`;
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
