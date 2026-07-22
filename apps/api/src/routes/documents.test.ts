import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import FormData from 'form-data';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, type TestDb } from '../test/helpers.js';
import type { S3Service } from '../services/s3.js';
import { newId } from '@dmdoc/db-pg';
import type { LLMProvider, ChatResult } from '@dmdoc/llm-provider';

// ---------------------------------------------------------------------------
// Mock de S3Service — nunca chama AWS real nos testes
// ---------------------------------------------------------------------------
function createMockS3(): S3Service {
  return {
    uploadFile: vi.fn().mockResolvedValue(undefined),
    getSignedDownloadUrl: vi.fn().mockResolvedValue('https://mock-signed-url'),
    deleteFile: vi.fn().mockResolvedValue(undefined),
  } as unknown as S3Service;
}

// ---------------------------------------------------------------------------
// Constantes de fixture
// ---------------------------------------------------------------------------
// UUIDs de tenant por arquivo — evita colisão no `dmdoc_test` compartilhado.
const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();
const ADMIN_A_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const UPLOADER_A_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ADMIN_B_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const PASSWORD = 'senha-forte-de-teste-123';
const DEPT_A_ID = newId();
const DEPT_B_ID = newId();
const DOC_TYPE_ID = newId();
const GLOBAL_DOC_TYPE_ID = newId();

// Cota de 10 MB para os tenants de teste
const DISK_QUOTA = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
let app: FastifyInstance;
let testDb: TestDb;
let mockS3: S3Service;
let tokenAdminA: string;
let tokenUploaderA: string;
let tokenAdminB: string;

// Fake de LLMProvider injetado nas rotas de IA (POST /documents/:id/classify e
// /suggest-indexes) — exercita as rotas sem chamar o provedor real. Cada teste
// configura o retorno via `fakeLlmChat.mockResolvedValueOnce(...)`.
const fakeLlmChat = vi.fn();
const fakeLlm = {
  chat: fakeLlmChat,
  chatStream: vi.fn(),
} as unknown as LLMProvider;

beforeAll(async () => {
  testDb = await startTestDb();
  mockS3 = createMockS3();
  app = await buildApp({
    config: testConfig(),
    db: testDb.db,
    queue: null, // sem Redis nos testes
    s3: mockS3,
    llmProvider: fakeLlm,
  });
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(async () => {
  vi.clearAllMocks();

  // Limpar tabelas (ordem FK-safe)
  await testDb.db`DELETE FROM document_events`;
  await testDb.db`DELETE FROM audit_logs`;
  await testDb.db`DELETE FROM chunks`;
  await testDb.db`DELETE FROM document_content`;
  await testDb.db`DELETE FROM documents`;
  await testDb.db`DELETE FROM department_permissions`;
  await testDb.db`DELETE FROM document_type_index_fields`;
  await testDb.db`DELETE FROM document_types`;
  await testDb.db`DELETE FROM departments`;
  // Inclui MULTI_TENANT_ADMIN/SUPER_ADMIN (tenant_id NULL) — sem isso, usuários
  // desses papéis criados por um teste (ex.: MTA usado no sort por companyName)
  // vazam para a próxima execução e colidem com `uniq_users_null_tenant_email`.
  await testDb.db`DELETE FROM users WHERE tenant_id IS NOT NULL OR role IN ('TENANT_ADMIN','UPLOADER','USER','MULTI_TENANT_ADMIN','SUPER_ADMIN')`;
  await testDb.db`DELETE FROM tenants WHERE id IN (${TENANT_A}, ${TENANT_B})`;

  // Inserir tenants
  await testDb.db`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
    VALUES
      (${TENANT_A}, 'Empresa A', ${DISK_QUOTA}, 20, true, NOW()),
      (${TENANT_B}, 'Empresa B', ${DISK_QUOTA}, 20, true, NOW())
    ON CONFLICT (id) DO NOTHING
  `;

  // Inserir departamentos
  await testDb.db`
    INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
    VALUES
      (${DEPT_A_ID}, ${TENANT_A}, NULL, 'Financeiro A', 0, '{}'::text[], false, NOW()),
      (${DEPT_B_ID}, ${TENANT_B}, NULL, 'Financeiro B', 0, '{}'::text[], false, NOW())
    ON CONFLICT (id) DO NOTHING
  `;

  // Inserir tipos de documento
  await testDb.db`
    INSERT INTO document_types (id, tenant_id, name, description, is_global, index_fields, deleted, created_at)
    VALUES
      (${DOC_TYPE_ID}, ${TENANT_A}, 'Contrato A', NULL, false, '[]'::jsonb, false, NOW()),
      (${GLOBAL_DOC_TYPE_ID}, NULL, 'Tipo Global', NULL, true, '[]'::jsonb, false, NOW())
    ON CONFLICT (id) DO NOTHING
  `;

  // Inserir usuários
  await seedUser(testDb.db, {
    id: ADMIN_A_ID,
    tenantId: TENANT_A,
    email: 'admin-a@empresa.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
  });
  await seedUser(testDb.db, {
    id: UPLOADER_A_ID,
    tenantId: TENANT_A,
    email: 'uploader-a@empresa.com',
    password: PASSWORD,
    role: 'UPLOADER',
  });
  await seedUser(testDb.db, {
    id: ADMIN_B_ID,
    tenantId: TENANT_B,
    email: 'admin-b@empresa.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
  });

  // Permissão de escrita do UPLOADER no departamento A
  await testDb.db`
    INSERT INTO department_permissions (user_id, department_id, tenant_id, can_read, can_write)
    VALUES (${UPLOADER_A_ID}, ${DEPT_A_ID}, ${TENANT_A}, true, true)
    ON CONFLICT (user_id, department_id) WHERE deleted = false DO NOTHING
  `;

  // Obter tokens
  tokenAdminA = await login('admin-a@empresa.com');
  tokenUploaderA = await login('uploader-a@empresa.com');
  tokenAdminB = await login('admin-b@empresa.com');
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

/**
 * Cria um FormData com um arquivo de conteúdo aleatório para testar o upload.
 */
function buildUploadForm(params: {
  content?: Buffer;
  filename?: string;
  departmentId?: string;
  documentTypeId?: string;
  indexValues?: Record<string, unknown>;
}): { payload: Buffer; headers: Record<string, string> } {
  const form = new FormData();
  const content = params.content ?? Buffer.from('conteudo-de-teste-' + Math.random());
  form.append('file', content, {
    filename: params.filename ?? 'teste.pdf',
    contentType: 'application/pdf',
  });
  form.append('departmentId', params.departmentId ?? DEPT_A_ID);
  if (params.documentTypeId !== undefined) {
    form.append('documentTypeId', params.documentTypeId);
  }
  if (params.indexValues !== undefined) {
    form.append('indexValues', JSON.stringify(params.indexValues));
  }

  return {
    payload: form.getBuffer(),
    headers: form.getHeaders() as Record<string, string>,
  };
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

describe('POST /documents — upload básico', () => {
  it('TENANT_ADMIN consegue fazer upload e recebe 201', async () => {
    const { payload, headers } = buildUploadForm({ departmentId: DEPT_A_ID });

    const res = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...headers },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body.tenantId).toBe(TENANT_A);
    expect(body.departmentId).toBe(DEPT_A_ID);
    expect(body.status).toBe('PENDING');
    expect(typeof body.contentHash).toBe('string');
    expect((body.contentHash as string).length).toBe(64); // SHA-256 hex
    expect(body.deleted).toBe(false);

    // Verificar que o S3 foi chamado
    expect(mockS3.uploadFile).toHaveBeenCalledOnce();
  });

  it('UPLOADER com permissão de escrita consegue fazer upload', async () => {
    const { payload, headers } = buildUploadForm({ departmentId: DEPT_A_ID });

    const res = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenUploaderA}`, ...headers },
      payload,
    });

    expect(res.statusCode).toBe(201);
  });

  it('persiste documento no banco com campos corretos', async () => {
    const content = Buffer.from('conteudo-especifico-para-validar-persistencia');
    const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
    const { payload, headers } = buildUploadForm({ content, departmentId: DEPT_A_ID });

    const res = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...headers },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;

    // Verificar no banco
    const rows = await testDb.db<Array<Record<string, unknown>>>`
      SELECT tenant_id, status, content_hash, uploaded_by_id, deleted
      FROM documents WHERE id = ${body.id as string}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['tenant_id']).toBe(TENANT_A);
    expect(rows[0]?.['status']).toBe('PENDING');
    expect(rows[0]?.['content_hash']).toBe(expectedHash);
    expect(rows[0]?.['uploaded_by_id']).toBe(ADMIN_A_ID);
    expect(rows[0]?.['deleted']).toBe(false);
  });

  it('cria registro de audit log com action document.upload', async () => {
    const { payload, headers } = buildUploadForm({ departmentId: DEPT_A_ID });

    const res = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...headers },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;

    const logs = await testDb.db<Array<Record<string, unknown>>>`
      SELECT * FROM audit_logs WHERE action = 'document.upload' AND tenant_id = ${TENANT_A}
    `;
    expect(logs).toHaveLength(1);
    expect(logs[0]?.['resource']).toBe(`documents/${body.id as string}`);
    expect(logs[0]?.['user_id']).toBe(ADMIN_A_ID);
  });

  it('retorna s3Key com formato correto', async () => {
    const { payload, headers } = buildUploadForm({
      departmentId: DEPT_A_ID,
      filename: 'meu documento.pdf',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...headers },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    const s3Key = body.s3Key as string;
    expect(s3Key).toMatch(new RegExp(`^tenants/${TENANT_A}/documents/[a-f0-9]{64}/`));
  });
});

describe('POST /documents — classificação manual de tipo', () => {
  it('aceita documentTypeId pertencente ao tenant', async () => {
    const { payload, headers } = buildUploadForm({
      departmentId: DEPT_A_ID,
      documentTypeId: DOC_TYPE_ID,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...headers },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body.documentTypeId).toBe(DOC_TYPE_ID);
  });

  it('aceita documentTypeId global (isGlobal: true)', async () => {
    const { payload, headers } = buildUploadForm({
      departmentId: DEPT_A_ID,
      documentTypeId: GLOBAL_DOC_TYPE_ID,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...headers },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body.documentTypeId).toBe(GLOBAL_DOC_TYPE_ID);
  });

  it('rejeita documentTypeId de outro tenant com 404', async () => {
    // Tipo do tenant B — não acessível pelo tenant A
    const typeBId = newId();
    await testDb.db`
      INSERT INTO document_types (id, tenant_id, name, description, is_global, index_fields, deleted, created_at)
      VALUES (${typeBId}, ${TENANT_B}, 'Tipo B', NULL, false, '[]'::jsonb, false, NOW())
    `;

    const { payload, headers } = buildUploadForm({
      departmentId: DEPT_A_ID,
      documentTypeId: typeBId,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...headers },
      payload,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('upload sem documentTypeId armazena documentTypeId como null', async () => {
    const { payload, headers } = buildUploadForm({ departmentId: DEPT_A_ID });

    const res = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...headers },
      payload,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().documentTypeId).toBeNull();
  });
});

describe('POST /documents — deduplicação por SHA-256', () => {
  it('retorna documento existente com 200 e header X-Deduplicated ao reenviar o mesmo arquivo', async () => {
    const content = Buffer.from('arquivo-identico-para-testar-dedup');
    const form1 = buildUploadForm({ content, departmentId: DEPT_A_ID });
    const form2 = buildUploadForm({ content, departmentId: DEPT_A_ID });

    // Primeiro upload — deve criar
    const res1 = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...form1.headers },
      payload: form1.payload,
    });
    expect(res1.statusCode).toBe(201);
    const firstDocId = res1.json().id as string;

    // Segundo upload — deve deduplicar
    const res2 = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...form2.headers },
      payload: form2.payload,
    });

    expect(res2.statusCode).toBe(200);
    expect(res2.headers['x-deduplicated']).toBe('true');
    expect(res2.json().id).toBe(firstDocId);

    // S3 só deve ter sido chamado uma vez (não faz upload duplicado)
    expect(mockS3.uploadFile).toHaveBeenCalledOnce();
  });

  it('documentos com conteúdo diferente não sofrem dedup', async () => {
    const form1 = buildUploadForm({
      content: Buffer.from('arquivo-a'),
      departmentId: DEPT_A_ID,
    });
    const form2 = buildUploadForm({
      content: Buffer.from('arquivo-b'),
      departmentId: DEPT_A_ID,
    });

    const res1 = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...form1.headers },
      payload: form1.payload,
    });
    const res2 = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...form2.headers },
      payload: form2.payload,
    });

    expect(res1.statusCode).toBe(201);
    expect(res2.statusCode).toBe(201);
    expect(res1.json().id).not.toBe(res2.json().id);
    expect(mockS3.uploadFile).toHaveBeenCalledTimes(2);
  });

  it('tenants diferentes com mesmo arquivo NÃO são deduplicados entre si', async () => {
    const content = Buffer.from('arquivo-para-testar-isolamento-de-dedup');
    const formA = buildUploadForm({ content, departmentId: DEPT_A_ID });
    const formB = buildUploadForm({ content, departmentId: DEPT_B_ID });

    const resA = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...formA.headers },
      payload: formA.payload,
    });
    const resB = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminB}`, ...formB.headers },
      payload: formB.payload,
    });

    expect(resA.statusCode).toBe(201);
    expect(resB.statusCode).toBe(201);
    // Ids diferentes — tenants isolados
    expect(resA.json().id).not.toBe(resB.json().id);
    // S3 foi chamado duas vezes (um por tenant)
    expect(mockS3.uploadFile).toHaveBeenCalledTimes(2);
  });

  it('reenvio de conteúdo cujo doc está FAILED cria um NOVO documento (exceção FAILED), nunca 500/dedup', async () => {
    // Regressão do bug d61a7cc4 (UPLOAD-14): o índice único parcial
    // (tenant_id, content_hash) WHERE deleted=false colidia ao reenviar um
    // conteúdo FAILED, vazando como 500. Agora o registro FAILED é
    // soft-deletado e um novo documento é criado + reenfileirado.
    const content = Buffer.from('conteudo-que-falhou-na-extracao');
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');

    // Documento existente com o MESMO hash, em status FAILED.
    const failedDocId = newId();
    await testDb.db`
      INSERT INTO documents (
        id, tenant_id, department_id, document_type_id,
        filename, original_filename, content_hash, size_bytes, mime_type,
        s3_key, status, failure_reason, tags, index_values,
        uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
      ) VALUES (
        ${failedDocId}, ${TENANT_A}, ${DEPT_A_ID}, NULL,
        'falhou.pdf', 'falhou.pdf', ${contentHash}, ${content.byteLength}, 'application/pdf',
        'test/key-failed', 'FAILED', 'extração falhou', '{}'::text[], '{}'::jsonb,
        ${ADMIN_A_ID}, NOW(), NULL, 0, false
      )
    `;

    const { payload, headers } = buildUploadForm({ content, departmentId: DEPT_A_ID });
    const res = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...headers },
      payload,
    });

    // Novo documento (não dedup)
    expect(res.statusCode).toBe(201);
    expect(res.headers['x-deduplicated']).toBeUndefined();
    const newDocId = res.json().id as string;
    expect(newDocId).not.toBe(failedDocId);
    expect(res.json().status).toBe('PENDING');

    // O antigo FAILED foi soft-deletado; o novo é o único não-deletado com o hash.
    const rows = await testDb.db<Array<{ id: string; status: string; deleted: boolean }>>`
      SELECT id, status, deleted FROM documents
      WHERE tenant_id = ${TENANT_A} AND content_hash = ${contentHash}
      ORDER BY uploaded_at
    `;
    const oldRow = rows.find((r) => r.id === failedDocId);
    const newRow = rows.find((r) => r.id === newDocId);
    expect(oldRow?.deleted).toBe(true);
    expect(newRow?.deleted).toBe(false);
    // Invariante do índice único parcial: exatamente um não-deletado com o hash.
    expect(rows.filter((r) => !r.deleted)).toHaveLength(1);
  });

  it('uploads concorrentes do mesmo conteúdo novo: um 201 e os demais 409 (nunca 500), um único doc persiste', async () => {
    // Regressão do bug f67c1f66 (UPLOAD-16): dois (ou mais) uploads simultâneos
    // do MESMO conteúdo novo passam pela checagem de dedup antes de qualquer um
    // persistir; o índice único parcial (tenant_id, content_hash) WHERE
    // deleted=false deixa só um vencer — o perdedor deve receber 409 (wiki
    // "Deduplicação de documentos por conteúdo", caso de borda de upload
    // concorrente), nunca 500.
    const content = Buffer.from('conteudo-corrida-concorrente-unico');
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');

    // Barreira determinística: a checagem de dedup ocorre ANTES do upload S3.
    // Ao segurar TODOS os handlers no upload S3 por um instante, garantimos que
    // todos passem pela checagem de dedup (achando nada) antes de qualquer
    // insert — forçando a corrida no índice único de forma reproduzível.
    vi.mocked(mockS3.uploadFile).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    const N = 3;
    try {
      const responses = await Promise.all(
        Array.from({ length: N }, () => {
          const { payload, headers } = buildUploadForm({
            content,
            departmentId: DEPT_A_ID,
            filename: 'corrida.pdf',
          });
          return app.inject({
            method: 'POST',
            url: '/documents',
            headers: { authorization: `Bearer ${tokenAdminA}`, ...headers },
            payload,
          });
        })
      );

      const codes = responses.map((r) => r.statusCode);
      // Nunca 500.
      expect(codes).not.toContain(500);
      // Exatamente um vencedor 201.
      expect(codes.filter((c) => c === 201)).toHaveLength(1);
      // Os demais são 409 CONFLICT (perdedores da corrida).
      expect(codes.filter((c) => c === 409)).toHaveLength(N - 1);
      const loser = responses.find((r) => r.statusCode === 409)!;
      expect((loser.json() as { error: { code: string } }).error.code).toBe('CONFLICT');
    } finally {
      // Restaura o mock (clearAllMocks do beforeEach zera chamadas, não a impl).
      vi.mocked(mockS3.uploadFile).mockImplementation(async () => undefined);
    }

    // Integridade preservada: exatamente um documento não-deletado com o hash.
    const rows = await testDb.db<Array<{ id: string; deleted: boolean }>>`
      SELECT id, deleted FROM documents
      WHERE tenant_id = ${TENANT_A} AND content_hash = ${contentHash}
    `;
    expect(rows.filter((r) => !r.deleted)).toHaveLength(1);
  });
});

describe('POST /documents — verificação de cota', () => {
  it('rejeita upload quando excede cota de disco com 422 QUOTA_EXCEEDED', async () => {
    // Configura tenant A com cota de 1 byte — qualquer upload vai exceder
    await testDb.db`UPDATE tenants SET disk_quota_bytes = 1 WHERE id = ${TENANT_A}`;

    const { payload, headers } = buildUploadForm({ departmentId: DEPT_A_ID });

    const res = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...headers },
      payload,
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('QUOTA_EXCEEDED');
  });

  it('rejeita quando documentos existentes + novo arquivo excede a cota', async () => {
    const halfQuota = Math.floor(DISK_QUOTA / 2);

    // Insere documento fictício que já ocupa metade da cota
    await testDb.db`
      INSERT INTO documents (
        id, tenant_id, department_id, document_type_id,
        filename, original_filename, content_hash, size_bytes, mime_type,
        s3_key, status, failure_reason, tags, index_values,
        uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
      ) VALUES (
        ${newId()}, ${TENANT_A}, ${DEPT_A_ID}, NULL,
        'existente.pdf', 'existente.pdf', ${'a'.repeat(64)}, ${halfQuota + 100}, 'application/pdf',
        'test/key', 'READY', NULL, '{}'::text[], '{}'::jsonb,
        ${ADMIN_A_ID}, NOW(), NOW(), 0, false
      )
    `;

    // Tenta enviar outro arquivo grande
    const largeContent = Buffer.alloc(halfQuota + 200, 'x');
    const { payload, headers } = buildUploadForm({
      content: largeContent,
      departmentId: DEPT_A_ID,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...headers },
      payload,
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('QUOTA_EXCEEDED');
  });
});

describe('POST /documents — isolamento multi-tenant', () => {
  it('tenant A não consegue fazer upload para departamento do tenant B → 404', async () => {
    // Admin A tenta fazer upload para o departamento B
    const { payload, headers } = buildUploadForm({ departmentId: DEPT_B_ID });

    const res = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...headers },
      payload,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('documento criado pertence exclusivamente ao tenant do usuário autenticado', async () => {
    const { payload, headers } = buildUploadForm({ departmentId: DEPT_A_ID });

    const res = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...headers },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    // tenantId vem sempre do JWT, nunca do body
    expect(body.tenantId).toBe(TENANT_A);
  });
});

describe('POST /documents — validações de entrada', () => {
  it('retorna 422 quando campo file está ausente', async () => {
    const form = new FormData();
    form.append('departmentId', DEPT_A_ID);

    const res = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: {
        authorization: `Bearer ${tokenAdminA}`,
        ...(form.getHeaders() as Record<string, string>),
      },
      payload: form.getBuffer(),
    });

    expect(res.statusCode).toBe(422);
  });

  it('retorna 422 quando departmentId está ausente', async () => {
    const form = new FormData();
    form.append('file', Buffer.from('conteudo'), {
      filename: 'teste.pdf',
      contentType: 'application/pdf',
    });
    // departmentId intencionalmente omitido

    const res = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: {
        authorization: `Bearer ${tokenAdminA}`,
        ...(form.getHeaders() as Record<string, string>),
      },
      payload: form.getBuffer(),
    });

    expect(res.statusCode).toBe(422);
  });

  it('retorna 401 sem token de autenticação', async () => {
    const { payload, headers } = buildUploadForm({ departmentId: DEPT_A_ID });

    const res = await app.inject({
      method: 'POST',
      url: '/documents',
      headers,
      payload,
    });

    expect(res.statusCode).toBe(401);
  });

  it('UPLOADER sem permissão de escrita no departamento recebe 404', async () => {
    // Criar uploader sem permissão no dept A
    const uploaderSemPermId = newId();
    await seedUser(testDb.db, {
      id: uploaderSemPermId,
      tenantId: TENANT_A,
      email: 'uploader-sem-perm@empresa.com',
      password: PASSWORD,
      role: 'UPLOADER',
    });
    const tokenSemPerm = await login('uploader-sem-perm@empresa.com');

    const { payload, headers } = buildUploadForm({ departmentId: DEPT_A_ID });

    const res = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenSemPerm}`, ...headers },
      payload,
    });

    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// ACL por raiz com herança dinâmica (Fase 6).
