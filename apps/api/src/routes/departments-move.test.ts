import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, resetDomainTables, type TestDb } from '../test/helpers.js';
import { newId } from '@dmdoc/db-pg';

/**
 * Testes E2E de `PATCH /departments/:id/move` (reparent de departamento).
 *
 * Os testes cobram o CONTRATO publicado na spec §7 — não a implementação:
 *   - o `level` do nó e de TODA a subárvore é recalculado (para baixo e para
 *     cima, inclusive sob nós soft-deletados);
 *   - ciclo direto/indireto → 409, sem escrita;
 *   - `parentId === :id`, `parentId: null` e `:id` não-uuid → 422;
 *   - nó/destino inexistente, soft-deletado ou de outro tenant → 404 (nunca 403);
 *   - nó com concessão ATIVA → 409 com a contagem na mensagem; concessão
 *     soft-deletada não bloqueia;
 *   - destino já é o pai atual → 200 idempotente (sem escrita, sem audit);
 *   - move efetivo → audit `department.move` com `fromParentId`/`toParentId`;
 *   - papéis: USER/UPLOADER 403, TENANT_ADMIN 200, SUPER_ADMIN sem `?tenantId`
 *     409 e com `?tenantId` 200, MTA fora das empresas permitidas 404;
 *   - o move NÃO escreve em `department_permissions` nem em
 *     `documents.department_id` / `chunks.department_id`: a mudança de
 *     visibilidade vem da herança DINÂMICA da ACL a partir da raiz concedida.
 *
 * Fixture base (recriada a cada teste):
 *   TENANT_A:  A (raiz, 0) → A1 (1) → A11 (2)      e   B (raiz, 0) → B1 (1)
 *   TENANT_B:  XB (raiz, 0) → XB1 (1)              — isolado, nunca alcançável
 */

// UUIDs de tenant por arquivo — evita colisão no `dmdoc_test` compartilhado.
const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();

const ADMIN_A_ID = 'aaaaaaa1-0000-4000-8000-000000000001';
const USER_A_ID = 'aaaaaaa1-0000-4000-8000-000000000002';
const USER2_A_ID = 'aaaaaaa1-0000-4000-8000-000000000003';
const UPLOADER_A_ID = 'aaaaaaa1-0000-4000-8000-000000000004';
const SUPER_ID = 'aaaaaaa1-0000-4000-8000-000000000005';
const MTA_ID = 'aaaaaaa1-0000-4000-8000-000000000006';

// Árvore do TENANT_A
const DEPT_A = '11111111-1111-4111-8111-111111111111';
const DEPT_A1 = '11111111-1111-4111-8111-111111111112';
const DEPT_A11 = '11111111-1111-4111-8111-111111111113';
const DEPT_A111 = '11111111-1111-4111-8111-111111111114';
const DEPT_B = '22222222-2222-4222-8222-222222222221';
const DEPT_B1 = '22222222-2222-4222-8222-222222222222';
// Árvore do TENANT_B (outro tenant)
const DEPT_XB = '33333333-3333-4333-8333-333333333331';
const DEPT_XB1 = '33333333-3333-4333-8333-333333333332';

const PASSWORD = 'senha-muito-secreta-123';

/** Vetor de 1536 dimensões — `chunks.embedding` é NOT NULL. */
const ZERO_EMBEDDING = `[${new Array(1536).fill(0).join(',')}]`;

