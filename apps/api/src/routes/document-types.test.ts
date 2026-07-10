import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, type TestDb } from '../test/helpers.js';
import type { S3Service } from '../services/s3.js';

function createMockS3(): S3Service {
  return {
    uploadFile: vi.fn().mockResolvedValue(undefined),
    getSignedDownloadUrl: vi.fn().mockResolvedValue('https://mock-signed-url'),
    deleteFile: vi.fn().mockResolvedValue(undefined),
  } as unknown as S3Service;
}

// ---------------------------------------------------------------------------
// Testes de `document-types.ts` — cobrem especificamente a correção do bug
// em que os campos de índice (`indexFields`) eram lidos/escritos apenas no
// JSONB legado `document_types.index_fields`, nunca na tabela normalizada
// `document_type_index_fields` (fonte de verdade real, usada por
// `validateIndexValues` e `suggestDocumentIndexes`).
//
// Cobertura: criar tipo → adicionar campo → campo aparece na tabela
// normalizada E na resposta HTTP; editar campo; soft-delete de campo;
// isolamento multi-tenant (404, nunca 403).
// ---------------------------------------------------------------------------

const TENANT_A = '33333333-3333-3333-3333-333333333333';
const TENANT_B = '44444444-4444-4444-4444-444444444444';
const ADMIN_A_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const ADMIN_B_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const PASSWORD = 'senha-forte-de-teste-123';

const DISK_QUOTA = 10 * 1024 * 1024;