// ---------------------------------------------------------------------------
describe('ACL por raiz — herança dinâmica de acesso à subárvore', () => {
  it('conceder raiz dá ao UPLOADER escrita em um filho existente e num filho criado depois', async () => {
    // 1. UPLOADER com concessão da RAIZ (DEPT_A_ID), canRead=canWrite=true.
    const uploaderRaizId = newId();
    await seedUser(testDb.db, {
      id: uploaderRaizId,
      tenantId: TENANT_A,
      email: 'uploader-raiz@empresa.com',
      password: PASSWORD,
      role: 'UPLOADER',
    });
    await testDb.db`
      INSERT INTO department_permissions (user_id, department_id, tenant_id, can_read, can_write)
      VALUES (${uploaderRaizId}, ${DEPT_A_ID}, ${TENANT_A}, true, true)
      ON CONFLICT (user_id, department_id) WHERE deleted = false DO NOTHING
    `;
    const tokenRaiz = await login('uploader-raiz@empresa.com');

    // 2. Filho EXISTENTE da raiz DEPT_A_ID (parent_id = DEPT_A_ID, nível 1).
    const childId = newId();
    await testDb.db`
      INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
      VALUES (${childId}, ${TENANT_A}, ${DEPT_A_ID}, 'Filho de A', 1, '{}'::text[], false, NOW())
    `;

    // Upload no filho existente — deve funcionar (acesso herdado da raiz).
    const formChild = buildUploadForm({ departmentId: childId });
    const resChild = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenRaiz}`, ...formChild.headers },
      payload: formChild.payload,
    });
    expect(resChild.statusCode).toBe(201);
    expect(resChild.json().departmentId).toBe(childId);

    // 3. Filho CRIADO DEPOIS (sem re-salvar permissões) — também acessível.
    const futureChildId = newId();
    await testDb.db`
      INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
      VALUES (${futureChildId}, ${TENANT_A}, ${childId}, 'Neto de A', 2, '{}'::text[], false, NOW())
    `;

    const formFuture = buildUploadForm({ departmentId: futureChildId });
    const resFuture = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenRaiz}`, ...formFuture.headers },
      payload: formFuture.payload,
    });
    expect(resFuture.statusCode).toBe(201);
    expect(resFuture.json().departmentId).toBe(futureChildId);
  });

  it('GET /documents lista documentos de filhos quando só a raiz foi concedida', async () => {
    // UPLOADER com concessão da raiz DEPT_A_ID.
    const uploaderListId = newId();
    await seedUser(testDb.db, {
      id: uploaderListId,
      tenantId: TENANT_A,
      email: 'uploader-list@empresa.com',
      password: PASSWORD,
      role: 'UPLOADER',
    });
    await testDb.db`
      INSERT INTO department_permissions (user_id, department_id, tenant_id, can_read, can_write)
      VALUES (${uploaderListId}, ${DEPT_A_ID}, ${TENANT_A}, true, true)
      ON CONFLICT (user_id, department_id) WHERE deleted = false DO NOTHING
    `;
    const tokenList = await login('uploader-list@empresa.com');

    // Filho da raiz + documento READY nesse filho (inserido direto no banco).
    const childId = newId();
    await testDb.db`
      INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
      VALUES (${childId}, ${TENANT_A}, ${DEPT_A_ID}, 'Filho listável', 1, '{}'::text[], false, NOW())
    `;
    const docId = newId();
    const hashC = 'c'.repeat(64);
    await testDb.db`
      INSERT INTO documents (
        id, tenant_id, department_id, document_type_id,
        filename, original_filename, content_hash, size_bytes, mime_type,
        s3_key, status, failure_reason, tags, index_values,
        uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
      ) VALUES (
        ${docId}, ${TENANT_A}, ${childId}, NULL,
        'filho.pdf', 'filho.pdf', ${hashC}, 512, 'application/pdf',
        ${`tenants/${TENANT_A}/documents/${hashC}/filho.pdf`}, 'READY', NULL, '{}'::text[], '{}'::jsonb,
        ${uploaderListId}, NOW(), NOW(), 0, false
      )
    `;

    const res = await app.inject({
      method: 'GET',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenList}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().items as Array<{ id: string }>).map((d) => d.id);
    expect(ids).toContain(docId);
  });
});