let app: FastifyInstance;
let testDb: TestDb;
let adminToken: string;

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
    VALUES
      (${TENANT_A}, 'Empresa A', ${10 * 1024 ** 3}, 20, true, NOW()),
      (${TENANT_B}, 'Empresa B', ${10 * 1024 ** 3}, 20, true, NOW())
  `;

  await testDb.db`
    INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
    VALUES
      (${DEPT_A}, ${TENANT_A}, NULL, 'A', 0, '{}'::text[], false, NOW()),
      (${DEPT_A1}, ${TENANT_A}, ${DEPT_A}, 'A1', 1, '{}'::text[], false, NOW()),
      (${DEPT_A11}, ${TENANT_A}, ${DEPT_A1}, 'A11', 2, '{}'::text[], false, NOW()),
      (${DEPT_B}, ${TENANT_A}, NULL, 'B', 0, '{}'::text[], false, NOW()),
      (${DEPT_B1}, ${TENANT_A}, ${DEPT_B}, 'B1', 1, '{}'::text[], false, NOW()),
      (${DEPT_XB}, ${TENANT_B}, NULL, 'XB', 0, '{}'::text[], false, NOW()),
      (${DEPT_XB1}, ${TENANT_B}, ${DEPT_XB}, 'XB1', 1, '{}'::text[], false, NOW())
  `;

  await seedUser(testDb.db, {
    id: ADMIN_A_ID,
    tenantId: TENANT_A,
    email: 'admin-a@empresa.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
  });

  adminToken = await login('admin-a@empresa.com');
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

/** `PATCH /departments/:id/move` com o payload cru (para exercitar body inválido). */
async function move(
  id: string,
  payload: Record<string, unknown>,
  token: string,
  query = '',
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'PATCH',
    url: `/departments/${id}/move${query}`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

interface DeptState {
  parentId: string | null;
  level: number;
  deleted: boolean;
}

/** Snapshot de `parent_id`/`level`/`deleted` de todos os departamentos, por id. */
async function snapshotDepartments(): Promise<Map<string, DeptState>> {
  const rows = await testDb.db<Array<{ id: string; parent_id: string | null; level: number; deleted: boolean }>>`
    SELECT id, parent_id, level, deleted FROM departments
  `;
  return new Map(
    rows.map((r) => [r.id, { parentId: r.parent_id, level: r.level, deleted: r.deleted }]),
  );
}

async function levelOf(id: string): Promise<number> {
  const rows = await testDb.db<Array<{ level: number }>>`SELECT level FROM departments WHERE id = ${id}`;
  expect(rows).toHaveLength(1);
  return rows[0]!.level;
}

async function parentOf(id: string): Promise<string | null> {
  const rows = await testDb.db<Array<{ parent_id: string | null }>>`
    SELECT parent_id FROM departments WHERE id = ${id}
  `;
  expect(rows).toHaveLength(1);
  return rows[0]!.parent_id;
}

async function countAuditLogs(): Promise<number> {
  const rows = await testDb.db<Array<{ count: string }>>`SELECT COUNT(*)::text AS count FROM audit_logs`;
  return parseInt(rows[0]!.count, 10);
}

/**
 * Normaliza o `metadata` de `audit_logs` para objeto.
 *
 * `AuditLogger.record` grava a coluna jsonb com `JSON.stringify`
 * (apps/api/src/auth/audit.ts:44-55), então o valor armazenado é uma STRING
 * JSON dentro do jsonb (double-encoded) e o driver devolve essa string, não um
 * objeto — é o que `parseMetadata` de `routes/audit-logs.ts:52` compensa.
 * O teste cobra o CONTEÚDO do metadata, não o encoding: descasca enquanto for
 * string, para continuar válido se um dia a gravação passar a usar `sql.json()`.
 */
function parseAuditMetadata(value: unknown): Record<string, unknown> {
  let current = value;
  for (let i = 0; i < 3 && typeof current === 'string'; i += 1) {
    current = JSON.parse(current) as unknown;
  }
  expect(typeof current).toBe('object');
  return current as Record<string, unknown>;
}

/** Acrescenta A111 sob A11 (4º nível), usado nos testes de subárvore profunda. */
async function addA111(): Promise<void> {
  await testDb.db`
    INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
    VALUES (${DEPT_A111}, ${TENANT_A}, ${DEPT_A11}, 'A111', 3, '{}'::text[], false, NOW())
  `;
}

async function grant(userId: string, departmentId: string, deleted = false): Promise<void> {
  await testDb.db`
    INSERT INTO department_permissions (id, user_id, department_id, tenant_id, can_read, can_write, deleted)
    VALUES (${newId()}, ${userId}, ${departmentId}, ${TENANT_A}, true, true, ${deleted})
  `;
}

async function seedDocument(id: string, departmentId: string, filename: string): Promise<void> {
  await testDb.db`
    INSERT INTO documents (
      id, tenant_id, department_id, document_type_id,
      filename, original_filename, content_hash, size_bytes, mime_type,
      s3_key, status, tags, index_values, uploaded_by_id, uploaded_at, deleted
    ) VALUES (
      ${id}, ${TENANT_A}, ${departmentId}, NULL,
      ${filename}, ${filename}, ${newId()}, 1024, 'application/pdf',
      ${`tenants/${TENANT_A}/${id}.pdf`}, 'READY', '{}'::text[], '{}'::jsonb,
      ${ADMIN_A_ID}, NOW(), false
    )
  `;
}

async function seedChunk(documentId: string, departmentId: string): Promise<void> {
  await testDb.db`
    INSERT INTO chunks (id, document_id, tenant_id, department_id, chunk_index, text, embedding, token_count)
    VALUES (${newId()}, ${documentId}, ${TENANT_A}, ${departmentId}, 0, 'trecho de teste', ${ZERO_EMBEDDING}::vector, 3)
  `;
}

// ===========================================================================
// 1. Recálculo de level
// ===========================================================================

describe('PATCH /departments/:id/move — recálculo de level', () => {
  it('reparent simples: grava parent_id e recalcula o level do nó e do neto', async () => {
    // A1 (1) → filho de B (0): A1 continua em 1, A11 continua em 2, mas o pai muda.
    // Move para B1 (1) para que os levels efetivamente mudem: A1=2, A11=3.
    const res = await move(DEPT_A1, { parentId: DEPT_B1 }, adminToken);

    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; parentId: string; level: number };
    expect(body.id).toBe(DEPT_A1);
    expect(body.parentId).toBe(DEPT_B1);
    expect(body.level).toBe(2);

    expect(await parentOf(DEPT_A1)).toBe(DEPT_B1);
    expect(await levelOf(DEPT_A1)).toBe(2);
    expect(await levelOf(DEPT_A11)).toBe(3);

    // Nada mais na árvore se mexeu.
    expect(await parentOf(DEPT_A11)).toBe(DEPT_A1);
    expect(await levelOf(DEPT_A)).toBe(0);
    expect(await levelOf(DEPT_B)).toBe(0);
    expect(await levelOf(DEPT_B1)).toBe(1);
  });

  it('subárvore de 4 níveis: mover A1 para B1 produz levels 2, 3 e 4', async () => {
    await addA111();

    const res = await move(DEPT_A1, { parentId: DEPT_B1 }, adminToken);

    expect(res.statusCode).toBe(200);
    expect(await levelOf(DEPT_A1)).toBe(2);
    expect(await levelOf(DEPT_A11)).toBe(3);
    expect(await levelOf(DEPT_A111)).toBe(4);
    // A cadeia de parent_id da subárvore permanece intacta — só a ponta mudou.
    expect(await parentOf(DEPT_A11)).toBe(DEPT_A1);
    expect(await parentOf(DEPT_A111)).toBe(DEPT_A11);
  });

  it('move "para cima": mover A11 para A DIMINUI o level do nó e do descendente', async () => {
    await addA111(); // A111 em level 3

    const res = await move(DEPT_A11, { parentId: DEPT_A }, adminToken);

    expect(res.statusCode).toBe(200);
    expect((res.json() as { level: number }).level).toBe(1);
    // A11 era 2 → 1; A111 era 3 → 2. Um recálculo que só soma falharia aqui.
    expect(await levelOf(DEPT_A11)).toBe(1);
    expect(await levelOf(DEPT_A111)).toBe(2);
    expect(await parentOf(DEPT_A11)).toBe(DEPT_A);
    // O antigo pai (A1) não muda de lugar.
    expect(await parentOf(DEPT_A1)).toBe(DEPT_A);
    expect(await levelOf(DEPT_A1)).toBe(1);
  });

  it('descendente sob nó soft-deletado também tem o level recalculado', async () => {
    // A1 soft-deletado, A11 ativo abaixo dele. Mover A (raiz) para B1 (level 1).
    await testDb.db`UPDATE departments SET deleted = true WHERE id = ${DEPT_A1}`;

    const res = await move(DEPT_A, { parentId: DEPT_B1 }, adminToken);

    expect(res.statusCode).toBe(200);
    expect(await levelOf(DEPT_A)).toBe(2);
    // A1 está deleted, mas a CTE de descida não filtra `deleted` — level corrigido.
    expect(await levelOf(DEPT_A1)).toBe(3);
    // E o neto, pendurado sob o nó excluído, também.
    expect(await levelOf(DEPT_A11)).toBe(4);
  });
});

// ===========================================================================
// 2. Ciclo
// ===========================================================================

describe('PATCH /departments/:id/move — ciclo', () => {
  it('ciclo direto (A → A1) devolve 409 e não escreve nada', async () => {
    const before = await snapshotDepartments();
    const auditBefore = await countAuditLogs();

    const res = await move(DEPT_A, { parentId: DEPT_A1 }, adminToken);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');

    expect(await snapshotDepartments()).toEqual(before);
    expect(await countAuditLogs()).toBe(auditBefore);
  });

  it('ciclo indireto (A → A11, neto) devolve 409 e não escreve nada', async () => {
    await addA111();
    const before = await snapshotDepartments();
    const auditBefore = await countAuditLogs();

    const res = await move(DEPT_A, { parentId: DEPT_A11 }, adminToken);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');

    expect(await snapshotDepartments()).toEqual(before);
    expect(await countAuditLogs()).toBe(auditBefore);
  });

  it('ciclo passando por ancestral soft-deletado também é recusado (409)', async () => {
    // A1 excluído logicamente continua sendo elo real da cadeia de parent_id.
    await testDb.db`UPDATE departments SET deleted = true WHERE id = ${DEPT_A1}`;
    const before = await snapshotDepartments();

    const res = await move(DEPT_A, { parentId: DEPT_A11 }, adminToken);

    expect(res.statusCode).toBe(409);
    expect(await snapshotDepartments()).toEqual(before);
  });
});

// ===========================================================================
// 3. Validação de entrada (422)
// ===========================================================================

describe('PATCH /departments/:id/move — entrada inválida', () => {
  it('parentId === :id devolve 422 VALIDATION_ERROR', async () => {
    const before = await snapshotDepartments();

    const res = await move(DEPT_A1, { parentId: DEPT_A1 }, adminToken);

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(await snapshotDepartments()).toEqual(before);
  });

  it('parentId null devolve 422 (não existe promoção a raiz)', async () => {
    const before = await snapshotDepartments();

    const res = await move(DEPT_A1, { parentId: null }, adminToken);

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(await snapshotDepartments()).toEqual(before);
  });

  it('parentId ausente devolve 422', async () => {
    const res = await move(DEPT_A1, {}, adminToken);

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('parentId não-uuid devolve 422', async () => {
    const res = await move(DEPT_A1, { parentId: 'nao-e-uuid' }, adminToken);

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it(':id não-uuid devolve 422 (nunca 500 por erro 22P02 do Postgres)', async () => {
    const res = await move('nao-e-uuid', { parentId: DEPT_B1 }, adminToken);

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

// ===========================================================================
// 4. Isolamento e existência (404, nunca 403)
// ===========================================================================

describe('PATCH /departments/:id/move — 404 (nunca 403)', () => {
  it('destino inexistente devolve 404', async () => {
    const res = await move(DEPT_A1, { parentId: newId() }, adminToken);

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('destino soft-deletado devolve 404', async () => {
    await testDb.db`UPDATE departments SET deleted = true WHERE id = ${DEPT_B1}`;
    const before = await snapshotDepartments();

    const res = await move(DEPT_A1, { parentId: DEPT_B1 }, adminToken);

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(await snapshotDepartments()).toEqual(before);
  });

  it('destino de outro tenant devolve 404 (não 403)', async () => {
    const res = await move(DEPT_A1, { parentId: DEPT_XB }, adminToken);

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(await parentOf(DEPT_A1)).toBe(DEPT_A);
  });

  it(':id de outro tenant devolve 404 (não 403) e não move o nó alheio', async () => {
    const res = await move(DEPT_XB1, { parentId: DEPT_B1 }, adminToken);

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(await parentOf(DEPT_XB1)).toBe(DEPT_XB);
  });

  it(':id inexistente devolve 404', async () => {
    const res = await move(newId(), { parentId: DEPT_B1 }, adminToken);

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it(':id soft-deletado devolve 404', async () => {
    await testDb.db`UPDATE departments SET deleted = true WHERE id = ${DEPT_A1}`;

    const res = await move(DEPT_A1, { parentId: DEPT_B1 }, adminToken);

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(await parentOf(DEPT_A1)).toBe(DEPT_A);
  });
});

// ===========================================================================
// 5. Concessões ativas bloqueiam o move
// ===========================================================================

describe('PATCH /departments/:id/move — concessões em department_permissions', () => {
  it('raiz com 2 concessões ativas devolve 409 com a contagem na mensagem, sem tocar em department_permissions', async () => {
    await seedUser(testDb.db, {
      id: USER_A_ID,
      tenantId: TENANT_A,
      email: 'user-a@empresa.com',
      password: PASSWORD,
      role: 'USER',
    });
    await seedUser(testDb.db, {
      id: USER2_A_ID,
      tenantId: TENANT_A,
      email: 'user2-a@empresa.com',
      password: PASSWORD,
      role: 'USER',
    });
    await grant(USER_A_ID, DEPT_A);
    await grant(USER2_A_ID, DEPT_A);

    const before = await snapshotDepartments();

    const res = await move(DEPT_A, { parentId: DEPT_B1 }, adminToken);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
    expect(res.json().error.message).toContain('2');

    // Árvore intacta…
    expect(await snapshotDepartments()).toEqual(before);
    // …e as concessões nem foram tocadas.
    const perms = await testDb.db<Array<{ user_id: string; deleted: boolean }>>`
      SELECT user_id, deleted FROM department_permissions WHERE department_id = ${DEPT_A} ORDER BY user_id
    `;
    expect(perms).toHaveLength(2);
    expect(perms.every((p) => p.deleted === false)).toBe(true);
  });

  it('concessão SOFT-DELETADA não bloqueia o move (200)', async () => {
    await seedUser(testDb.db, {
      id: USER_A_ID,
      tenantId: TENANT_A,
      email: 'user-a@empresa.com',
      password: PASSWORD,
      role: 'USER',
    });
    await grant(USER_A_ID, DEPT_A, true);

    const res = await move(DEPT_A, { parentId: DEPT_B1 }, adminToken);

    expect(res.statusCode).toBe(200);
    expect(await parentOf(DEPT_A)).toBe(DEPT_B1);
    expect(await levelOf(DEPT_A)).toBe(2);
    expect(await levelOf(DEPT_A1)).toBe(3);
    expect(await levelOf(DEPT_A11)).toBe(4);
  });
});

// ===========================================================================
// 6. Idempotência e auditoria
// ===========================================================================

describe('PATCH /departments/:id/move — idempotência e audit log', () => {
  it('mover para o pai atual devolve 200 sem alterar nada e sem gerar audit log', async () => {
    const before = await snapshotDepartments();
    const auditBefore = await countAuditLogs();

    const res = await move(DEPT_A11, { parentId: DEPT_A1 }, adminToken);

    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; parentId: string; level: number };
    expect(body.id).toBe(DEPT_A11);
    expect(body.parentId).toBe(DEPT_A1);
    expect(body.level).toBe(2);

    expect(await snapshotDepartments()).toEqual(before);
    expect(await countAuditLogs()).toBe(auditBefore);
  });

  it('move efetivo grava audit_logs com action department.move e from/toParentId no metadata', async () => {
    const res = await move(DEPT_A1, { parentId: DEPT_B1 }, adminToken);
    expect(res.statusCode).toBe(200);

    const logs = await testDb.db<
      Array<{
        tenant_id: string;
        user_id: string;
        action: string;
        resource: string;
        metadata: unknown;
      }>
    >`
      SELECT tenant_id, user_id, action, resource, metadata
      FROM audit_logs
      WHERE action = 'department.move'
    `;

    expect(logs).toHaveLength(1);
    const log = logs[0]!;
    expect(log.tenant_id).toBe(TENANT_A);
    expect(log.user_id).toBe(ADMIN_A_ID);
    expect(log.resource).toBe(`departments/${DEPT_A1}`);

    const metadata = parseAuditMetadata(log.metadata);
    expect(metadata['departmentId']).toBe(DEPT_A1);
    expect(metadata['fromParentId']).toBe(DEPT_A);
    expect(metadata['toParentId']).toBe(DEPT_B1);
    expect(metadata['previousLevel']).toBe(1);
    expect(metadata['newLevel']).toBe(2);
  });
});

// ===========================================================================
// 7. Papéis e escopo de tenant
// ===========================================================================

describe('PATCH /departments/:id/move — papéis', () => {
  it('USER recebe 403 e nada é movido', async () => {
    await seedUser(testDb.db, {
      id: USER_A_ID,
      tenantId: TENANT_A,
      email: 'user-a@empresa.com',
      password: PASSWORD,
      role: 'USER',
    });
    const token = await login('user-a@empresa.com');
    const before = await snapshotDepartments();

    const res = await move(DEPT_A1, { parentId: DEPT_B1 }, token);

    expect(res.statusCode).toBe(403);
    expect(await snapshotDepartments()).toEqual(before);
  });

  it('UPLOADER recebe 403 e nada é movido', async () => {
    await seedUser(testDb.db, {
      id: UPLOADER_A_ID,
      tenantId: TENANT_A,
      email: 'uploader-a@empresa.com',
      password: PASSWORD,
      role: 'UPLOADER',
    });
    const token = await login('uploader-a@empresa.com');
    const before = await snapshotDepartments();

    const res = await move(DEPT_A1, { parentId: DEPT_B1 }, token);

    expect(res.statusCode).toBe(403);
    expect(await snapshotDepartments()).toEqual(before);
  });

  it('TENANT_ADMIN move no próprio tenant (200)', async () => {
    const res = await move(DEPT_A1, { parentId: DEPT_B1 }, adminToken);

    expect(res.statusCode).toBe(200);
    expect(await parentOf(DEPT_A1)).toBe(DEPT_B1);
  });

  it('TENANT_ADMIN com ?tenantId de outra empresa opera no PRÓPRIO tenant (query ignorada)', async () => {
    const res = await move(DEPT_A1, { parentId: DEPT_B1 }, adminToken, `?tenantId=${TENANT_B}`);

    expect(res.statusCode).toBe(200);
    expect(await parentOf(DEPT_A1)).toBe(DEPT_B1);
    // A árvore do TENANT_B continua intocada.
    expect(await parentOf(DEPT_XB1)).toBe(DEPT_XB);
  });

  it('SUPER_ADMIN sem ?tenantId recebe 409', async () => {
    await seedUser(testDb.db, {
      id: SUPER_ID,
      tenantId: null,
      email: 'super@plataforma.com',
      password: PASSWORD,
      role: 'SUPER_ADMIN',
    });
    const token = await login('super@plataforma.com');
    const before = await snapshotDepartments();

    const res = await move(DEPT_A1, { parentId: DEPT_B1 }, token);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
    expect(await snapshotDepartments()).toEqual(before);
  });

  it('SUPER_ADMIN com ?tenantId move normalmente (200)', async () => {
    await seedUser(testDb.db, {
      id: SUPER_ID,
      tenantId: null,
      email: 'super@plataforma.com',
      password: PASSWORD,
      role: 'SUPER_ADMIN',
    });
    const token = await login('super@plataforma.com');

    const res = await move(DEPT_A1, { parentId: DEPT_B1 }, token, `?tenantId=${TENANT_A}`);

    expect(res.statusCode).toBe(200);
    expect(await parentOf(DEPT_A1)).toBe(DEPT_B1);
    expect(await levelOf(DEPT_A11)).toBe(3);
  });

  it('MULTI_TENANT_ADMIN com ?tenantId permitido move (200); fora da lista devolve 404', async () => {
    await seedUser(testDb.db, {
      id: MTA_ID,
      tenantId: null,
      email: 'mta@plataforma.com',
      password: PASSWORD,
      role: 'MULTI_TENANT_ADMIN',
      allowedTenantIds: [TENANT_A],
    });
    const token = await login('mta@plataforma.com');

    // Empresa fora da lista → 404 antes de qualquer consulta a departments.
    const forbidden = await move(DEPT_XB1, { parentId: DEPT_XB }, token, `?tenantId=${TENANT_B}`);
    expect(forbidden.statusCode).toBe(404);
    expect(forbidden.json().error.code).toBe('NOT_FOUND');

    // Escrita sem tenantId explícito → 404 (MTA não tem empresa padrão).
    const noTenant = await move(DEPT_A1, { parentId: DEPT_B1 }, token);
    expect(noTenant.statusCode).toBe(404);

    // Empresa permitida → move de verdade.
    const ok = await move(DEPT_A1, { parentId: DEPT_B1 }, token, `?tenantId=${TENANT_A}`);
    expect(ok.statusCode).toBe(200);
    expect(await parentOf(DEPT_A1)).toBe(DEPT_B1);
  });
});

// ===========================================================================
// 8. Efeitos colaterais: ACL herdada e vínculos de documentos
// ===========================================================================

describe('PATCH /departments/:id/move — ACL herdada e dados vinculados', () => {
  it('USER com concessão na raiz B passa a enxergar os documentos de A1 depois do move, sem materializar permissão', async () => {
    const docA1 = newId();
    const docB1 = newId();
    await seedDocument(docA1, DEPT_A1, 'doc-a1.pdf');
    await seedDocument(docB1, DEPT_B1, 'doc-b1.pdf');

    await seedUser(testDb.db, {
      id: USER_A_ID,
      tenantId: TENANT_A,
      email: 'user-a@empresa.com',
      password: PASSWORD,
      role: 'USER',
    });
    await grant(USER_A_ID, DEPT_B); // concessão na RAIZ B, nada em A
    const userToken = await login('user-a@empresa.com');

    const listDocumentIds = async (): Promise<string[]> => {
      const res = await app.inject({
        method: 'GET',
        url: '/documents',
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(res.statusCode).toBe(200);
      return (res.json() as { items: Array<{ id: string }> }).items.map((d) => d.id).sort();
    };

    // Antes: só o documento da subárvore de B.
    expect(await listDocumentIds()).toEqual([docB1]);

    const res = await move(DEPT_A1, { parentId: DEPT_B }, adminToken);
    expect(res.statusCode).toBe(200);

    // Depois: a subárvore de B passou a incluir A1 (e A11) — herança DINÂMICA.
    expect(await listDocumentIds()).toEqual([docA1, docB1].sort());

    // A visibilidade mudou SEM que a rota escrevesse em department_permissions:
    // continua existindo exatamente UMA concessão, a da raiz B.
    const perms = await testDb.db<Array<{ user_id: string; department_id: string; deleted: boolean }>>`
      SELECT user_id, department_id, deleted FROM department_permissions
    `;
    expect(perms).toEqual([{ user_id: USER_A_ID, department_id: DEPT_B, deleted: false }]);
  });

  it('documents.department_id e chunks.department_id do ramo movido permanecem idênticos', async () => {
    const docA1 = newId();
    const docA11 = newId();
    await seedDocument(docA1, DEPT_A1, 'doc-a1.pdf');
    await seedDocument(docA11, DEPT_A11, 'doc-a11.pdf');
    await seedChunk(docA1, DEPT_A1);
    await seedChunk(docA11, DEPT_A11);

    const res = await move(DEPT_A1, { parentId: DEPT_B1 }, adminToken);
    expect(res.statusCode).toBe(200);

    const docs = await testDb.db<Array<{ id: string; department_id: string }>>`
      SELECT id, department_id FROM documents
    `;
    const deptByDoc = new Map(docs.map((d) => [d.id, d.department_id]));
    expect(deptByDoc.get(docA1)).toBe(DEPT_A1);
    expect(deptByDoc.get(docA11)).toBe(DEPT_A11);

    const chunks = await testDb.db<Array<{ document_id: string; department_id: string }>>`
      SELECT document_id, department_id FROM chunks
    `;
    const deptByChunkDoc = new Map(chunks.map((c) => [c.document_id, c.department_id]));
    expect(deptByChunkDoc.size).toBe(2);
    expect(deptByChunkDoc.get(docA1)).toBe(DEPT_A1);
    expect(deptByChunkDoc.get(docA11)).toBe(DEPT_A11);
  });
});