let app: FastifyInstance;
let testDb: TestDb;
let tokenAdminA: string;
let tokenAdminB: string;
let deptAId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = await buildApp({
    config: testConfig(),
    db: testDb.db,
    queue: null,
    s3: createMockS3(),
  });
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(async () => {
  await testDb.db`DELETE FROM document_events`;
  await testDb.db`DELETE FROM audit_logs`;
  await testDb.db`DELETE FROM chunks`;
  await testDb.db`DELETE FROM document_content`;
  await testDb.db`DELETE FROM documents`;
  await testDb.db`DELETE FROM document_type_index_fields`;
  await testDb.db`DELETE FROM global_type_tenant_depts`;
  await testDb.db`DELETE FROM document_types`;
  await testDb.db`DELETE FROM department_permissions`;
  await testDb.db`DELETE FROM departments`;
  await testDb.db`DELETE FROM users WHERE tenant_id IS NOT NULL OR role IN ('TENANT_ADMIN','UPLOADER','USER','MULTI_TENANT_ADMIN','SUPER_ADMIN')`;
  await testDb.db`DELETE FROM tenants WHERE id IN (${TENANT_A}, ${TENANT_B})`;

  await testDb.db`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
    VALUES
      (${TENANT_A}, 'Empresa A (index fields)', ${DISK_QUOTA}, 20, true, NOW()),
      (${TENANT_B}, 'Empresa B (index fields)', ${DISK_QUOTA}, 20, true, NOW())
    ON CONFLICT (id) DO NOTHING
  `;

  const deptRows = await testDb.db<Array<{ id: string }>>`
    INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
    VALUES (gen_random_uuid(), ${TENANT_A}, NULL, 'Financeiro A', 0, '{}'::text[], false, NOW())
    RETURNING id
  `;
  deptAId = deptRows[0]!.id;

  await seedUser(testDb.db, {
    id: ADMIN_A_ID,
    tenantId: TENANT_A,
    email: 'admin-a@indexfields.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
  });
  await seedUser(testDb.db, {
    id: ADMIN_B_ID,
    tenantId: TENANT_B,
    email: 'admin-b@indexfields.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
  });

  tokenAdminA = await login('admin-a@indexfields.com');
  tokenAdminB = await login('admin-b@indexfields.com');
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

async function createDocType(token: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/document-types',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: `Tipo de Teste ${Math.random()}`,
      description: 'tipo criado para teste de campos de índice',
      isGlobal: false,
      departmentIds: [deptAId],
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

describe('POST /document-types/:id/index-fields — grava na tabela normalizada', () => {
  it('campo criado aparece em document_type_index_fields E na resposta HTTP', async () => {
    const typeId = await createDocType(tokenAdminA);

    const res = await app.inject({
      method: 'POST',
      url: `/document-types/${typeId}/index-fields`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: {
        name: 'Número do Processo',
        fieldType: 'TEXT',
        required: true,
        aiExtractionHint: 'número do processo judicial',
        order: 0,
        showOnSearch: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { indexFields: Array<Record<string, unknown>> };
    expect(body.indexFields).toHaveLength(1);
    expect(body.indexFields[0]).toMatchObject({
      name: 'Número do Processo',
      fieldType: 'TEXT',
      required: true,
      showOnSearch: true,
    });
    const fieldId = body.indexFields[0]!['id'] as string;

    // Confirma diretamente na tabela normalizada — a fonte de verdade real.
    const rows = await testDb.db<
      Array<{ id: string; document_type_id: string; name: string; field_type: string; required: boolean }>
    >`
      SELECT id, document_type_id, name, field_type, required
      FROM document_type_index_fields
      WHERE document_type_id = ${typeId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: fieldId,
      document_type_id: typeId,
      name: 'Número do Processo',
      field_type: 'TEXT',
      required: true,
    });

    // O JSONB legado NÃO é mais escrito por esta rota.
    const legacyRows = await testDb.db<Array<{ index_fields: unknown[] }>>`
      SELECT index_fields FROM document_types WHERE id = ${typeId}
    `;
    expect(legacyRows[0]!.index_fields).toEqual([]);
  });

  it('campo também aparece em GET /document-types (batch fetch)', async () => {
    const typeId = await createDocType(tokenAdminA);

    await app.inject({
      method: 'POST',
      url: `/document-types/${typeId}/index-fields`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { name: 'Campo A', fieldType: 'TEXT', required: false, order: 0 },
    });
    await app.inject({
      method: 'POST',
      url: `/document-types/${typeId}/index-fields`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { name: 'Campo B', fieldType: 'NUMBER', required: false, order: 1 },
    });

    const listRes = await app.inject({
      method: 'GET',
      url: '/document-types',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json() as Array<{ id: string; indexFields: Array<{ name: string }> }>;
    const found = list.find((t) => t.id === typeId);
    expect(found).toBeDefined();
    expect(found!.indexFields.map((f) => f.name)).toEqual(['Campo A', 'Campo B']);
  });

  it('rejeita nome duplicado no mesmo tipo com 409 (unique constraint da tabela normalizada)', async () => {
    const typeId = await createDocType(tokenAdminA);

    await app.inject({
      method: 'POST',
      url: `/document-types/${typeId}/index-fields`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { name: 'Campo Duplicado', fieldType: 'TEXT', required: false, order: 0 },
    });

    const dup = await app.inject({
      method: 'POST',
      url: `/document-types/${typeId}/index-fields`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { name: 'Campo Duplicado', fieldType: 'TEXT', required: false, order: 1 },
    });

    expect(dup.statusCode).toBe(409);
  });

  it('tenant B não consegue adicionar campo a tipo do tenant A — 404, nunca 403', async () => {
    const typeId = await createDocType(tokenAdminA);

    const res = await app.inject({
      method: 'POST',
      url: `/document-types/${typeId}/index-fields`,
      headers: { authorization: `Bearer ${tokenAdminB}` },
      payload: { name: 'Campo Invasor', fieldType: 'TEXT', required: false, order: 0 },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /document-types/:id/index-fields/:fieldId — atualiza a linha normalizada', () => {
  it('atualiza nome e obrigatoriedade do campo', async () => {
    const typeId = await createDocType(tokenAdminA);
    const createRes = await app.inject({
      method: 'POST',
      url: `/document-types/${typeId}/index-fields`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { name: 'Campo Original', fieldType: 'TEXT', required: false, order: 0 },
    });
    const fieldId = (createRes.json() as { indexFields: Array<{ id: string }> }).indexFields[0]!.id;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/document-types/${typeId}/index-fields/${fieldId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { name: 'Campo Editado', required: true },
    });

    expect(patchRes.statusCode).toBe(200);
    const body = patchRes.json() as { indexFields: Array<Record<string, unknown>> };
    expect(body.indexFields[0]).toMatchObject({ name: 'Campo Editado', required: true });

    const rows = await testDb.db<Array<{ name: string; required: boolean }>>`
      SELECT name, required FROM document_type_index_fields WHERE id = ${fieldId}
    `;
    expect(rows[0]).toMatchObject({ name: 'Campo Editado', required: true });
  });

  it('404 ao editar campo inexistente', async () => {
    const typeId = await createDocType(tokenAdminA);

    const res = await app.inject({
      method: 'PATCH',
      url: `/document-types/${typeId}/index-fields/00000000-0000-0000-0000-000000000000`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { name: 'Não existe' },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /document-types/:id/index-fields/:fieldId — soft-delete da linha normalizada', () => {
  it('marca deleted=true na tabela normalizada e mantém a entrada na resposta HTTP', async () => {
    const typeId = await createDocType(tokenAdminA);
    const createRes = await app.inject({
      method: 'POST',
      url: `/document-types/${typeId}/index-fields`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { name: 'Campo a Remover', fieldType: 'TEXT', required: false, order: 0 },
    });
    const fieldId = (createRes.json() as { indexFields: Array<{ id: string }> }).indexFields[0]!.id;

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/document-types/${typeId}/index-fields/${fieldId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(delRes.statusCode).toBe(200);
    const body = delRes.json() as { indexFields: Array<Record<string, unknown>> };
    // Entrada continua na resposta com deleted: true — o frontend filtra, não o backend.
    expect(body.indexFields).toHaveLength(1);
    expect(body.indexFields[0]).toMatchObject({ id: fieldId, deleted: true });

    const rows = await testDb.db<Array<{ deleted: boolean }>>`
      SELECT deleted FROM document_type_index_fields WHERE id = ${fieldId}
    `;
    expect(rows[0]!.deleted).toBe(true);
  });
});

describe('PATCH /documents/:id — validação de indexValues contra a tabela normalizada', () => {
  it('rejeita valor inválido e aceita valor válido para campo do tipo recém-criado', async () => {
    const typeId = await createDocType(tokenAdminA);
    await app.inject({
      method: 'POST',
      url: `/document-types/${typeId}/index-fields`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { name: 'Data de Vencimento', fieldType: 'DATE', required: true, order: 0 },
    });

    const FormDataCtor = (await import('form-data')).default;
    const form = new FormDataCtor();
    form.append('file', Buffer.from('conteudo-de-teste'), { filename: 'teste.pdf', contentType: 'application/pdf' });
    form.append('departmentId', deptAId);
    form.append('documentTypeId', typeId);

    const uploadRes = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...(form.getHeaders() as Record<string, string>) },
      payload: form.getBuffer(),
    });
    expect(uploadRes.statusCode).toBe(201);
    const docId = (uploadRes.json() as { id: string }).id;

    const invalidRes = await app.inject({
      method: 'PATCH',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { indexValues: { 'Data de Vencimento': 'não é uma data' } },
    });
    expect(invalidRes.statusCode).toBe(422);

    const validRes = await app.inject({
      method: 'PATCH',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { indexValues: { 'Data de Vencimento': '2026-12-31' } },
    });
    expect(validRes.statusCode).toBe(200);
    expect((validRes.json() as { indexValues: Record<string, unknown> }).indexValues).toMatchObject({
      'Data de Vencimento': '2026-12-31',
    });
  });
});