// ---------------------------------------------------------------------------
// Regressão de SEGURANÇA: concessão de departamento REVOGADA (soft-deletada)
// não pode mais conceder acesso de leitura NEM de escrita a documentos.
// Ver bug 0b4b4345: o resolvedor de acesso ignorava `department_permissions.deleted`.
// ---------------------------------------------------------------------------
describe('ACL — concessão revogada (department_permissions.deleted=true) não dá acesso', () => {
  /** Cria um documento READY no departamento/tenant informado. Retorna o id. */
  async function seedReadyDoc(departmentId: string, tenantId: string): Promise<string> {
    const docId = newId();
    const hash = crypto.randomBytes(32).toString('hex');
    await testDb.db`
      INSERT INTO documents (
        id, tenant_id, department_id, document_type_id,
        filename, original_filename, content_hash, size_bytes, mime_type,
        s3_key, status, failure_reason, tags, index_values,
        uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
      ) VALUES (
        ${docId}, ${tenantId}, ${departmentId}, NULL,
        'acl.pdf', 'acl.pdf', ${hash}, 1024, 'application/pdf',
        ${`tenants/${tenantId}/documents/${hash}/acl.pdf`}, 'READY', NULL, '{}'::text[], '{}'::jsonb,
        ${ADMIN_A_ID}, NOW(), NOW(), 0, false
      )
    `;
    return docId;
  }

  /**
   * Cria um usuário no TENANT_A e devolve id + token. Papel `USER` por padrão;
   * aceita `UPLOADER` para os casos que exercitam a capacidade de escrita.
   */
  async function seedUserWithToken(
    email: string,
    role: 'USER' | 'UPLOADER' = 'USER'
  ): Promise<{ id: string; token: string }> {
    const id = newId();
    await seedUser(testDb.db, {
      id,
      tenantId: TENANT_A,
      email,
      password: PASSWORD,
      role,
    });
    const token = await login(email);
    return { id, token };
  }

  it('USER com concessão SOFT-DELETED: GET /documents → 200 com lista VAZIA', async () => {
    const docId = await seedReadyDoc(DEPT_A_ID, TENANT_A);
    const { id: userId, token } = await seedUserWithToken('user-revogado-list@empresa.com');

    // Concessão na raiz DEPT_A_ID, porém REVOGADA (deleted=true).
    await testDb.db`
      INSERT INTO department_permissions (id, tenant_id, user_id, department_id, can_read, can_write, deleted)
      VALUES (${newId()}, ${TENANT_A}, ${userId}, ${DEPT_A_ID}, true, true, true)
    `;

    const res = await app.inject({
      method: 'GET',
      url: '/documents',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const ids = (res.json().items as Array<{ id: string }>).map((d) => d.id);
    expect(ids).not.toContain(docId);
    expect(ids).toHaveLength(0);
  });

  it('USER com concessão SOFT-DELETED: GET /documents/:id → 404', async () => {
    const docId = await seedReadyDoc(DEPT_A_ID, TENANT_A);
    const { id: userId, token } = await seedUserWithToken('user-revogado-get@empresa.com');

    await testDb.db`
      INSERT INTO department_permissions (id, tenant_id, user_id, department_id, can_read, can_write, deleted)
      VALUES (${newId()}, ${TENANT_A}, ${userId}, ${DEPT_A_ID}, true, true, true)
    `;

    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('USER com concessão SOFT-DELETED: PATCH /documents/:id → 404 e NÃO persiste', async () => {
    const docId = await seedReadyDoc(DEPT_A_ID, TENANT_A);
    const { id: userId, token } = await seedUserWithToken('user-revogado-patch@empresa.com');

    await testDb.db`
      INSERT INTO department_permissions (id, tenant_id, user_id, department_id, can_read, can_write, deleted)
      VALUES (${newId()}, ${TENANT_A}, ${userId}, ${DEPT_A_ID}, true, true, true)
    `;

    const res = await app.inject({
      method: 'PATCH',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'USER revogado nao deveria editar' },
    });

    expect(res.statusCode).toBe(404);

    // O título NÃO foi persistido no banco.
    const rows = await testDb.db<Array<{ title: string | null }>>`
      SELECT title FROM documents WHERE id = ${docId}
    `;
    expect(rows[0]?.title ?? null).toBeNull();
  });

  it('CONTRASTE: USER com concessão ATIVA LÊ normalmente (leitura preservada)', async () => {
    const docId = await seedReadyDoc(DEPT_A_ID, TENANT_A);
    const { id: userId, token } = await seedUserWithToken('user-ativo@empresa.com');

    // Concessão ATIVA na raiz DEPT_A_ID (deleted=false).
    await testDb.db`
      INSERT INTO department_permissions (id, tenant_id, user_id, department_id, can_read, can_write, deleted)
      VALUES (${newId()}, ${TENANT_A}, ${userId}, ${DEPT_A_ID}, true, true, false)
    `;

    // GET lista contém o documento
    const listRes = await app.inject({
      method: 'GET',
      url: '/documents',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listRes.statusCode).toBe(200);
    const ids = (listRes.json().items as Array<{ id: string }>).map((d) => d.id);
    expect(ids).toContain(docId);

    // GET detalhe → 200
    const getRes = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(getRes.statusCode).toBe(200);
  });

  it('INVARIANTE: concessão ATIVA + DEPARTAMENTO soft-deletado → órfão continua acessível/gravável para UPLOADER', async () => {
    // Prova que os dois `deleted` são distintos: revogar a CONCESSÃO tira acesso,
    // mas soft-deletar o DEPARTAMENTO preserva o acesso de quem tem a raiz concedida.
    // A capacidade de ESCRITA aqui exige >= UPLOADER (USER seria somente leitura).
    const docId = await seedReadyDoc(DEPT_A_ID, TENANT_A);
    const { id: userId, token } = await seedUserWithToken(
      'uploader-ativo-dept-excluido@empresa.com',
      'UPLOADER'
    );

    await testDb.db`
      INSERT INTO department_permissions (id, tenant_id, user_id, department_id, can_read, can_write, deleted)
      VALUES (${newId()}, ${TENANT_A}, ${userId}, ${DEPT_A_ID}, true, true, false)
    `;

    // Soft-delete do DEPARTAMENTO (não da concessão).
    await testDb.db`UPDATE departments SET deleted = true WHERE id = ${DEPT_A_ID}`;

    // Documento órfão continua acessível para quem tem a raiz concedida ativa.
    const getRes = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().id).toBe(docId);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'orfao editavel' },
    });
    expect(patchRes.statusCode).toBe(200);
  });

  it('SANITY: USER sem NENHUMA concessão no departamento → GET/:id 404 (segue passando)', async () => {
    const docId = await seedReadyDoc(DEPT_A_ID, TENANT_A);
    const { token } = await seedUserWithToken('user-sem-concessao@empresa.com');
    // Nenhuma linha em department_permissions para este usuário.

    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Papel USER é SOMENTE LEITURA — gate de escrita por nível de papel.
//
// Wiki "Papéis de acesso (roles)": USER = apenas leitura e busca. Mesmo com uma
// raiz concedida ATIVA (que lhe dá leitura da subárvore), o USER NUNCA pode
// escrever: PATCH/DELETE/reprocess/suggest-indexes → 404 (mesma mensagem/erro
// de "sem permissão de escrita", nunca 403 — spec §10, invariante 4). A escrita
// exige nível >= UPLOADER. Ver assertCanWriteDepartment (routes/documents.ts).
// ---------------------------------------------------------------------------
describe('Papel USER é somente leitura — gate de escrita de documentos por papel', () => {
  /** Cria um documento READY no departamento/tenant informado. Retorna o id. */
  async function seedReadyDoc(departmentId: string, tenantId: string): Promise<string> {
    const docId = newId();
    const hash = crypto.randomBytes(32).toString('hex');
    await testDb.db`
      INSERT INTO documents (
        id, tenant_id, department_id, document_type_id,
        filename, original_filename, content_hash, size_bytes, mime_type,
        s3_key, status, failure_reason, tags, index_values,
        uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
      ) VALUES (
        ${docId}, ${tenantId}, ${departmentId}, NULL,
        'ro.pdf', 'ro.pdf', ${hash}, 1024, 'application/pdf',
        ${`tenants/${tenantId}/documents/${hash}/ro.pdf`}, 'READY', NULL, '{}'::text[], '{}'::jsonb,
        ${ADMIN_A_ID}, NOW(), NOW(), 0, false
      )
    `;
    return docId;
  }

  /**
   * Cria um usuário no TENANT_A com uma concessão ATIVA na raiz DEPT_A_ID e
   * devolve o token. Papel `USER` por padrão; `UPLOADER` para os casos de escrita.
   */
  async function seedUserWithGrant(
    email: string,
    role: 'USER' | 'UPLOADER'
  ): Promise<string> {
    const id = newId();
    await seedUser(testDb.db, {
      id,
      tenantId: TENANT_A,
      email,
      password: PASSWORD,
      role,
    });
    await testDb.db`
      INSERT INTO department_permissions (id, tenant_id, user_id, department_id, can_read, can_write, deleted)
      VALUES (${newId()}, ${TENANT_A}, ${id}, ${DEPT_A_ID}, true, true, false)
    `;
    return login(email);
  }

  it('USER com raiz ATIVA: GET /documents lista o doc e GET/:id → 200 (leitura preservada)', async () => {
    const docId = await seedReadyDoc(DEPT_A_ID, TENANT_A);
    const token = await seedUserWithGrant('user-ro-read@empresa.com', 'USER');

    const listRes = await app.inject({
      method: 'GET',
      url: '/documents',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listRes.statusCode).toBe(200);
    const ids = (listRes.json().items as Array<{ id: string }>).map((d) => d.id);
    expect(ids).toContain(docId);

    const getRes = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(getRes.statusCode).toBe(200);
  });

  it('USER com raiz ATIVA: PATCH /documents/:id → 404 e NÃO persiste', async () => {
    const docId = await seedReadyDoc(DEPT_A_ID, TENANT_A);
    const token = await seedUserWithGrant('user-ro-patch@empresa.com', 'USER');

    const res = await app.inject({
      method: 'PATCH',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'USER nao pode editar' },
    });
    expect(res.statusCode).toBe(404);

    const rows = await testDb.db<Array<{ title: string | null }>>`
      SELECT title FROM documents WHERE id = ${docId}
    `;
    expect(rows[0]?.title ?? null).toBeNull();
  });

  it('USER com raiz ATIVA: DELETE /documents/:id → 404 e o doc continua não-deletado', async () => {
    const docId = await seedReadyDoc(DEPT_A_ID, TENANT_A);
    const token = await seedUserWithGrant('user-ro-delete@empresa.com', 'USER');

    const res = await app.inject({
      method: 'DELETE',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);

    const rows = await testDb.db<Array<{ deleted: boolean }>>`
      SELECT deleted FROM documents WHERE id = ${docId}
    `;
    expect(rows[0]?.deleted).toBe(false);
  });

  it('USER com raiz ATIVA: POST /documents/:id/reprocess → 404', async () => {
    const docId = await seedReadyDoc(DEPT_A_ID, TENANT_A);
    const token = await seedUserWithGrant('user-ro-reprocess@empresa.com', 'USER');

    const res = await app.inject({
      method: 'POST',
      url: `/documents/${docId}/reprocess`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('USER com raiz ATIVA: POST /documents/:id/suggest-indexes → 404 (guard antes de qualquer custo de IA)', async () => {
    const docId = await seedReadyDoc(DEPT_A_ID, TENANT_A);
    const token = await seedUserWithGrant('user-ro-suggest@empresa.com', 'USER');

    const res = await app.inject({
      method: 'POST',
      url: `/documents/${docId}/suggest-indexes`,
      headers: { authorization: `Bearer ${token}` },
    });
    // 404 vem do gate por papel em assertCanWriteDepartment, executado ANTES de
    // resolveAiFeatureFlags e da chamada ao LLM — nenhum custo de IA é disparado.
    expect(res.statusCode).toBe(404);
  });

  it('UPLOADER com raiz ATIVA: PATCH /documents/:id → 200 e persiste (não regrediu)', async () => {
    const docId = await seedReadyDoc(DEPT_A_ID, TENANT_A);
    const token = await seedUserWithGrant('uploader-ro-patch@empresa.com', 'UPLOADER');

    const res = await app.inject({
      method: 'PATCH',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'editado por uploader' },
    });
    expect(res.statusCode).toBe(200);

    const rows = await testDb.db<Array<{ title: string | null }>>`
      SELECT title FROM documents WHERE id = ${docId}
    `;
    expect(rows[0]?.title).toBe('editado por uploader');
  });

  it('UPLOADER com raiz ATIVA: DELETE /documents/:id → 204 e soft-delete efetivado (não regrediu)', async () => {
    const docId = await seedReadyDoc(DEPT_A_ID, TENANT_A);
    const token = await seedUserWithGrant('uploader-ro-delete@empresa.com', 'UPLOADER');

    const res = await app.inject({
      method: 'DELETE',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(204);

    const rows = await testDb.db<Array<{ deleted: boolean }>>`
      SELECT deleted FROM documents WHERE id = ${docId}
    `;
    expect(rows[0]?.deleted).toBe(true);
  });

  it('ADMIN (TENANT_ADMIN): PATCH /documents/:id → 200 (escrita sem restrição, inalterada)', async () => {
    const docId = await seedReadyDoc(DEPT_A_ID, TENANT_A);

    const res = await app.inject({
      method: 'PATCH',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { title: 'editado por admin' },
    });
    expect(res.statusCode).toBe(200);

    const rows = await testDb.db<Array<{ title: string | null }>>`
      SELECT title FROM documents WHERE id = ${docId}
    `;
    expect(rows[0]?.title).toBe('editado por admin');
  });
});

// ---------------------------------------------------------------------------
// Regressão: departamento excluído preserva acesso aos documentos órfãos.
// ---------------------------------------------------------------------------
describe('documentos órfãos — departamento soft-deletado preserva acesso', () => {
  /**
   * Cria um documento READY no departamento informado, diretamente no banco.
   * Retorna o id do documento criado.
   */
  async function seedReadyDocument(departmentId: string, tenantId: string): Promise<string> {
    const docId = newId();
    const hashB = 'b'.repeat(64);
    await testDb.db`
      INSERT INTO documents (
        id, tenant_id, department_id, document_type_id,
        filename, original_filename, content_hash, size_bytes, mime_type,
        s3_key, status, failure_reason, tags, index_values,
        uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
      ) VALUES (
        ${docId}, ${tenantId}, ${departmentId}, NULL,
        'orfao.pdf', 'orfao.pdf', ${hashB}, 1024, 'application/pdf',
        ${`tenants/${tenantId}/documents/${hashB}/orfao.pdf`}, 'READY', NULL, '{}'::text[], '{}'::jsonb,
        ${ADMIN_A_ID}, NOW(), NOW(), 0, false
      )
    `;
    return docId;
  }

  it('GET /documents/:id retorna 200 para documento cujo departamento foi excluído', async () => {
    const docId = await seedReadyDocument(DEPT_A_ID, TENANT_A);

    // Exclui o departamento via endpoint real (cascade preserva o documento)
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/departments/${DEPT_A_ID}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(delRes.statusCode).toBe(204);

    // Sanidade: departamento está soft-deletado, documento permanece vivo
    const deptRows = await testDb.db<Array<{ deleted: boolean }>>`SELECT deleted FROM departments WHERE id = ${DEPT_A_ID}`;
    expect(deptRows[0]?.deleted).toBe(true);
    const docRows = await testDb.db<Array<{ deleted: boolean }>>`SELECT deleted FROM documents WHERE id = ${docId}`;
    expect(docRows[0]?.deleted).toBe(false);

    // GET detalhe deve continuar retornando 200 (antes regredia para 404)
    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(docId);
    expect(res.json().departmentId).toBe(DEPT_A_ID);
  });

  it('GET /documents/:id/download retorna 200 para documento órfão', async () => {
    const docId = await seedReadyDocument(DEPT_A_ID, TENANT_A);

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/departments/${DEPT_A_ID}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(delRes.statusCode).toBe(204);

    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}/download`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    expect(typeof res.json().url).toBe('string');
  });

  it('PATCH /documents/:id funciona para documento órfão (não 404 por causa do depto)', async () => {
    const docId = await seedReadyDocument(DEPT_A_ID, TENANT_A);

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/departments/${DEPT_A_ID}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(delRes.statusCode).toBe(204);

    const res = await app.inject({
      method: 'PATCH',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { tags: ['revisado'] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().tags).toContain('revisado');
  });

  it('DELETE /documents/:id funciona para documento órfão (não 404 por causa do depto)', async () => {
    const docId = await seedReadyDocument(DEPT_A_ID, TENANT_A);

    const delDept = await app.inject({
      method: 'DELETE',
      url: `/departments/${DEPT_A_ID}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(delDept.statusCode).toBe(204);

    const res = await app.inject({
      method: 'DELETE',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(204);
    const docRows = await testDb.db<Array<{ deleted: boolean }>>`SELECT deleted FROM documents WHERE id = ${docId}`;
    expect(docRows[0]?.deleted).toBe(true);
  });

  it('POST /documents para departamento JÁ excluído continua retornando 404 (sem regressão)', async () => {
    // Exclui o departamento A antes de qualquer upload
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/departments/${DEPT_A_ID}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(delRes.statusCode).toBe(204);

    const { payload, headers } = buildUploadForm({ departmentId: DEPT_A_ID });

    const res = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...headers },
      payload,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// GET /documents/:id — sugestão de tipo por IA (Fase 8, Card C)
// ---------------------------------------------------------------------------

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

describe('GET /documents/:id — typeSuggestion (Fase 8)', () => {
  /**
   * Cria um documento READY em TENANT_A/DEPT_A e, opcionalmente, uma linha de
   * document_content com uma sugestão de tipo COMPLETA (incluindo os campos
   * sensíveis model/promptVersion/rawResponse) para verificar que o endpoint
   * público NÃO os expõe.
   */
  async function seedDocWithTypeSuggestion(
    typeSuggestion: Record<string, JsonValue> | null
  ): Promise<string> {
    const docId = newId();
    const hash = 'c'.repeat(64);
    await testDb.db`
      INSERT INTO documents (
        id, tenant_id, department_id, document_type_id,
        filename, original_filename, content_hash, size_bytes, mime_type,
        s3_key, status, failure_reason, tags, index_values,
        uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
      ) VALUES (
        ${docId}, ${TENANT_A}, ${DEPT_A_ID}, NULL,
        'sugestao.pdf', 'sugestao.pdf', ${hash}, 2048, 'application/pdf',
        ${`tenants/${TENANT_A}/documents/${hash}/sugestao.pdf`}, 'READY', NULL, '{}'::text[], '{}'::jsonb,
        ${ADMIN_A_ID}, NOW(), NOW(), 0, false
      )
    `;
    await testDb.db`
      INSERT INTO document_content (document_id, tenant_id, full_text, extraction, type_suggestion)
      VALUES (
        ${docId}, ${TENANT_A}, 'texto extraido',
        ${testDb.db.json({ engine: 'native', engineVersion: '1.0.0', durationMs: 10, ocrPages: [], pageCount: 3, extractedAt: new Date().toISOString() })},
        ${typeSuggestion === null ? null : testDb.db.json(typeSuggestion)}
      )
    `;
    return docId;
  }

  const FULL_SUGGESTION = {
    documentTypeId: DOC_TYPE_ID,
    documentTypeName: 'Contrato A',
    confidence: 0.87,
    model: 'gpt-4o-mini',
    promptVersion: 'type-v1',
    suggestedAt: new Date().toISOString(),
    rawResponse: { choices: [{ text: 'segredo interno' }] },
  };

  it('retorna o subconjunto seguro e NÃO vaza campos sensíveis', async () => {
    const docId = await seedDocWithTypeSuggestion(FULL_SUGGESTION);

    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.typeSuggestion).toEqual({
      documentTypeId: DOC_TYPE_ID,
      documentTypeName: 'Contrato A',
      confidence: 0.87,
    });
    // Campos sensíveis nunca aparecem no endpoint público
    expect(body.typeSuggestion).not.toHaveProperty('model');
    expect(body.typeSuggestion).not.toHaveProperty('promptVersion');
    expect(body.typeSuggestion).not.toHaveProperty('suggestedAt');
    expect(body.typeSuggestion).not.toHaveProperty('rawResponse');
    // Sanidade: o texto sensível do rawResponse não vaza em lugar nenhum
    expect(res.payload).not.toContain('segredo interno');
    expect(res.payload).not.toContain('type-v1');
  });

  it('fallback "nenhum tipo" preserva documentTypeId/Name nulos', async () => {
    const docId = await seedDocWithTypeSuggestion({
      documentTypeId: null,
      documentTypeName: null,
      confidence: 0.1,
      model: 'gpt-4o-mini',
      promptVersion: 'type-v1',
      suggestedAt: new Date().toISOString(),
      rawResponse: {},
    });

    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().typeSuggestion).toEqual({
      documentTypeId: null,
      documentTypeName: null,
      confidence: 0.1,
    });
  });

  it('documento sem sugestão (worker não rodou) → typeSuggestion: null', async () => {
    const docId = await seedDocWithTypeSuggestion(null);

    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().typeSuggestion).toBeNull();
  });

  it('usuário de outro tenant → 404, sem vazar a sugestão', async () => {
    const docId = await seedDocWithTypeSuggestion(FULL_SUGGESTION);

    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminB}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    // Nenhum vestígio da sugestão no corpo do 404
    expect(res.payload).not.toContain('typeSuggestion');
    expect(res.payload).not.toContain('Contrato A');
    expect(res.payload).not.toContain('segredo interno');
  });
});

// ---------------------------------------------------------------------------
// GET /documents/:id — texto extraído (fullText) — T-23 / GH #34
// ---------------------------------------------------------------------------

describe('GET /documents/:id — fullText (T-23)', () => {
  const SECRET_TEXT =
    'CONTRATO CONFIDENCIAL — clausula secreta do tenant A que jamais pode vazar';

  /**
   * Cria um documento READY em TENANT_A/DEPT_A. Quando `fullText` é uma string,
   * insere a linha de document_content correspondente; quando é `null`, o
   * documento fica SEM linha de document_content (simula PENDING/PROCESSING ou
   * falha sem conteúdo) — o GET deve devolver `fullText: null`.
   */
  async function seedDocWithFullText(
    fullText: string | null,
    status: 'READY' | 'PROCESSING' | 'FAILED' = 'READY'
  ): Promise<string> {
    const docId = newId();
    const hash = 'e'.repeat(64);
    await testDb.db`
      INSERT INTO documents (
        id, tenant_id, department_id, document_type_id,
        filename, original_filename, content_hash, size_bytes, mime_type,
        s3_key, status, failure_reason, tags, index_values,
        uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
      ) VALUES (
        ${docId}, ${TENANT_A}, ${DEPT_A_ID}, NULL,
        'texto.pdf', 'texto.pdf', ${hash}, 2048, 'application/pdf',
        ${`tenants/${TENANT_A}/documents/${hash}/texto.pdf`}, ${status}, NULL, '{}'::text[], '{}'::jsonb,
        ${ADMIN_A_ID}, NOW(), NOW(), 0, false
      )
    `;
    if (fullText !== null) {
      await testDb.db`
        INSERT INTO document_content (document_id, tenant_id, full_text, extraction)
        VALUES (
          ${docId}, ${TENANT_A}, ${fullText},
          ${testDb.db.json({ engine: 'native', engineVersion: '1.0.0', durationMs: 10, ocrPages: [], pageCount: 3, extractedAt: new Date().toISOString() })}
        )
      `;
    }
    return docId;
  }

  it('documento READY com texto extraído → fullText com o conteúdo completo', async () => {
    const docId = await seedDocWithFullText(SECRET_TEXT);

    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().fullText).toBe(SECRET_TEXT);
  });

  it('documento sem document_content (ainda processando) → fullText: null', async () => {
    const docId = await seedDocWithFullText(null, 'PROCESSING');

    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().fullText).toBeNull();
  });

  it('documento FAILED sem texto → fullText: null (nunca erro)', async () => {
    const docId = await seedDocWithFullText(null, 'FAILED');

    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().fullText).toBeNull();
  });

  it('usuário de outro tenant → 404, texto extraído nunca vaza', async () => {
    const docId = await seedDocWithFullText(SECRET_TEXT);

    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminB}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(res.payload).not.toContain('fullText');
    expect(res.payload).not.toContain(SECRET_TEXT);
    expect(res.payload).not.toContain('clausula secreta');
  });
});

// ---------------------------------------------------------------------------
// GET /documents/:id — sugestão automática de valores de índice (T-16, Gatilho 1)
// ---------------------------------------------------------------------------

describe('GET /documents/:id — indexSuggestion (T-16)', () => {
  /**
   * Cria um documento READY em TENANT_A/DEPT_A e, opcionalmente, uma linha de
   * document_content com uma sugestão de índice COMPLETA (incluindo os campos
   * sensíveis model/promptVersion/rawResponse) para verificar que o endpoint
   * público expõe só o subconjunto seguro (values + suggestedAt).
   */
  async function seedDocWithIndexSuggestion(
    indexSuggestion: Record<string, JsonValue> | null
  ): Promise<string> {
    const docId = newId();
    const hash = 'd'.repeat(64);
    await testDb.db`
      INSERT INTO documents (
        id, tenant_id, department_id, document_type_id,
        filename, original_filename, content_hash, size_bytes, mime_type,
        s3_key, status, failure_reason, tags, index_values,
        uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
      ) VALUES (
        ${docId}, ${TENANT_A}, ${DEPT_A_ID}, NULL,
        'idx.pdf', 'idx.pdf', ${hash}, 2048, 'application/pdf',
        ${`tenants/${TENANT_A}/documents/${hash}/idx.pdf`}, 'READY', NULL, '{}'::text[], '{}'::jsonb,
        ${ADMIN_A_ID}, NOW(), NOW(), 0, false
      )
    `;
    await testDb.db`
      INSERT INTO document_content (document_id, tenant_id, full_text, extraction, index_suggestion)
      VALUES (
        ${docId}, ${TENANT_A}, 'texto extraido',
        ${testDb.db.json({ engine: 'native', engineVersion: '1.0.0', durationMs: 10, ocrPages: [], pageCount: 3, extractedAt: new Date().toISOString() })},
        ${indexSuggestion === null ? null : testDb.db.json(indexSuggestion)}
      )
    `;
    return docId;
  }

  const SUGGESTED_AT = new Date().toISOString();
  const FULL_INDEX_SUGGESTION = {
    values: {
      'Numero do Documento': 'FAT-2026-000731',
      Vencimento: '2026-08-15',
      Valor: '3450.75',
    },
    model: 'gpt-4o-mini',
    promptVersion: 'suggest-indexes-v2',
    suggestedAt: SUGGESTED_AT,
    rawResponse: { choices: [{ text: 'segredo interno de indices' }] },
  };

  it('expõe values + suggestedAt e NÃO vaza campos sensíveis', async () => {
    const docId = await seedDocWithIndexSuggestion(FULL_INDEX_SUGGESTION);

    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.indexSuggestion).toEqual({
      values: {
        'Numero do Documento': 'FAT-2026-000731',
        Vencimento: '2026-08-15',
        Valor: '3450.75',
      },
      suggestedAt: SUGGESTED_AT,
    });
    // Campos sensíveis nunca aparecem no endpoint público
    expect(body.indexSuggestion).not.toHaveProperty('model');
    expect(body.indexSuggestion).not.toHaveProperty('promptVersion');
    expect(body.indexSuggestion).not.toHaveProperty('rawResponse');
    // Sanidade: nada sensível vaza em lugar nenhum do payload
    expect(res.payload).not.toContain('segredo interno de indices');
    expect(res.payload).not.toContain('suggest-indexes-v2');
  });

  it('sugestão sem nenhum valor válido → values: {}', async () => {
    const docId = await seedDocWithIndexSuggestion({
      values: {},
      model: 'gpt-4o-mini',
      promptVersion: 'suggest-indexes-v2',
      suggestedAt: SUGGESTED_AT,
      rawResponse: {},
    });

    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().indexSuggestion).toEqual({ values: {}, suggestedAt: SUGGESTED_AT });
  });

  it('documento sem sugestão (worker não rodou) → indexSuggestion: null', async () => {
    const docId = await seedDocWithIndexSuggestion(null);

    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().indexSuggestion).toBeNull();
  });

  it('usuário de outro tenant → 404, sem vazar a sugestão de índices', async () => {
    const docId = await seedDocWithIndexSuggestion(FULL_INDEX_SUGGESTION);

    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminB}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(res.payload).not.toContain('indexSuggestion');
    expect(res.payload).not.toContain('FAT-2026-000731');
    expect(res.payload).not.toContain('segredo interno de indices');
  });
});

// ---------------------------------------------------------------------------
// GET /documents/:id — documentTypeName (tipo da empresa E tipo global)
// ---------------------------------------------------------------------------

describe('GET /documents/:id — documentTypeName', () => {
  /** Cria um documento READY em TENANT_A/DEPT_A com o tipo informado (ou nenhum). */
  async function seedDocWithType(documentTypeId: string | null): Promise<string> {
    const docId = newId();
    const hash = crypto.randomBytes(32).toString('hex');
    await testDb.db`
      INSERT INTO documents (
        id, tenant_id, department_id, document_type_id,
        filename, original_filename, content_hash, size_bytes, mime_type,
        s3_key, status, failure_reason, tags, index_values,
        uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
      ) VALUES (
        ${docId}, ${TENANT_A}, ${DEPT_A_ID}, ${documentTypeId},
        'tipo.pdf', 'tipo.pdf', ${hash}, 1024, 'application/pdf',
        ${`tenants/${TENANT_A}/documents/${hash}/tipo.pdf`}, 'READY', NULL, '{}'::text[], '{}'::jsonb,
        ${ADMIN_A_ID}, NOW(), NOW(), 0, false
      )
    `;
    return docId;
  }

  it('resolve o nome de um tipo da empresa', async () => {
    const docId = await seedDocWithType(DOC_TYPE_ID);
    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().documentTypeName).toBe('Contrato A');
  });

  it('resolve o nome de um tipo GLOBAL (tenant_id NULL) — para admin', async () => {
    const docId = await seedDocWithType(GLOBAL_DOC_TYPE_ID);
    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().documentTypeName).toBe('Tipo Global');
  });

  it('resolve o nome de um tipo GLOBAL também para o uploader', async () => {
    const docId = await seedDocWithType(GLOBAL_DOC_TYPE_ID);
    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenUploaderA}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().documentTypeName).toBe('Tipo Global');
  });

  it('documento sem tipo → documentTypeName null', async () => {
    const docId = await seedDocWithType(null);
    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().documentTypeName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /documents/:id — titleSuggestionEnabled (valor EFETIVO, T-18)
// ---------------------------------------------------------------------------

describe('GET /documents/:id — titleSuggestionEnabled (T-18)', () => {
  afterEach(async () => {
    // `platform_settings` é um singleton que NÃO é resetado pelo `beforeEach`
    // global do arquivo (que só recria tenants/departamentos/documentos) —
    // restaura o kill switch de plataforma para não vazar estado para outros
    // testes do arquivo (mesmo padrão de `admin/platform-settings.test.ts`).
    await testDb.db`
      UPDATE platform_settings
      SET ai_classification_enabled = true, ai_title_suggestion_enabled = true, ai_index_suggestion_enabled = true
    `;
  });

  /** Cria um documento READY simples em TENANT_A/DEPT_A, sem tipo. */
  async function seedSimpleDoc(): Promise<string> {
    const docId = newId();
    const hash = crypto.randomBytes(32).toString('hex');
    await testDb.db`
      INSERT INTO documents (
        id, tenant_id, department_id, document_type_id,
        filename, original_filename, content_hash, size_bytes, mime_type,
        s3_key, status, failure_reason, tags, index_values,
        uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
      ) VALUES (
        ${docId}, ${TENANT_A}, ${DEPT_A_ID}, NULL,
        'titulo.pdf', 'titulo.pdf', ${hash}, 1024, 'application/pdf',
        ${`tenants/${TENANT_A}/documents/${hash}/titulo.pdf`}, 'READY', NULL, '{}'::text[], '{}'::jsonb,
        ${ADMIN_A_ID}, NOW(), NOW(), 0, false
      )
    `;
    return docId;
  }

  it('plataforma e empresa ligadas (default do seed) → titleSuggestionEnabled: true', async () => {
    const docId = await seedSimpleDoc();

    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().titleSuggestionEnabled).toBe(true);
  });

  it('flag desligada no NÍVEL DA EMPRESA → titleSuggestionEnabled: false', async () => {
    const docId = await seedSimpleDoc();
    await testDb.db`
      UPDATE tenants SET ai_title_suggestion_enabled = false WHERE id = ${TENANT_A}
    `;

    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().titleSuggestionEnabled).toBe(false);
  });

  it('flag desligada no NÍVEL DA PLATAFORMA (kill switch global) → titleSuggestionEnabled: false mesmo com empresa ligada', async () => {
    const docId = await seedSimpleDoc();
    await testDb.db`UPDATE platform_settings SET ai_title_suggestion_enabled = false`;

    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().titleSuggestionEnabled).toBe(false);
  });

  it('não vaza a configuração comercial separada — só o booleano efetivo final', async () => {
    const docId = await seedSimpleDoc();

    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.titleSuggestionEnabled).toBe('boolean');
    expect(body).not.toHaveProperty('platformTitleSuggestionEnabled');
    expect(body).not.toHaveProperty('tenantTitleSuggestionEnabled');
    expect(body).not.toHaveProperty('aiFlags');
  });
});

