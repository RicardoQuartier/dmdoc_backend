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

// ---------------------------------------------------------------------------
// GET /document-types?departmentId — escopo por departamento (alinhado ao
// helper resolveDepartmentDocumentTypeCatalog). Fecha o vazamento em que
// admins recebiam tipos escopados a qualquer departamento do tenant.
// ---------------------------------------------------------------------------

describe('GET /document-types?departmentId — escopo por departamento', () => {
  interface DocTypeItem {
    id: string;
    name: string;
  }

  async function createSecondDept(): Promise<string> {
    const rows = await testDb.db<Array<{ id: string }>>`
      INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
      VALUES (gen_random_uuid(), ${TENANT_A}, NULL, 'Jurídico A', 0, '{}'::text[], false, NOW())
      RETURNING id
    `;
    return rows[0]!.id;
  }

  async function listTypes(token: string, departmentId?: string): Promise<DocTypeItem[]> {
    const qs = departmentId ? `?departmentId=${departmentId}` : '';
    const res = await app.inject({
      method: 'GET',
      url: `/document-types${qs}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as DocTypeItem[];
  }

  it('admin: tipo escopado ao dept A NÃO aparece ao consultar o dept B', async () => {
    const deptBId = await createSecondDept();
    const typeId = await createDocType(tokenAdminA); // escopado a [deptAId]

    const inA = await listTypes(tokenAdminA, deptAId);
    expect(inA.map((t) => t.id)).toContain(typeId);

    const inB = await listTypes(tokenAdminA, deptBId);
    expect(inB.map((t) => t.id)).not.toContain(typeId);
    expect(inB).toHaveLength(0);
  });

  it('admin: sem departmentId mantém o comportamento por papel (vê todos os tipos da empresa)', async () => {
    const typeId = await createDocType(tokenAdminA);
    const all = await listTypes(tokenAdminA);
    expect(all.map((t) => t.id)).toContain(typeId);
  });

  it('tipo global só aparece no dept configurado em global_type_tenant_depts', async () => {
    const deptBId = await createSecondDept();
    // Tipo global (tenant_id NULL) + configuração de visibilidade no dept A do tenant A
    const globalRows = await testDb.db<Array<{ id: string }>>`
      INSERT INTO document_types (id, tenant_id, name, description, is_global, index_fields, deleted, created_at)
      VALUES (gen_random_uuid(), NULL, 'Boleto Global', NULL, true, '[]'::jsonb, false, NOW())
      RETURNING id
    `;
    const globalId = globalRows[0]!.id;
    await testDb.db`
      INSERT INTO global_type_tenant_depts (id, global_type_id, tenant_id, department_ids, deleted, created_at, updated_at)
      VALUES (gen_random_uuid(), ${globalId}, ${TENANT_A}, ${[deptAId]}::uuid[], false, NOW(), NOW())
    `;

    const inA = await listTypes(tokenAdminA, deptAId);
    expect(inA.map((t) => t.id)).toContain(globalId);

    const inB = await listTypes(tokenAdminA, deptBId);
    expect(inB.map((t) => t.id)).not.toContain(globalId);
  });

  it('departamento de outro tenant → 404 (nunca 403)', async () => {
    const otherDeptRows = await testDb.db<Array<{ id: string }>>`
      INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
      VALUES (gen_random_uuid(), ${TENANT_B}, NULL, 'Dept B', 0, '{}'::text[], false, NOW())
      RETURNING id
    `;
    const res = await app.inject({
      method: 'GET',
      url: `/document-types?departmentId=${otherDeptRows[0]!.id}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /document-types — visibilidade por papel para UPLOADER/USER.
// Regressão do bug b49115da (DOCTYPE-6/7): papéis não-admin recebiam lista
// VAZIA — os tipos globais (sem associação de departamento, visíveis a todos
// os papéis sem restrição) sumiam. Também cobre a interseção de tipos de
// empresa pela subárvore concedida.
// ---------------------------------------------------------------------------

describe('GET /document-types — visibilidade para UPLOADER/USER', () => {
  interface DocTypeItem {
    id: string;
    name: string;
    isGlobal: boolean;
  }

  async function seedGlobalType(name: string): Promise<string> {
    const rows = await testDb.db<Array<{ id: string }>>`
      INSERT INTO document_types (id, tenant_id, name, description, is_global, index_fields, deleted, created_at)
      VALUES (gen_random_uuid(), NULL, ${name}, NULL, true, '[]'::jsonb, false, NOW())
      RETURNING id
    `;
    return rows[0]!.id;
  }

  async function grantRoot(userId: string, departmentId: string): Promise<void> {
    await testDb.db`
      INSERT INTO department_permissions (id, tenant_id, user_id, department_id, can_read, can_write, deleted)
      VALUES (gen_random_uuid(), ${TENANT_A}, ${userId}, ${departmentId}, true, true, false)
    `;
  }

  async function listTypes(token: string): Promise<DocTypeItem[]> {
    const res = await app.inject({
      method: 'GET',
      url: '/document-types',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as DocTypeItem[];
  }

  it('USER sem concessão vê APENAS os tipos globais (nunca lista vazia)', async () => {
    const globalId = await seedGlobalType('Boleto Global');
    // Tipo de empresa existe, mas o USER não tem concessão de departamento.
    await createDocType(tokenAdminA);

    const userId = '11111111-1111-1111-1111-111111111101';
    await seedUser(testDb.db, {
      id: userId,
      tenantId: TENANT_A,
      email: 'user-a@doctypes.com',
      password: PASSWORD,
      role: 'USER',
    });
    const token = await login('user-a@doctypes.com');

    const types = await listTypes(token);
    expect(types.map((t) => t.id)).toEqual([globalId]);
    expect(types.every((t) => t.isGlobal)).toBe(true);
  });

  it('UPLOADER com raiz concedida vê globais + tipos de empresa com interseção', async () => {
    const globalId = await seedGlobalType('Contrato Global');
    const companyTypeId = await createDocType(tokenAdminA); // escopado a [deptAId]

    const uploaderId = '11111111-1111-1111-1111-111111111102';
    await seedUser(testDb.db, {
      id: uploaderId,
      tenantId: TENANT_A,
      email: 'uploader-a@doctypes.com',
      password: PASSWORD,
      role: 'UPLOADER',
    });
    await grantRoot(uploaderId, deptAId);
    const token = await login('uploader-a@doctypes.com');

    const types = await listTypes(token);
    const ids = types.map((t) => t.id);
    expect(ids).toContain(globalId);
    expect(ids).toContain(companyTypeId);
  });

  it('UPLOADER sem concessão vê os globais mas NÃO tipos de empresa', async () => {
    const globalId = await seedGlobalType('Nota Fiscal Global');
    const companyTypeId = await createDocType(tokenAdminA);

    const uploaderId = '11111111-1111-1111-1111-111111111103';
    await seedUser(testDb.db, {
      id: uploaderId,
      tenantId: TENANT_A,
      email: 'uploader-b@doctypes.com',
      password: PASSWORD,
      role: 'UPLOADER',
    });
    const token = await login('uploader-b@doctypes.com');

    const types = await listTypes(token);
    const ids = types.map((t) => t.id);
    expect(ids).toContain(globalId);
    expect(ids).not.toContain(companyTypeId);
  });
});

// ---------------------------------------------------------------------------
// POST /document-types — autorização e conflito de nome.
// Regressão dos bugs c138ef7c (nome duplicado → 500) e 7322a256 (TENANT_ADMIN
// criando tipo global → 500). Ambos devem ser erros de domínio tratados.
// ---------------------------------------------------------------------------

describe('POST /document-types — autorização e unicidade de nome', () => {
  it('nome duplicado no mesmo tenant → 409 CONFLICT (nunca 500)', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/document-types',
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { name: 'Recibo', isGlobal: false, departmentIds: [deptAId] },
    });
    expect(first.statusCode).toBe(201);

    const dup = await app.inject({
      method: 'POST',
      url: '/document-types',
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { name: 'Recibo', isGlobal: false, departmentIds: [deptAId] },
    });
    expect(dup.statusCode).toBe(409);
    expect((dup.json() as { error: { code: string } }).error.code).toBe('CONFLICT');
  });

  it('TENANT_ADMIN criando tipo global (isGlobal:true) → 403, sem persistir nada', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/document-types',
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { name: 'Tipo Global Ilegal', isGlobal: true },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN');

    // Nenhum tipo global foi criado (sem escalonamento de privilégio).
    const rows = await testDb.db<Array<{ count: string }>>`
      SELECT COUNT(*) AS count FROM document_types
      WHERE is_global = true AND name = 'Tipo Global Ilegal'
    `;
    expect(parseInt(rows[0]!.count, 10)).toBe(0);
  });

  it('SUPER_ADMIN pode criar tipo global (controle) → 201', async () => {
    const superId = '11111111-1111-1111-1111-1111111111ff';
    await seedUser(testDb.db, {
      id: superId,
      tenantId: null,
      email: 'super@doctypes.com',
      password: PASSWORD,
      role: 'SUPER_ADMIN',
    });
    const token = await login('super@doctypes.com');

    const res = await app.inject({
      method: 'POST',
      url: '/document-types',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Tipo Global Legítimo', isGlobal: true },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { isGlobal: boolean }).isGlobal).toBe(true);
  });
});

describe('Sinais de reconhecimento por tipo (recognitionKeywords/recognitionRules)', () => {
  it('cria tipo de empresa com sinais → persiste e retorna os campos', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/document-types',
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: {
        name: 'Boleto',
        description: 'Cobrança bancária',
        recognitionKeywords: ['linha digitável', 'código de barras'],
        recognitionRules: 'NÃO classifique como Recibo se houver linha digitável.',
        isGlobal: false,
        departmentIds: [deptAId],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      recognitionKeywords: string[];
      recognitionRules: string | null;
    };
    expect(body.recognitionKeywords).toEqual(['linha digitável', 'código de barras']);
    expect(body.recognitionRules).toBe('NÃO classifique como Recibo se houver linha digitável.');

    // Persistência real no banco.
    const rows = await testDb.db<
      Array<{ recognition_keywords: string[]; recognition_rules: string | null }>
    >`
      SELECT recognition_keywords, recognition_rules FROM document_types WHERE id = ${body.id}
    `;
    expect(rows[0]!.recognition_keywords).toEqual(['linha digitável', 'código de barras']);
    expect(rows[0]!.recognition_rules).toBe('NÃO classifique como Recibo se houver linha digitável.');
  });

  it('tipo criado SEM sinais tem defaults seguros (array vazio, regras null)', async () => {
    const typeId = await createDocType(tokenAdminA);
    const rows = await testDb.db<
      Array<{ recognition_keywords: string[]; recognition_rules: string | null }>
    >`
      SELECT recognition_keywords, recognition_rules FROM document_types WHERE id = ${typeId}
    `;
    expect(rows[0]!.recognition_keywords).toEqual([]);
    expect(rows[0]!.recognition_rules).toBeNull();
  });

  it('PATCH atualiza os sinais do tipo', async () => {
    const typeId = await createDocType(tokenAdminA);
    const res = await app.inject({
      method: 'PATCH',
      url: `/document-types/${typeId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: {
        recognitionKeywords: ['cnpj', 'valor total'],
        recognitionRules: 'Fatura tem vencimento; Recibo não.',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { recognitionKeywords: string[]; recognitionRules: string | null };
    expect(body.recognitionKeywords).toEqual(['cnpj', 'valor total']);
    expect(body.recognitionRules).toBe('Fatura tem vencimento; Recibo não.');
  });

  it('GET /document-types retorna os sinais de cada tipo', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/document-types',
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: {
        name: 'Fatura',
        recognitionKeywords: ['vencimento'],
        isGlobal: false,
        departmentIds: [deptAId],
      },
    });
    expect(create.statusCode).toBe(201);

    const res = await app.inject({
      method: 'GET',
      url: '/document-types',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ name: string; recognitionKeywords: string[] }>;
    const fatura = list.find((t) => t.name === 'Fatura');
    expect(fatura?.recognitionKeywords).toEqual(['vencimento']);
  });

  it('rejeita quando o número de palavras-chave excede o teto', async () => {
    const tooMany = Array.from({ length: 25 }, (_, i) => `kw${i}`);
    const res = await app.inject({
      method: 'POST',
      url: '/document-types',
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: {
        name: 'Tipo Excessivo',
        recognitionKeywords: tooMany,
        isGlobal: false,
        departmentIds: [deptAId],
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejeita quando as regras excedem o teto de caracteres', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/document-types',
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: {
        name: 'Tipo Regra Longa',
        recognitionRules: 'x'.repeat(501),
        isGlobal: false,
        departmentIds: [deptAId],
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('isolamento multi-tenant: admin de B não edita sinais de tipo de A (404)', async () => {
    const typeId = await createDocType(tokenAdminA);
    const res = await app.inject({
      method: 'PATCH',
      url: `/document-types/${typeId}`,
      headers: { authorization: `Bearer ${tokenAdminB}` },
      payload: { recognitionKeywords: ['invasor'] },
    });
    expect(res.statusCode).toBe(404);

    // Sinais do tipo de A permanecem intactos (nenhum vazamento de escrita).
    const rows = await testDb.db<Array<{ recognition_keywords: string[] }>>`
      SELECT recognition_keywords FROM document_types WHERE id = ${typeId}
    `;
    expect(rows[0]!.recognition_keywords).toEqual([]);
  });
});