// ---------------------------------------------------------------------------
// document_events — registro imutável de upload (cobrança)
// ---------------------------------------------------------------------------

interface RawDocumentEvent {
  id: string;
  tenant_id: string;
  document_id: string | null;
  uploaded_by_id: string;
  event_type: string;
  mime_type: string;
  document_type_id: string | null;
  document_type_name: string | null;
  size_bytes: bigint;
  page_count: number | null;
  deduplicated: boolean;
  created_at: Date;
}

async function listEvents(tenantId: string): Promise<RawDocumentEvent[]> {
  return testDb.db<RawDocumentEvent[]>`
    SELECT * FROM document_events WHERE tenant_id = ${tenantId} ORDER BY created_at ASC
  `;
}

describe('POST /documents — emissão de evento em document_events', () => {
  it('upload normal gera exatamente 1 evento com deduplicated:false e documentId correto', async () => {
    const { payload, headers } = buildUploadForm({
      departmentId: DEPT_A_ID,
      documentTypeId: DOC_TYPE_ID,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...headers },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const documentId = res.json().id as string;

    const events = await listEvents(TENANT_A);
    expect(events).toHaveLength(1);

    const event = events[0]!;
    expect(event.deduplicated).toBe(false);
    expect(event.document_id).toBe(documentId);
    expect(event.tenant_id).toBe(TENANT_A);
    expect(event.uploaded_by_id).toBe(ADMIN_A_ID);
    expect(event.event_type).toBe('upload');
    expect(event.mime_type).toBe('application/pdf');
    expect(event.document_type_id).toBe(DOC_TYPE_ID);
    expect(event.document_type_name).toBe('Contrato A'); // denormalizado
    expect(Number(event.size_bytes)).toBeGreaterThan(0);
    expect(event.page_count).toBeNull(); // backfill posterior pelo worker
    // Append-only: o campo `deleted` não existe na tabela
    expect((event as unknown as Record<string, unknown>)['deleted']).toBeUndefined();
  });

  it('reenvio do mesmo arquivo (dedup) gera um SEGUNDO evento deduplicated:true para o mesmo documentId', async () => {
    const content = Buffer.from('arquivo-para-evento-dedup');
    const form1 = buildUploadForm({ content, departmentId: DEPT_A_ID });
    const form2 = buildUploadForm({ content, departmentId: DEPT_A_ID });

    const res1 = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...form1.headers },
      payload: form1.payload,
    });
    expect(res1.statusCode).toBe(201);
    const documentId = res1.json().id as string;

    const res2 = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...form2.headers },
      payload: form2.payload,
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.headers['x-deduplicated']).toBe('true');

    const events = await listEvents(TENANT_A);
    // Total de eventos = 2 (o upload original + o reenvio deduplicado)
    expect(events).toHaveLength(2);

    const [first, second] = events;
    expect(first!.deduplicated).toBe(false);
    expect(first!.document_id).toBe(documentId);

    expect(second!.deduplicated).toBe(true);
    // O evento de dedup aponta para o MESMO documento (nenhum novo doc criado)
    expect(second!.document_id).toBe(documentId);
    expect(second!.size_bytes).toBe(first!.size_bytes);
  });

  it('documento deletado NÃO remove o evento — o histórico de upload é preservado', async () => {
    const { payload, headers } = buildUploadForm({ departmentId: DEPT_A_ID });

    const res = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...headers },
      payload,
    });
    expect(res.statusCode).toBe(201);
    const documentId = res.json().id as string;

    // Confirma que o evento existe antes do delete
    const before = await listEvents(TENANT_A);
    expect(before).toHaveLength(1);

    // Exclui o documento (soft delete)
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/documents/${documentId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(delRes.statusCode).toBe(204);

    // O evento continua na tabela (consulta direta — não filtra por deleted)
    const after = await listEvents(TENANT_A);
    expect(after).toHaveLength(1);
    expect(after[0]!.document_id).toBe(documentId);
    expect(after[0]!.deduplicated).toBe(false);
  });

  it('upload rejeitado por QUOTA_EXCEEDED NÃO gera evento', async () => {
    // Cota de 1 byte — qualquer upload excede e lança antes da emissão
    await testDb.db`UPDATE tenants SET disk_quota_bytes = 1 WHERE id = ${TENANT_A}`;

    const { payload, headers } = buildUploadForm({ departmentId: DEPT_A_ID });

    const res = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...headers },
      payload,
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('QUOTA_EXCEEDED');

    // Nenhum evento foi emitido
    const events = await listEvents(TENANT_A);
    expect(events).toHaveLength(0);
  });

  it('eventos são isolados por tenant — eventos de A não aparecem ao consultar por B', async () => {
    const formA = buildUploadForm({ departmentId: DEPT_A_ID });
    const resA = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}`, ...formA.headers },
      payload: formA.payload,
    });
    expect(resA.statusCode).toBe(201);

    const formB = buildUploadForm({ departmentId: DEPT_B_ID });
    const resB = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminB}`, ...formB.headers },
      payload: formB.payload,
    });
    expect(resB.statusCode).toBe(201);

    const eventsA = await listEvents(TENANT_A);
    const eventsB = await listEvents(TENANT_B);

    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(1);
    expect(eventsA[0]!.tenant_id).toBe(TENANT_A);
    expect(eventsB[0]!.tenant_id).toBe(TENANT_B);
    // Nenhum evento de A vaza para a consulta de B e vice-versa
    expect(eventsA.every((e) => e.tenant_id === TENANT_A)).toBe(true);
    expect(eventsB.every((e) => e.tenant_id === TENANT_B)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /documents — ordenação, filtros novos (departmentIds/uploadedById) e
// paginação por cursor composto (keyset). Ver plano da tela de listagem.
// ---------------------------------------------------------------------------
describe('GET /documents — ordenação, filtros, busca textual e paginação por página', () => {
  const DEPT_A2_ID = newId();
  const USER_ANA_ID = newId();
  const USER_BRUNO_ID = newId();
  const USER_CARLA_ID = newId();

  const DOC_ALPHA_ID = newId();
  const DOC_BETA_ID = newId();
  const DOC_GAMMA_ID = newId();
  const DOC_DELTA_ID = newId();

  const BASE_TIME = new Date('2026-01-01T00:00:00.000Z').getTime();

  interface SeedDocOpts {
    id: string;
    filename: string;
    status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';
    sizeBytes: number;
    uploadedAt: Date;
    uploadedById: string;
    departmentId: string;
    documentTypeId: string | null;
    hash: string;
  }

  async function seedDoc(opts: SeedDocOpts): Promise<void> {
    await testDb.db`
      INSERT INTO documents (
        id, tenant_id, department_id, document_type_id,
        filename, original_filename, content_hash, size_bytes, mime_type,
        s3_key, status, failure_reason, tags, index_values,
        uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
      ) VALUES (
        ${opts.id}, ${TENANT_A}, ${opts.departmentId}, ${opts.documentTypeId},
        ${opts.filename}, ${opts.filename}, ${opts.hash}, ${opts.sizeBytes}, 'application/pdf',
        ${`tenants/${TENANT_A}/documents/${opts.hash}/${opts.filename}`}, ${opts.status}, NULL, '{}'::text[], '{}'::jsonb,
        ${opts.uploadedById}, ${opts.uploadedAt}, ${opts.uploadedAt}, 0, false
      )
    `;
  }

  beforeEach(async () => {
    // Segundo departamento RAIZ em Tenant A ('Comercial A' < 'Financeiro A' alfabeticamente).
    await testDb.db`
      INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
      VALUES (${DEPT_A2_ID}, ${TENANT_A}, NULL, 'Comercial A', 0, '{}'::text[], false, NOW())
    `;

    await seedUser(testDb.db, {
      id: USER_ANA_ID, tenantId: TENANT_A, email: 'ana@empresa.com',
      password: PASSWORD, role: 'UPLOADER', name: 'Ana Uploader',
    });
    await seedUser(testDb.db, {
      id: USER_BRUNO_ID, tenantId: TENANT_A, email: 'bruno@empresa.com',
      password: PASSWORD, role: 'UPLOADER', name: 'Bruno Uploader',
    });
    await seedUser(testDb.db, {
      id: USER_CARLA_ID, tenantId: TENANT_A, email: 'carla@empresa.com',
      password: PASSWORD, role: 'UPLOADER', name: 'Carla Uploader',
    });

    // filename asc: alpha < beta < delta < gamma
    // status asc:   FAILED(delta) < PENDING(beta) < READY(alpha/gamma)
    // sizeBytes asc: delta(500) < alpha(1000) < beta(2000) < gamma(3000)
    // uploadedAt asc: alpha < beta < gamma < delta
    // departmentName asc: Comercial A(gamma) < Financeiro A(alpha/beta/delta)
    // uploadedByName asc: Ana(alpha,delta) < Bruno(beta) < Carla(gamma)
    // documentTypeName asc (nulls last): Contrato A(alpha) < Tipo Global(gamma) < null(beta,delta)
    await seedDoc({
      id: DOC_ALPHA_ID, filename: 'alpha.pdf', status: 'READY', sizeBytes: 1000,
      uploadedAt: new Date(BASE_TIME + 0), uploadedById: USER_ANA_ID,
      departmentId: DEPT_A_ID, documentTypeId: DOC_TYPE_ID, hash: 'a'.repeat(64),
    });
    await seedDoc({
      id: DOC_BETA_ID, filename: 'beta.pdf', status: 'PENDING', sizeBytes: 2000,
      uploadedAt: new Date(BASE_TIME + 60_000), uploadedById: USER_BRUNO_ID,
      departmentId: DEPT_A_ID, documentTypeId: null, hash: 'b'.repeat(64),
    });
    await seedDoc({
      id: DOC_GAMMA_ID, filename: 'gamma.pdf', status: 'READY', sizeBytes: 3000,
      uploadedAt: new Date(BASE_TIME + 120_000), uploadedById: USER_CARLA_ID,
      departmentId: DEPT_A2_ID, documentTypeId: GLOBAL_DOC_TYPE_ID, hash: 'c'.repeat(64),
    });
    await seedDoc({
      id: DOC_DELTA_ID, filename: 'delta.pdf', status: 'FAILED', sizeBytes: 500,
      uploadedAt: new Date(BASE_TIME + 180_000), uploadedById: USER_ANA_ID,
      departmentId: DEPT_A_ID, documentTypeId: null, hash: 'd'.repeat(64),
    });
  });

  interface ListDocsResponse {
    items: Array<Record<string, unknown>>;
    page: number;
    pageSize: number;
    total: number;
    pageCount: number;
  }

  async function listDocs(query: string, token = tokenAdminA): Promise<ListDocsResponse> {
    const res = await app.inject({
      method: 'GET',
      url: `/documents${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as ListDocsResponse;
  }

  it('ordena por filename ASC e DESC', async () => {
    const asc = await listDocs('?sortBy=filename&sortDir=asc&pageSize=10');
    expect(asc.items.map((d) => d['id'])).toEqual([DOC_ALPHA_ID, DOC_BETA_ID, DOC_DELTA_ID, DOC_GAMMA_ID]);

    const desc = await listDocs('?sortBy=filename&sortDir=desc&pageSize=10');
    expect(desc.items.map((d) => d['id'])).toEqual([DOC_GAMMA_ID, DOC_DELTA_ID, DOC_BETA_ID, DOC_ALPHA_ID]);
  });

  it('ordena por status ASC e DESC (com empate entre dois READY, tiebreak por id)', async () => {
    const asc = await listDocs('?sortBy=status&sortDir=asc&pageSize=10');
    expect(asc.items.map((d) => d['status'])).toEqual(['FAILED', 'PENDING', 'READY', 'READY']);
    expect(asc.items[0]?.['id']).toBe(DOC_DELTA_ID);
    expect(asc.items[1]?.['id']).toBe(DOC_BETA_ID);
    expect([asc.items[2]?.['id'], asc.items[3]?.['id']].sort()).toEqual(
      [DOC_ALPHA_ID, DOC_GAMMA_ID].sort()
    );

    const desc = await listDocs('?sortBy=status&sortDir=desc&pageSize=10');
    expect(desc.items.map((d) => d['status'])).toEqual(['READY', 'READY', 'PENDING', 'FAILED']);
    expect(desc.items[2]?.['id']).toBe(DOC_BETA_ID);
    expect(desc.items[3]?.['id']).toBe(DOC_DELTA_ID);
  });

  it('ordena por sizeBytes ASC e DESC', async () => {
    const asc = await listDocs('?sortBy=sizeBytes&sortDir=asc&pageSize=10');
    expect(asc.items.map((d) => d['id'])).toEqual([DOC_DELTA_ID, DOC_ALPHA_ID, DOC_BETA_ID, DOC_GAMMA_ID]);

    const desc = await listDocs('?sortBy=sizeBytes&sortDir=desc&pageSize=10');
    expect(desc.items.map((d) => d['id'])).toEqual([DOC_GAMMA_ID, DOC_BETA_ID, DOC_ALPHA_ID, DOC_DELTA_ID]);
  });

  it('ordena por uploadedAt ASC e DESC (default da rota é uploadedAt desc)', async () => {
    const asc = await listDocs('?sortBy=uploadedAt&sortDir=asc&pageSize=10');
    expect(asc.items.map((d) => d['id'])).toEqual([DOC_ALPHA_ID, DOC_BETA_ID, DOC_GAMMA_ID, DOC_DELTA_ID]);

    const byDefault = await listDocs('?pageSize=10');
    expect(byDefault.items.map((d) => d['id'])).toEqual([DOC_DELTA_ID, DOC_GAMMA_ID, DOC_BETA_ID, DOC_ALPHA_ID]);
  });

  it('ordena por departmentName ASC e DESC', async () => {
    const asc = await listDocs('?sortBy=departmentName&sortDir=asc&pageSize=10');
    expect(asc.items[0]?.['id']).toBe(DOC_GAMMA_ID); // único doc em "Comercial A"
    expect(asc.items.slice(1).map((d) => d['id']).sort()).toEqual(
      [DOC_ALPHA_ID, DOC_BETA_ID, DOC_DELTA_ID].sort()
    );

    const desc = await listDocs('?sortBy=departmentName&sortDir=desc&pageSize=10');
    expect(desc.items[3]?.['id']).toBe(DOC_GAMMA_ID);
  });

  it('ordena por uploadedByName ASC e DESC', async () => {
    const asc = await listDocs('?sortBy=uploadedByName&sortDir=asc&pageSize=10');
    expect(asc.items[0]?.['uploadedByName']).toBe('Ana Uploader');
    expect(asc.items[3]?.['uploadedByName']).toBe('Carla Uploader');

    const desc = await listDocs('?sortBy=uploadedByName&sortDir=desc&pageSize=10');
    expect(desc.items[0]?.['uploadedByName']).toBe('Carla Uploader');
    expect(desc.items[3]?.['uploadedByName']).toBe('Ana Uploader');
  });

  it('ordena por companyName ASC e DESC entre tenants (via MTA)', async () => {
    const mtaId = newId();
    await seedUser(testDb.db, {
      id: mtaId, tenantId: null, email: 'mta-sort@plataforma.com', password: PASSWORD,
      role: 'MULTI_TENANT_ADMIN', allowedTenantIds: [TENANT_A, TENANT_B],
    });
    const mtaToken = await login('mta-sort@plataforma.com');

    const docBId = newId();
    const hashB = 'e'.repeat(64);
    await testDb.db`
      INSERT INTO documents (
        id, tenant_id, department_id, document_type_id,
        filename, original_filename, content_hash, size_bytes, mime_type,
        s3_key, status, failure_reason, tags, index_values,
        uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
      ) VALUES (
        ${docBId}, ${TENANT_B}, ${DEPT_B_ID}, NULL,
        'b-doc.pdf', 'b-doc.pdf', ${hashB}, 700, 'application/pdf',
        ${`tenants/${TENANT_B}/documents/${hashB}/b-doc.pdf`}, 'READY', NULL, '{}'::text[], '{}'::jsonb,
        ${ADMIN_B_ID}, ${new Date(BASE_TIME + 240_000)}, ${new Date(BASE_TIME + 240_000)}, 0, false
      )
    `;

    const asc = await listDocs('?sortBy=companyName&sortDir=asc&pageSize=10', mtaToken);
    expect(asc.total).toBe(5);
    // "Empresa A" < "Empresa B" — os 4 docs de A vêm antes do único de B
    expect(asc.items.slice(0, 4).map((d) => d['id']).sort()).toEqual(
      [DOC_ALPHA_ID, DOC_BETA_ID, DOC_GAMMA_ID, DOC_DELTA_ID].sort()
    );
    expect(asc.items[4]?.['id']).toBe(docBId);

    const desc = await listDocs('?sortBy=companyName&sortDir=desc&pageSize=10', mtaToken);
    expect(desc.items[0]?.['id']).toBe(docBId);
  });

  it('ordena por documentTypeName ASC e DESC, com nulos sempre por último', async () => {
    const asc = await listDocs('?sortBy=documentTypeName&sortDir=asc&pageSize=10');
    expect(asc.items[0]?.['id']).toBe(DOC_ALPHA_ID); // "Contrato A"
    expect(asc.items[1]?.['id']).toBe(DOC_GAMMA_ID); // "Tipo Global"
    expect(asc.items[2]?.['documentTypeName']).toBeNull();
    expect(asc.items[3]?.['documentTypeName']).toBeNull();
    expect(asc.items.slice(2).map((d) => d['id']).sort()).toEqual([DOC_BETA_ID, DOC_DELTA_ID].sort());

    const desc = await listDocs('?sortBy=documentTypeName&sortDir=desc&pageSize=10');
    expect(desc.items[0]?.['id']).toBe(DOC_GAMMA_ID);
    expect(desc.items[1]?.['id']).toBe(DOC_ALPHA_ID);
    expect(desc.items[2]?.['documentTypeName']).toBeNull();
    expect(desc.items[3]?.['documentTypeName']).toBeNull();
  });

  it('paginação por página: page 1 e page 2 por filename ASC sem pular/duplicar itens', async () => {
    const page1 = await listDocs('?sortBy=filename&sortDir=asc&page=1&pageSize=2');
    expect(page1.items.map((d) => d['id'])).toEqual([DOC_ALPHA_ID, DOC_BETA_ID]);
    expect(page1.page).toBe(1);
    expect(page1.pageSize).toBe(2);
    expect(page1.total).toBe(4);
    expect(page1.pageCount).toBe(2);

    const page2 = await listDocs('?sortBy=filename&sortDir=asc&page=2&pageSize=2');
    expect(page2.items.map((d) => d['id'])).toEqual([DOC_DELTA_ID, DOC_GAMMA_ID]);
    expect(page2.page).toBe(2);
    expect(page2.total).toBe(4);
    expect(page2.pageCount).toBe(2);

    const allIds = [...page1.items, ...page2.items].map((d) => d['id']);
    expect(new Set(allIds).size).toBe(4);
  });

  it('paginação por página: page 1 e page 2 por sizeBytes DESC sem pular/duplicar itens', async () => {
    const page1 = await listDocs('?sortBy=sizeBytes&sortDir=desc&page=1&pageSize=3');
    expect(page1.items.map((d) => d['id'])).toEqual([DOC_GAMMA_ID, DOC_BETA_ID, DOC_ALPHA_ID]);
    expect(page1.pageCount).toBe(2);

    const page2 = await listDocs('?sortBy=sizeBytes&sortDir=desc&page=2&pageSize=3');
    expect(page2.items.map((d) => d['id'])).toEqual([DOC_DELTA_ID]);

    const allIds = [...page1.items, ...page2.items].map((d) => d['id']);
    expect(new Set(allIds).size).toBe(4);
  });

  it('paginação por página: page 1 e page 2 por documentTypeName ASC preserva nulos por último ao virar página', async () => {
    const page1 = await listDocs('?sortBy=documentTypeName&sortDir=asc&page=1&pageSize=3');
    expect(page1.items).toHaveLength(3);
    expect(page1.items[0]?.['id']).toBe(DOC_ALPHA_ID);
    expect(page1.items[1]?.['id']).toBe(DOC_GAMMA_ID);

    const page2 = await listDocs('?sortBy=documentTypeName&sortDir=asc&page=2&pageSize=3');
    expect(page2.items).toHaveLength(1);

    const allIds = [...page1.items, ...page2.items].map((d) => d['id']);
    expect(new Set(allIds).size).toBe(4);
    expect(allIds.slice(0, 2)).toEqual([DOC_ALPHA_ID, DOC_GAMMA_ID]);
    expect(allIds.slice(2).sort()).toEqual([DOC_BETA_ID, DOC_DELTA_ID].sort());
  });

  it('página além do total retorna items vazio (200, nunca erro), com page/total/pageCount corretos', async () => {
    const res = await listDocs('?sortBy=filename&sortDir=asc&page=99&pageSize=2');
    expect(res.items).toEqual([]);
    expect(res.page).toBe(99);
    expect(res.pageSize).toBe(2);
    expect(res.total).toBe(4);
    expect(res.pageCount).toBe(2);
  });

  it('page inválido (0 ou não numérico) → 422', async () => {
    const zero = await app.inject({
      method: 'GET',
      url: '/documents?page=0',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(zero.statusCode).toBe(422);

    const notANumber = await app.inject({
      method: 'GET',
      url: '/documents?page=abc',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(notANumber.statusCode).toBe(422);
  });

  it('busca textual: match parcial e case-insensitive por nome do arquivo', async () => {
    const lower = await listDocs('?search=alph&pageSize=10');
    expect(lower.items.map((d) => d['id'])).toEqual([DOC_ALPHA_ID]);
    expect(lower.total).toBe(1);

    const upperCase = await listDocs('?search=ALPHA&pageSize=10');
    expect(upperCase.items.map((d) => d['id'])).toEqual([DOC_ALPHA_ID]);
    expect(upperCase.total).toBe(1);
  });

  it('busca textual: casa também pelo título confirmado quando o nome do arquivo não bate', async () => {
    await testDb.db`UPDATE documents SET title = 'Contrato Especial XPTO' WHERE id = ${DOC_BETA_ID}`;

    const res = await listDocs('?search=especial xpto&pageSize=10');
    expect(res.items.map((d) => d['id'])).toEqual([DOC_BETA_ID]);
    expect(res.total).toBe(1);
  });

  it('busca textual: termo com "_" não vira wildcard de caractere único do ILIKE', async () => {
    const docUnderscoreId = newId();
    const docOtherId = newId();
    await seedDoc({
      id: docUnderscoreId, filename: 'nota_fiscal.pdf', status: 'READY', sizeBytes: 100,
      uploadedAt: new Date(BASE_TIME + 300_000), uploadedById: USER_ANA_ID,
      departmentId: DEPT_A_ID, documentTypeId: null, hash: 'f'.repeat(64),
    });
    // Sem o escape, o padrão "%ta_fi%" (com "_" tratado como wildcard de 1
    // caractere) casaria também com "notaXfiscal.pdf" — precisa NÃO casar.
    await seedDoc({
      id: docOtherId, filename: 'notaXfiscal.pdf', status: 'READY', sizeBytes: 100,
      uploadedAt: new Date(BASE_TIME + 360_000), uploadedById: USER_ANA_ID,
      departmentId: DEPT_A_ID, documentTypeId: null, hash: 'g'.repeat(64),
    });

    const res = await listDocs('?search=ta_fi&pageSize=10');
    expect(res.items.map((d) => d['id'])).toEqual([docUnderscoreId]);
    expect(res.total).toBe(1);
  });

  it('busca textual: termo com "%" não vira wildcard do ILIKE', async () => {
    const docPercentId = newId();
    const docOtherId = newId();
    await seedDoc({
      id: docPercentId, filename: 'invoice100%.pdf', status: 'READY', sizeBytes: 100,
      uploadedAt: new Date(BASE_TIME + 300_000), uploadedById: USER_ANA_ID,
      departmentId: DEPT_A_ID, documentTypeId: null, hash: 'f'.repeat(64),
    });
    // Sem o escape, o padrão "%100%%" (com "%" tratado como wildcard) casaria
    // também com "invoice100X.pdf" — precisa NÃO casar.
    await seedDoc({
      id: docOtherId, filename: 'invoice100X.pdf', status: 'READY', sizeBytes: 100,
      uploadedAt: new Date(BASE_TIME + 360_000), uploadedById: USER_ANA_ID,
      departmentId: DEPT_A_ID, documentTypeId: null, hash: 'g'.repeat(64),
    });

    const res = await listDocs('?search=100%25&pageSize=10'); // "100%" URL-encoded
    expect(res.items.map((d) => d['id'])).toEqual([docPercentId]);
    expect(res.total).toBe(1);
  });

  it('busca textual combinada com filtro de status — total reflete a interseção', async () => {
    // "alpha" só casa com DOC_ALPHA_ID (status READY) — status=READY não muda
    // o resultado; status=FAILED some com ele (interseção vazia).
    const res = await listDocs('?search=alpha&status=READY&pageSize=10');
    expect(res.items.map((d) => d['id'])).toEqual([DOC_ALPHA_ID]);
    expect(res.total).toBe(1);

    const noMatch = await listDocs('?search=alpha&status=FAILED&pageSize=10');
    expect(noMatch.items).toEqual([]);
    expect(noMatch.total).toBe(0);
  });

  it('busca textual combinada com filtro de departamento — total reflete a interseção', async () => {
    // gamma.pdf está em DEPT_A2_ID; alpha/beta/delta estão em DEPT_A_ID.
    const res = await listDocs(`?search=.pdf&departmentIds=${DEPT_A2_ID}&pageSize=10`);
    expect(res.items.map((d) => d['id'])).toEqual([DOC_GAMMA_ID]);
    expect(res.total).toBe(1);
  });

  it('busca textual/total nunca vazam documento de outro tenant', async () => {
    const docBId = newId();
    const hashB = 'h'.repeat(64);
    await testDb.db`
      INSERT INTO documents (
        id, tenant_id, department_id, document_type_id,
        filename, original_filename, content_hash, size_bytes, mime_type,
        s3_key, status, failure_reason, tags, index_values,
        uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
      ) VALUES (
        ${docBId}, ${TENANT_B}, ${DEPT_B_ID}, NULL,
        'alpha-tenant-b.pdf', 'alpha-tenant-b.pdf', ${hashB}, 700, 'application/pdf',
        ${`tenants/${TENANT_B}/documents/${hashB}/alpha-tenant-b.pdf`}, 'READY', NULL, '{}'::text[], '{}'::jsonb,
        ${ADMIN_B_ID}, ${new Date(BASE_TIME + 240_000)}, ${new Date(BASE_TIME + 240_000)}, 0, false
      )
    `;

    // TENANT_ADMIN de A busca "alpha" — só enxerga o próprio (DOC_ALPHA_ID),
    // nunca o "alpha-tenant-b.pdf" da Empresa B.
    const res = await listDocs('?search=alpha&pageSize=10');
    expect(res.items.map((d) => d['id'])).toEqual([DOC_ALPHA_ID]);
    expect(res.total).toBe(1);
  });

  it('filtra por uploadedById', async () => {
    const res = await listDocs(`?uploadedById=${USER_ANA_ID}&pageSize=10`);
    expect(res.items.map((d) => d['id']).sort()).toEqual([DOC_ALPHA_ID, DOC_DELTA_ID].sort());
    expect(res.total).toBe(2);
  });

  it('filtra por departmentIds com múltiplos ids', async () => {
    const both = await listDocs(`?departmentIds=${DEPT_A_ID},${DEPT_A2_ID}&pageSize=10`);
    expect(both.total).toBe(4);

    const onlyA2 = await listDocs(`?departmentIds=${DEPT_A2_ID}&pageSize=10`);
    expect(onlyA2.items.map((d) => d['id'])).toEqual([DOC_GAMMA_ID]);
    expect(onlyA2.total).toBe(1);
  });

  it('departmentIds com id de outro tenant → 404 (nunca vaza)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/documents?departmentIds=${DEPT_B_ID}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('trocar sortBy/filtros nunca retorna documento de outro tenant ou fora do ACL do usuário', async () => {
    // UPLOADER A só tem permissão concedida na raiz DEPT_A_ID (fixture global do
    // arquivo) — nunca deve enxergar DEPT_A2_ID (gamma) nem documentos do tenant B.
    const queries = [
      '?sortBy=filename&sortDir=asc',
      '?sortBy=uploadedByName&sortDir=desc',
      '?sortBy=documentTypeName&sortDir=asc',
      `?sortBy=sizeBytes&sortDir=desc&uploadedById=${USER_CARLA_ID}`,
    ];
    for (const q of queries) {
      const res = await app.inject({
        method: 'GET',
        url: `/documents${q}`,
        headers: { authorization: `Bearer ${tokenUploaderA}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: Array<{ id: string; tenantId: string }> };
      expect(body.items.every((d) => d.tenantId === TENANT_A)).toBe(true);
      expect(body.items.some((d) => d.id === DOC_GAMMA_ID)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /documents/bulk-reassign-uploader — reatribuição em massa (SUPER_ADMIN)
// ---------------------------------------------------------------------------
describe('POST /documents/bulk-reassign-uploader', () => {
  const SUPER_ADMIN_ID = newId();
  const TARGET_USER_A_ID = newId();

  let tokenSuperAdmin: string;

  /**
   * Insere um documento diretamente via SQL (sem passar pelo upload
   * multipart) — atalho para montar fixtures desta suíte.
   */
  async function seedBulkDoc(opts: {
    id: string;
    tenantId: string;
    departmentId: string;
    uploadedById: string;
    hash: string;
    deleted?: boolean;
  }): Promise<void> {
    await testDb.db`
      INSERT INTO documents (
        id, tenant_id, department_id, document_type_id,
        filename, original_filename, content_hash, size_bytes, mime_type,
        s3_key, status, failure_reason, tags, index_values,
        uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
      ) VALUES (
        ${opts.id}, ${opts.tenantId}, ${opts.departmentId}, NULL,
        'doc.pdf', 'doc.pdf', ${opts.hash}, 1000, 'application/pdf',
        ${`tenants/${opts.tenantId}/documents/${opts.hash}/doc.pdf`}, 'READY', NULL, '{}'::text[], '{}'::jsonb,
        ${opts.uploadedById}, NOW(), NOW(), 0, ${opts.deleted ?? false}
      )
    `;
  }

  /** Insere um evento de upload diretamente, apontando para um documento já existente. */
  async function seedBulkEvent(opts: {
    tenantId: string;
    documentId: string;
    uploadedById: string;
  }): Promise<void> {
    await testDb.db`
      INSERT INTO document_events (
        id, tenant_id, document_id, uploaded_by_id, event_type,
        mime_type, document_type_id, document_type_name,
        size_bytes, page_count, deduplicated, created_at
      ) VALUES (
        ${newId()}, ${opts.tenantId}, ${opts.documentId}, ${opts.uploadedById}, 'upload',
        'application/pdf', NULL, NULL, 1000, NULL, false, NOW()
      )
    `;
  }

  beforeEach(async () => {
    await seedUser(testDb.db, {
      id: SUPER_ADMIN_ID,
      tenantId: null,
      email: 'super-bulk@dmdoc.com',
      password: PASSWORD,
      role: 'SUPER_ADMIN',
    });
    await seedUser(testDb.db, {
      id: TARGET_USER_A_ID,
      tenantId: TENANT_A,
      email: 'target-a@empresa.com',
      password: PASSWORD,
      role: 'USER',
    });

    tokenSuperAdmin = await login('super-bulk@dmdoc.com');
  });

  it('sucesso: reatribui documents e document_events atomicamente', async () => {
    const doc1 = newId();
    const doc2 = newId();
    await seedBulkDoc({ id: doc1, tenantId: TENANT_A, departmentId: DEPT_A_ID, uploadedById: ADMIN_A_ID, hash: 'e1'.repeat(32) });
    await seedBulkDoc({ id: doc2, tenantId: TENANT_A, departmentId: DEPT_A_ID, uploadedById: UPLOADER_A_ID, hash: 'e2'.repeat(32) });
    await seedBulkEvent({ tenantId: TENANT_A, documentId: doc1, uploadedById: ADMIN_A_ID });
    await seedBulkEvent({ tenantId: TENANT_A, documentId: doc2, uploadedById: UPLOADER_A_ID });

    const res = await app.inject({
      method: 'POST',
      url: '/documents/bulk-reassign-uploader',
      headers: { authorization: `Bearer ${tokenSuperAdmin}` },
      payload: { documentIds: [doc1, doc2], toUserId: TARGET_USER_A_ID },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updatedDocuments: 2, updatedEvents: 2 });

    const docs = await testDb.db<Array<{ id: string; uploaded_by_id: string }>>`
      SELECT id, uploaded_by_id FROM documents WHERE id = ANY(${[doc1, doc2]}::uuid[])
    `;
    expect(docs.every((d) => d.uploaded_by_id === TARGET_USER_A_ID)).toBe(true);

    const events = await testDb.db<Array<{ document_id: string; uploaded_by_id: string }>>`
      SELECT document_id, uploaded_by_id FROM document_events WHERE document_id = ANY(${[doc1, doc2]}::uuid[])
    `;
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.uploaded_by_id === TARGET_USER_A_ID)).toBe(true);
  });

  it('documentos de tenants diferentes → 422 ValidationError', async () => {
    const docA = newId();
    const docB = newId();
    await seedBulkDoc({ id: docA, tenantId: TENANT_A, departmentId: DEPT_A_ID, uploadedById: ADMIN_A_ID, hash: 'f1'.repeat(32) });
    await seedBulkDoc({ id: docB, tenantId: TENANT_B, departmentId: DEPT_B_ID, uploadedById: ADMIN_B_ID, hash: 'f2'.repeat(32) });

    const res = await app.inject({
      method: 'POST',
      url: '/documents/bulk-reassign-uploader',
      headers: { authorization: `Bearer ${tokenSuperAdmin}` },
      payload: { documentIds: [docA, docB], toUserId: TARGET_USER_A_ID },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('usuário destino de outro tenant → 404', async () => {
    const doc1 = newId();
    await seedBulkDoc({ id: doc1, tenantId: TENANT_A, departmentId: DEPT_A_ID, uploadedById: ADMIN_A_ID, hash: 'a1'.repeat(32) });

    const res = await app.inject({
      method: 'POST',
      url: '/documents/bulk-reassign-uploader',
      headers: { authorization: `Bearer ${tokenSuperAdmin}` },
      payload: { documentIds: [doc1], toUserId: ADMIN_B_ID }, // ADMIN_B_ID pertence a TENANT_B
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('documento inexistente ou soft-deleted → 404 (nunca revela qual)', async () => {
    const doc1 = newId();
    const deletedDoc = newId();
    await seedBulkDoc({ id: doc1, tenantId: TENANT_A, departmentId: DEPT_A_ID, uploadedById: ADMIN_A_ID, hash: 'b1'.repeat(32) });
    await seedBulkDoc({
      id: deletedDoc, tenantId: TENANT_A, departmentId: DEPT_A_ID, uploadedById: ADMIN_A_ID,
      hash: 'b2'.repeat(32), deleted: true,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/documents/bulk-reassign-uploader',
      headers: { authorization: `Bearer ${tokenSuperAdmin}` },
      payload: { documentIds: [doc1, deletedDoc], toUserId: TARGET_USER_A_ID },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('mais de 500 documentIds → 422 (rejeita antes de tocar o banco)', async () => {
    const documentIds = Array.from({ length: 501 }, () => newId());

    const res = await app.inject({
      method: 'POST',
      url: '/documents/bulk-reassign-uploader',
      headers: { authorization: `Bearer ${tokenSuperAdmin}` },
      payload: { documentIds, toUserId: TARGET_USER_A_ID },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('usuário não-SUPER_ADMIN recebe 403', async () => {
    const doc1 = newId();
    await seedBulkDoc({ id: doc1, tenantId: TENANT_A, departmentId: DEPT_A_ID, uploadedById: ADMIN_A_ID, hash: 'c1'.repeat(32) });

    const res = await app.inject({
      method: 'POST',
      url: '/documents/bulk-reassign-uploader',
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { documentIds: [doc1], toUserId: TARGET_USER_A_ID },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('registra audit log com action document.bulk_reassign_uploader', async () => {
    const doc1 = newId();
    await seedBulkDoc({ id: doc1, tenantId: TENANT_A, departmentId: DEPT_A_ID, uploadedById: ADMIN_A_ID, hash: 'd1'.repeat(32) });

    const res = await app.inject({
      method: 'POST',
      url: '/documents/bulk-reassign-uploader',
      headers: { authorization: `Bearer ${tokenSuperAdmin}` },
      payload: { documentIds: [doc1], toUserId: TARGET_USER_A_ID },
    });
    expect(res.statusCode).toBe(200);

    const logs = await testDb.db<Array<{ action: string; user_id: string; tenant_id: string; metadata: string | Record<string, unknown> }>>`
      SELECT action, user_id, tenant_id, metadata FROM audit_logs WHERE action = 'document.bulk_reassign_uploader'
    `;
    expect(logs).toHaveLength(1);
    // `metadata` (jsonb) chega como string pelo driver nesta consulta crua —
    // normaliza antes de inspecionar o conteúdo (mesmo formato inserido pelo
    // AuditLogger via JSON.stringify).
    const metadata: Record<string, unknown> =
      typeof logs[0]!.metadata === 'string' ? JSON.parse(logs[0]!.metadata) : logs[0]!.metadata;

    expect(logs[0]!.user_id).toBe(SUPER_ADMIN_ID);
    expect(logs[0]!.tenant_id).toBe(TENANT_A);
    expect(metadata['toUserId']).toBe(TARGET_USER_A_ID);
    expect(metadata['count']).toBe(1);
    expect(metadata['fromUserIds']).toEqual([ADMIN_A_ID]);
  });
});

describe('PATCH /documents/:id — título de exibição (Fase 8.1)', () => {
  /** Faz upload de um documento no departamento informado e retorna o id. */
  async function uploadDoc(token: string, departmentId: string): Promise<string> {
    const { payload, headers } = buildUploadForm({ departmentId });
    const res = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { authorization: `Bearer ${token}`, ...headers },
      payload,
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  it('no upload, title e suggestedTitle nascem null (fallback é originalFilename)', async () => {
    const docId = await uploadDoc(tokenAdminA, DEPT_A_ID);

    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.title).toBeNull();
    expect(body.suggestedTitle).toBeNull();
    expect(body.originalFilename).toBe('teste.pdf');
  });

  it('confirma um título → 200 e GET reflete o title', async () => {
    const docId = await uploadDoc(tokenAdminA, DEPT_A_ID);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { title: 'Contrato X' },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().title).toBe('Contrato X');

    const getRes = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().title).toBe('Contrato X');
  });

  it('corrige o título com um novo PATCH → GET reflete o valor mais recente', async () => {
    const docId = await uploadDoc(tokenAdminA, DEPT_A_ID);

    await app.inject({
      method: 'PATCH',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { title: 'Contrato X' },
    });

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { title: 'Contrato de Prestação de Serviços' },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().title).toBe('Contrato de Prestação de Serviços');

    const getRes = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(getRes.json().title).toBe('Contrato de Prestação de Serviços');
  });

  it('title: null limpa o título confirmado (volta ao fallback)', async () => {
    const docId = await uploadDoc(tokenAdminA, DEPT_A_ID);

    await app.inject({
      method: 'PATCH',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { title: 'Contrato X' },
    });

    const clearRes = await app.inject({
      method: 'PATCH',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { title: null },
    });
    expect(clearRes.statusCode).toBe(200);
    expect(clearRes.json().title).toBeNull();

    const getRes = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(getRes.json().title).toBeNull();
    expect(getRes.json().originalFilename).toBe('teste.pdf');
  });

  it('PATCH ausente de title NÃO altera o título já confirmado', async () => {
    const docId = await uploadDoc(tokenAdminA, DEPT_A_ID);

    await app.inject({
      method: 'PATCH',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { title: 'Contrato X' },
    });

    // PATCH que mexe só em tags — title deve permanecer inalterado
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { tags: ['revisado'] },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().title).toBe('Contrato X');
    expect(patchRes.json().tags).toContain('revisado');
  });

  it('title vazio ("") é rejeitado com 422 (min 1)', async () => {
    const docId = await uploadDoc(tokenAdminA, DEPT_A_ID);

    const res = await app.inject({
      method: 'PATCH',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { title: '' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('isolamento multi-tenant: PATCH de título em doc de outro tenant → 404', async () => {
    const docBId = await uploadDoc(tokenAdminB, DEPT_B_ID);

    const res = await app.inject({
      method: 'PATCH',
      url: `/documents/${docBId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { title: 'Título indevido' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');

    // O documento do tenant B permanece intacto (title ainda null)
    const rows = await testDb.db<Array<{ title: string | null }>>`
      SELECT title FROM documents WHERE id = ${docBId}
    `;
    expect(rows[0]?.title).toBeNull();
  });

  it('title também aparece na listagem GET /documents', async () => {
    const docId = await uploadDoc(tokenAdminA, DEPT_A_ID);
    await app.inject({
      method: 'PATCH',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { title: 'Contrato Listado' },
    });

    const listRes = await app.inject({
      method: 'GET',
      url: '/documents',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(listRes.statusCode).toBe(200);
    const items = listRes.json().items as Array<Record<string, unknown>>;
    const found = items.find((i) => i.id === docId);
    expect(found).toBeDefined();
    expect(found!.title).toBe('Contrato Listado');
    expect(found!.suggestedTitle).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /documents/:id/classify — classificação automática de tipo por IA
// (Fase 8, entregável #61). Re-sugere o tipo sob demanda; CONSULTIVO — nunca
// sobrescreve documents.document_type_id.
// ---------------------------------------------------------------------------

describe('POST /documents/:id/classify (Fase 8)', () => {
  /**
   * Monta um ChatResult fake do provedor de LLM a partir do JSON de saída.
   *
   * v3: o modelo escolhe o tipo pelo NÚMERO (`documentTypeNumber`). O campo
   * `documentTypeName` ainda é aceito como FALLBACK de resolução por nome exato —
   * ambos são opcionais aqui para cobrir os dois caminhos.
   */
  function chatResult(
    output: {
      documentTypeNumber?: number | null;
      documentTypeName?: string | null;
      confidence: number;
      suggestedTitle: string | null;
    },
    costUsd = 0.002
  ): ChatResult {
    return {
      content: JSON.stringify(output),
      model: 'gpt-4o-mini',
      usage: { promptTokens: 500, completionTokens: 20, totalTokens: 520, costUsd },
    };
  }

  /**
   * Cria um documento READY em TENANT_A/DEPT_A com conteúdo processado
   * (`document_content.full_text` presente). Opcionalmente já com um tipo manual
   * definido, para provar que a classificação NÃO o sobrescreve.
   */
  async function seedProcessedDoc(opts: {
    tenantId?: string;
    departmentId?: string;
    documentTypeId?: string | null;
    status?: string;
    withContent?: boolean;
  }): Promise<string> {
    const tenantId = opts.tenantId ?? TENANT_A;
    const departmentId = opts.departmentId ?? DEPT_A_ID;
    const documentTypeId = opts.documentTypeId ?? null;
    const status = opts.status ?? 'READY';
    const withContent = opts.withContent ?? true;
    const docId = newId();
    const hash = crypto.randomBytes(32).toString('hex');
    await testDb.db`
      INSERT INTO documents (
        id, tenant_id, department_id, document_type_id,
        filename, original_filename, content_hash, size_bytes, mime_type,
        s3_key, status, failure_reason, tags, index_values,
        uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
      ) VALUES (
        ${docId}, ${tenantId}, ${departmentId}, ${documentTypeId},
        'classify.pdf', 'classify.pdf', ${hash}, 2048, 'application/pdf',
        ${`tenants/${tenantId}/documents/${hash}/classify.pdf`}, ${status}, NULL, '{}'::text[], '{}'::jsonb,
        ${ADMIN_A_ID}, NOW(), ${status === 'READY' ? testDb.db`NOW()` : null}, 0, false
      )
    `;
    if (withContent) {
      await testDb.db`
        INSERT INTO document_content (document_id, tenant_id, full_text, extraction, cost_breakdown)
        VALUES (
          ${docId}, ${tenantId}, 'Contrato de prestação de serviços entre as partes.',
          ${testDb.db.json({ engine: 'native', engineVersion: '1.0.0', durationMs: 10, ocrPages: [], pageCount: 1, extractedAt: new Date().toISOString() })},
          ${testDb.db.json({ extractionUsd: 0, embeddingsUsd: 0.01, suggestionUsd: 0, classificationUsd: 0, totalUsd: 0.01 })}
        )
      `;
    }
    return docId;
  }

  /** Torna o tipo `Contrato A` visível para DEPT_A (entra no catálogo da IA). */
  async function makeTypeVisibleInDeptA(): Promise<void> {
    await testDb.db`
      UPDATE document_types
      SET department_ids = ${[DEPT_A_ID]}::uuid[]
      WHERE id = ${DOC_TYPE_ID}
    `;
  }

  beforeEach(() => {
    // Garante fila de retornos limpa entre testes (clearAllMocks não remove
    // valores de mockResolvedValueOnce ainda não consumidos).
    fakeLlmChat.mockReset();
  });

  it('sucesso: tipo do catálogo é sugerido, persistido e NÃO sobrescreve o tipo manual', async () => {
    await makeTypeVisibleInDeptA();
    const docId = await seedProcessedDoc({ documentTypeId: null });
    fakeLlmChat.mockResolvedValueOnce(
      chatResult({ documentTypeName: 'Contrato A', confidence: 0.9, suggestedTitle: 'Contrato de Serviço' })
    );

    const res = await app.inject({
      method: 'POST',
      url: `/documents/${docId}/classify`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.typeSuggestion.documentTypeId).toBe(DOC_TYPE_ID);
    expect(body.typeSuggestion.documentTypeName).toBe('Contrato A');
    expect(body.typeSuggestion.confidence).toBe(0.9);
    expect(body.typeSuggestion.model).toBe('gpt-4o-mini');
    expect(body.typeSuggestion.promptVersion).toBe('classify-document-type-v3');
    expect(body.typeSuggestion).not.toHaveProperty('rawResponse');
    expect(body.suggestedTitle).toBe('Contrato de Serviço');
    expect(body.costUsd).toBeCloseTo(0.002, 6);

    // Persistência: type_suggestion + suggested_title; document_type_id intacto.
    const rows = await testDb.db<
      Array<{ document_type_id: string | null; suggested_title: string | null; cost_usd_cents: number }>
    >`
      SELECT document_type_id, suggested_title, cost_usd_cents FROM documents WHERE id = ${docId}
    `;
    expect(rows[0]!.document_type_id).toBeNull(); // CONSULTIVO: nunca preenchido pela IA
    expect(rows[0]!.suggested_title).toBe('Contrato de Serviço');
    expect(rows[0]!.cost_usd_cents).toBe(1); // ceil(0.002 * 100)

    const content = await testDb.db<
      Array<{ type_suggestion: Record<string, unknown> | null; cost_breakdown: Record<string, number> | null }>
    >`
      SELECT type_suggestion, cost_breakdown FROM document_content WHERE document_id = ${docId}
    `;
    expect(content[0]!.type_suggestion!['documentTypeId']).toBe(DOC_TYPE_ID);
    expect(content[0]!.type_suggestion!['documentTypeName']).toBe('Contrato A');
    // custo mesclado: embeddings preservado, classification acumulado
    expect(content[0]!.cost_breakdown!['embeddingsUsd']).toBeCloseTo(0.01, 6);
    expect(content[0]!.cost_breakdown!['classificationUsd']).toBeCloseTo(0.002, 6);
    expect(content[0]!.cost_breakdown!['totalUsd']).toBeCloseTo(0.012, 6);
  });

  it('v3 (T-10): resolve por NÚMERO — modelo devolve documentTypeNumber, não o nome', async () => {
    // Cenário do bug T-10: o modelo escolhe pelo índice e nem precisa ecoar o
    // nome (que poderia ter qualificador/sufixo). Só há 1 tipo visível em
    // DEPT_A, então documentTypeNumber:1 → DOC_TYPE_ID.
    await makeTypeVisibleInDeptA();
    const docId = await seedProcessedDoc({ documentTypeId: null });
    fakeLlmChat.mockResolvedValueOnce(
      chatResult({ documentTypeNumber: 1, confidence: 0.9, suggestedTitle: 'Contrato de Serviço' })
    );

    const res = await app.inject({
      method: 'POST',
      url: `/documents/${docId}/classify`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.typeSuggestion.documentTypeId).toBe(DOC_TYPE_ID);
    expect(body.typeSuggestion.documentTypeName).toBe('Contrato A');
    expect(body.typeSuggestion.confidence).toBe(0.9);
    expect(body.typeSuggestion.promptVersion).toBe('classify-document-type-v3');
  });

  it('v3: número fora da faixa → nenhum tipo (sugestão null persistida)', async () => {
    await makeTypeVisibleInDeptA();
    const docId = await seedProcessedDoc({ documentTypeId: null });
    fakeLlmChat.mockResolvedValueOnce(
      chatResult({ documentTypeNumber: 99, confidence: 0.85, suggestedTitle: null })
    );

    const res = await app.inject({
      method: 'POST',
      url: `/documents/${docId}/classify`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.typeSuggestion.documentTypeId).toBeNull();
    expect(body.typeSuggestion.documentTypeName).toBeNull();
    expect(body.typeSuggestion.confidence).toBe(0);
  });

  it('não sobrescreve um tipo manual JÁ definido', async () => {
    await makeTypeVisibleInDeptA();
    const docId = await seedProcessedDoc({ documentTypeId: GLOBAL_DOC_TYPE_ID });
    fakeLlmChat.mockResolvedValueOnce(
      chatResult({ documentTypeName: 'Contrato A', confidence: 0.95, suggestedTitle: 'Novo Título' })
    );

    const res = await app.inject({
      method: 'POST',
      url: `/documents/${docId}/classify`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    // A IA sugeriu 'Contrato A' (DOC_TYPE_ID), mas o tipo manual permanece.
    expect(res.json().typeSuggestion.documentTypeId).toBe(DOC_TYPE_ID);
    const rows = await testDb.db<Array<{ document_type_id: string | null }>>`
      SELECT document_type_id FROM documents WHERE id = ${docId}
    `;
    expect(rows[0]!.document_type_id).toBe(GLOBAL_DOC_TYPE_ID);
  });

  it('nenhum tipo: LLM devolve nome fora do catálogo → sugestão null persistida', async () => {
    await makeTypeVisibleInDeptA();
    const docId = await seedProcessedDoc({ documentTypeId: null });
    fakeLlmChat.mockResolvedValueOnce(
      chatResult({ documentTypeName: 'Nota Fiscal Eletrônica', confidence: 0.8, suggestedTitle: null })
    );

    const res = await app.inject({
      method: 'POST',
      url: `/documents/${docId}/classify`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.typeSuggestion.documentTypeId).toBeNull();
    expect(body.typeSuggestion.documentTypeName).toBeNull();
    expect(body.typeSuggestion.confidence).toBe(0); // confiança zerada no fallback

    // A sugestão "nenhum tipo" é PERSISTIDA (Cenário 2 da tela de qualificação).
    const content = await testDb.db<Array<{ type_suggestion: Record<string, unknown> | null }>>`
      SELECT type_suggestion FROM document_content WHERE document_id = ${docId}
    `;
    expect(content[0]!.type_suggestion).not.toBeNull();
    expect(content[0]!.type_suggestion!['documentTypeId']).toBeNull();
  });

  it('403 quando classificação E título estão ambos desabilitados para a empresa', async () => {
    await makeTypeVisibleInDeptA();
    const docId = await seedProcessedDoc({ documentTypeId: null });
    await testDb.db`
      UPDATE tenants
      SET ai_classification_enabled = false, ai_title_suggestion_enabled = false
      WHERE id = ${TENANT_A}
    `;

    const res = await app.inject({
      method: 'POST',
      url: `/documents/${docId}/classify`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    // Nenhum custo de IA disparado: o LLM não foi chamado.
    expect(fakeLlmChat).not.toHaveBeenCalled();
  });

  it('404 para documento de outro tenant (isolamento) — sem chamar o LLM', async () => {
    await makeTypeVisibleInDeptA();
    const docId = await seedProcessedDoc({ documentTypeId: null });

    const res = await app.inject({
      method: 'POST',
      url: `/documents/${docId}/classify`,
      headers: { authorization: `Bearer ${tokenAdminB}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(fakeLlmChat).not.toHaveBeenCalled();
  });

  it('422 quando o documento ainda não foi processado (sem full_text)', async () => {
    const docId = await seedProcessedDoc({ documentTypeId: null, status: 'PENDING', withContent: false });

    const res = await app.inject({
      method: 'POST',
      url: `/documents/${docId}/classify`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(fakeLlmChat).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// GATILHO 2 (Fase 7, T-16): PATCH /documents/:id que DEFINE/TROCA o tipo dispara
// a sugestão automática de índices (aguardando, best-effort, respeitando a
// feature). CONSULTIVO: grava só `index_suggestion`, nunca valores confirmados.
// ===========================================================================
describe('PATCH /documents/:id — sugestão automática de índices ao definir tipo (Fase 7)', () => {
  /** ChatResult fake do provedor para a sugestão de índices (formato suggest-indexes-v1). */
  function suggestChatResult(
    fields: Array<{ name: string; value: string | null; confidence: number }>,
    costUsd = 0.0003
  ): ChatResult {
    return {
      content: JSON.stringify({ fields }),
      model: 'gpt-4o-mini',
      usage: { promptTokens: 300, completionTokens: 40, totalTokens: 340, costUsd },
    };
  }

  /** Cria um doc READY com conteúdo processado e SEM tipo definido. */
  async function seedProcessedDocNoType(): Promise<string> {
    const docId = newId();
    const hash = crypto.randomBytes(32).toString('hex');
    await testDb.db`
      INSERT INTO documents (
        id, tenant_id, department_id, document_type_id,
        filename, original_filename, content_hash, size_bytes, mime_type,
        s3_key, status, failure_reason, tags, index_values,
        uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
      ) VALUES (
        ${docId}, ${TENANT_A}, ${DEPT_A_ID}, ${null},
        'patch.pdf', 'patch.pdf', ${hash}, 2048, 'application/pdf',
        ${`tenants/${TENANT_A}/documents/${hash}/patch.pdf`}, 'READY', NULL, '{}'::text[], '{}'::jsonb,
        ${ADMIN_A_ID}, NOW(), NOW(), 0, false
      )
    `;
    await testDb.db`
      INSERT INTO document_content (document_id, tenant_id, full_text, extraction, cost_breakdown)
      VALUES (
        ${docId}, ${TENANT_A}, 'Contrato com o cliente ACME Ltda no valor de R$ 1.234,56.',
        ${testDb.db.json({ engine: 'native', engineVersion: '1.0.0', durationMs: 10, ocrPages: [], pageCount: 1, extractedAt: new Date().toISOString() })},
        ${testDb.db.json({ extractionUsd: 0, embeddingsUsd: 0.01, suggestionUsd: 0, classificationUsd: 0, totalUsd: 0.01 })}
      )
    `;
    return docId;
  }

  /** Adiciona campos de índice ao tipo `Contrato A` (DOC_TYPE_ID). */
  async function seedIndexFields(): Promise<void> {
    await testDb.db`
      INSERT INTO document_type_index_fields
        (id, document_type_id, name, field_type, required, ai_extraction_hint, sort_order, show_on_search, deleted)
      VALUES
        (${newId()}, ${DOC_TYPE_ID}, 'Cliente', 'TEXT', false, NULL, 0, true, false),
        (${newId()}, ${DOC_TYPE_ID}, 'Valor', 'NUMBER', false, NULL, 1, true, false)
    `;
  }

  beforeEach(() => {
    fakeLlmChat.mockReset();
  });

  it('define o tipo e retorna suggestedIndexFields (valores normalizados) na resposta', async () => {
    await seedIndexFields();
    const docId = await seedProcessedDocNoType();
    // A IA sugere "Cliente" (TEXT) e "Valor" em formato pt-BR (normalizado depois).
    fakeLlmChat.mockResolvedValueOnce(
      suggestChatResult([
        { name: 'Cliente', value: 'ACME Ltda', confidence: 0.92 },
        { name: 'Valor', value: 'R$ 1.234,56', confidence: 0.8 },
      ])
    );

    const res = await app.inject({
      method: 'PATCH',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { documentTypeId: DOC_TYPE_ID },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    // Tipo salvo (confirmado pelo usuário).
    expect(body.documentTypeId).toBe(DOC_TYPE_ID);
    // Valores sugeridos vêm na resposta, prontos para a tela de revisão.
    const fields = body.suggestedIndexFields as Array<{ name: string; value: string | null }>;
    expect(fields.map((f) => f.name)).toEqual(['Cliente', 'Valor']);
    expect(fields.find((f) => f.name === 'Cliente')?.value).toBe('ACME Ltda');
    // NUMBER pt-BR normalizado para o formato canônico.
    expect(fields.find((f) => f.name === 'Valor')?.value).toBe('1234.56');

    // CONSULTIVO: a sugestão é persistida em index_suggestion; index_values (valores
    // confirmados) permanece VAZIO — nunca é preenchido automaticamente.
    const rows = await testDb.db<
      Array<{ index_values: Record<string, unknown>; document_type_id: string | null }>
    >`SELECT index_values, document_type_id FROM documents WHERE id = ${docId}`;
    expect(rows[0]!.index_values).toEqual({});
    expect(rows[0]!.document_type_id).toBe(DOC_TYPE_ID);

    const content = await testDb.db<Array<{ index_suggestion: Record<string, unknown> | null }>>`
      SELECT index_suggestion FROM document_content WHERE document_id = ${docId}
    `;
    expect(content[0]!.index_suggestion).not.toBeNull();
    expect((content[0]!.index_suggestion!['values'] as Record<string, string>)['Cliente']).toBe('ACME Ltda');
  });

  it('respeita a feature: com index suggestion DESLIGADA, PATCH salva o tipo e NÃO sugere', async () => {
    await seedIndexFields();
    const docId = await seedProcessedDocNoType();
    await testDb.db`
      UPDATE tenants SET ai_index_suggestion_enabled = false WHERE id = ${TENANT_A}
    `;

    const res = await app.inject({
      method: 'PATCH',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { documentTypeId: DOC_TYPE_ID },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.documentTypeId).toBe(DOC_TYPE_ID);
    expect(body).not.toHaveProperty('suggestedIndexFields');
    // Feature desligada ⇒ LLM nunca chamado.
    expect(fakeLlmChat).not.toHaveBeenCalled();
  });

  it('best-effort: falha do LLM não quebra o PATCH — 200 com o tipo salvo, sem sugestão', async () => {
    await seedIndexFields();
    const docId = await seedProcessedDocNoType();
    fakeLlmChat.mockRejectedValue(new Error('provedor de LLM fora do ar'));

    const res = await app.inject({
      method: 'PATCH',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { documentTypeId: DOC_TYPE_ID },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.documentTypeId).toBe(DOC_TYPE_ID);
    expect(body).not.toHaveProperty('suggestedIndexFields');
  });

  it('NÃO dispara quando o PATCH não troca o tipo (só tags)', async () => {
    await seedIndexFields();
    const docId = await seedProcessedDocNoType();

    const res = await app.inject({
      method: 'PATCH',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { tags: ['revisado'] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('suggestedIndexFields');
    expect(fakeLlmChat).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /documents/:id/generate-tags — geração de tags por IA sob demanda
// (Fase 9 / E-3 / GH #36). CONSULTIVO: persiste document_content.suggested_tags
// e NUNCA toca documents.tags. Gated pela 4ª flag (tagGenerationEnabled).
// ---------------------------------------------------------------------------

describe('POST /documents/:id/generate-tags (Fase 9 / E-3)', () => {
  function tagsChatResult(tags: string[], costUsd = 0.0003): ChatResult {
    return {
      content: JSON.stringify({ tags }),
      model: 'gpt-4o-mini',
      usage: { promptTokens: 400, completionTokens: 30, totalTokens: 430, costUsd },
    };
  }

  /** Cria um documento READY com conteúdo processado no tenant/dept indicados. */
  async function seedDoc(opts: { tenantId?: string; departmentId?: string; withContent?: boolean } = {}): Promise<string> {
    const tenantId = opts.tenantId ?? TENANT_A;
    const departmentId = opts.departmentId ?? DEPT_A_ID;
    const withContent = opts.withContent ?? true;
    const docId = newId();
    const hash = crypto.randomBytes(32).toString('hex');
    await testDb.db`
      INSERT INTO documents (
        id, tenant_id, department_id, document_type_id,
        filename, original_filename, content_hash, size_bytes, mime_type,
        s3_key, status, failure_reason, tags, index_values,
        uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
      ) VALUES (
        ${docId}, ${tenantId}, ${departmentId}, NULL,
        'tags.pdf', 'tags.pdf', ${hash}, 2048, 'application/pdf',
        ${`tenants/${tenantId}/documents/${hash}/tags.pdf`}, 'READY', NULL, '{}'::text[], '{}'::jsonb,
        ${ADMIN_A_ID}, NOW(), NOW(), 0, false
      )
    `;
    if (withContent) {
      await testDb.db`
        INSERT INTO document_content (document_id, tenant_id, full_text, extraction, cost_breakdown)
        VALUES (
          ${docId}, ${tenantId}, 'Contrato de locação e boleto bancário no valor de R$ 1.234,56.',
          ${testDb.db.json({ engine: 'native', engineVersion: '1.0.0', durationMs: 10, ocrPages: [], pageCount: 1, extractedAt: new Date().toISOString() })},
          ${testDb.db.json({ extractionUsd: 0, embeddingsUsd: 0.01, suggestionUsd: 0, classificationUsd: 0, tagGenerationUsd: 0, totalUsd: 0.01 })}
        )
      `;
    }
    return docId;
  }

  async function setTenantTagFlag(tenantId: string, enabled: boolean): Promise<void> {
    await testDb.db`UPDATE tenants SET ai_tag_generation_enabled = ${enabled} WHERE id = ${tenantId}`;
  }

  beforeEach(() => {
    fakeLlmChat.mockReset();
  });

  afterEach(async () => {
    // Restaura o toggle para não vazar estado entre testes do mesmo arquivo.
    await setTenantTagFlag(TENANT_A, true);
  });

  it('sucesso: gera tags, persiste suggested_tags e NÃO toca documents.tags; acumula custo', async () => {
    const docId = await seedDoc();
    fakeLlmChat.mockResolvedValueOnce(tagsChatResult(['Contrato', 'Boleto', 'R$ 1.234,56']));

    const res = await app.inject({
      method: 'POST',
      url: `/documents/${docId}/generate-tags`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.suggestedTags.tags).toEqual(['Contrato', 'Boleto', 'R$ 1.234,56']);
    expect(body.costUsd).toBeCloseTo(0.0003, 6);

    // Persistiu a sugestão consultiva.
    const contentRows = await testDb.db<Array<{ suggested_tags: { tags: string[] } | null; cost_breakdown: { tagGenerationUsd: number } | null }>>`
      SELECT suggested_tags, cost_breakdown FROM document_content WHERE document_id = ${docId}
    `;
    expect(contentRows[0]!.suggested_tags!.tags).toEqual(['Contrato', 'Boleto', 'R$ 1.234,56']);
    expect(contentRows[0]!.cost_breakdown!.tagGenerationUsd).toBeCloseTo(0.0003, 6);

    // NUNCA tocou as tags confirmadas.
    const docRows = await testDb.db<Array<{ tags: string[]; cost_usd_cents: number }>>`
      SELECT tags, cost_usd_cents FROM documents WHERE id = ${docId}
    `;
    expect(docRows[0]!.tags).toEqual([]);
    expect(docRows[0]!.cost_usd_cents).toBeGreaterThan(0);
  });

  it('feature desligada para a empresa → 403 antes de qualquer custo de IA', async () => {
    const docId = await seedDoc();
    await setTenantTagFlag(TENANT_A, false);

    const res = await app.inject({
      method: 'POST',
      url: `/documents/${docId}/generate-tags`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(403);
    expect(fakeLlmChat).not.toHaveBeenCalled();
  });

  it('documento de outra empresa → 404 (nunca 403)', async () => {
    const docId = await seedDoc({ tenantId: TENANT_B, departmentId: DEPT_B_ID });

    const res = await app.inject({
      method: 'POST',
      url: `/documents/${docId}/generate-tags`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(404);
    expect(fakeLlmChat).not.toHaveBeenCalled();
  });

  it('GET /documents/:id expõe suggestedTags e tagGenerationEnabled após a geração', async () => {
    const docId = await seedDoc();
    fakeLlmChat.mockResolvedValueOnce(tagsChatResult(['Locação', 'Boleto']));

    await app.inject({
      method: 'POST',
      url: `/documents/${docId}/generate-tags`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.suggestedTags.tags).toEqual(['Locação', 'Boleto']);
    expect(body.tagGenerationEnabled).toBe(true);
    // Não vaza campos de auditoria no subconjunto público.
    expect(body.suggestedTags).not.toHaveProperty('model');
    expect(body.suggestedTags).not.toHaveProperty('rawResponse');
  });

  it('PATCH confirma as tags escolhidas em documents.tags (persistência do confirmado)', async () => {
    const docId = await seedDoc();

    const res = await app.inject({
      method: 'PATCH',
      url: `/documents/${docId}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
      payload: { tags: ['Contrato', 'Boleto'] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().tags).toEqual(['Contrato', 'Boleto']);

    const docRows = await testDb.db<Array<{ tags: string[] }>>`
      SELECT tags FROM documents WHERE id = ${docId}
    `;
    expect(docRows[0]!.tags).toEqual(['Contrato', 'Boleto']);
  });
});
