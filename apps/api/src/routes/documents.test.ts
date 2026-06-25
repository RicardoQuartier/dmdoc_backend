import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import FormData from 'form-data';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, type TestDb } from '../test/helpers.js';
import type { S3Service } from '../services/s3.js';
import { newId } from '@dmdoc/db-mongo';

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
const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
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

beforeAll(async () => {
  testDb = await startTestDb();
  mockS3 = createMockS3();
  app = await buildApp({
    config: testConfig(),
    db: testDb.db,
    queue: null, // sem Redis nos testes
    s3: mockS3,
  });
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(async () => {
  vi.clearAllMocks();

  // Limpar coleções
  await testDb.db.collection('users').deleteMany({});
  await testDb.db.collection('tenants').deleteMany({});
  await testDb.db.collection('departments').deleteMany({});
  await testDb.db.collection('document_types').deleteMany({});
  await testDb.db.collection('department_permissions').deleteMany({});
  await testDb.db.collection('documents').deleteMany({});
  await testDb.db.collection('audit_logs').deleteMany({});
  await testDb.db.collection('document_events').deleteMany({});

  // Inserir tenants
  await testDb.db.collection('tenants').insertMany([
    {
      id: TENANT_A,
      name: 'Empresa A',
      diskQuotaBytes: DISK_QUOTA,
      userQuota: 20,
      active: true,
      createdAt: new Date(),
    },
    {
      id: TENANT_B,
      name: 'Empresa B',
      diskQuotaBytes: DISK_QUOTA,
      userQuota: 20,
      active: true,
      createdAt: new Date(),
    },
  ]);

  // Inserir departamentos
  await testDb.db.collection('departments').insertMany([
    {
      id: DEPT_A_ID,
      tenantId: TENANT_A,
      parentId: null,
      name: 'Financeiro A',
      level: 0,
      tags: [],
      deleted: false,
      createdAt: new Date(),
    },
    {
      id: DEPT_B_ID,
      tenantId: TENANT_B,
      parentId: null,
      name: 'Financeiro B',
      level: 0,
      tags: [],
      deleted: false,
      createdAt: new Date(),
    },
  ]);

  // Inserir tipos de documento
  await testDb.db.collection('document_types').insertMany([
    {
      id: DOC_TYPE_ID,
      tenantId: TENANT_A,
      name: 'Contrato A',
      description: null,
      isGlobal: false,
      indexFields: [],
      deleted: false,
      createdAt: new Date(),
    },
    {
      id: GLOBAL_DOC_TYPE_ID,
      tenantId: null,
      name: 'Tipo Global',
      description: null,
      isGlobal: true,
      indexFields: [],
      deleted: false,
      createdAt: new Date(),
    },
  ]);

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
  await testDb.db.collection('department_permissions').insertOne({
    userId: UPLOADER_A_ID,
    departmentId: DEPT_A_ID,
    tenantId: TENANT_A,
    canRead: true,
    canWrite: true,
  });

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

  it('persiste documento no MongoDB com campos corretos', async () => {
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
    const doc = await testDb.db.collection('documents').findOne({ id: body.id });
    expect(doc).not.toBeNull();
    expect(doc?.tenantId).toBe(TENANT_A);
    expect(doc?.status).toBe('PENDING');
    expect(doc?.contentHash).toBe(expectedHash);
    expect(doc?.uploadedById).toBe(ADMIN_A_ID);
    expect(doc?.deleted).toBe(false);
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

    const auditLog = await testDb.db.collection('audit_logs').findOne({
      action: 'document.upload',
      tenantId: TENANT_A,
    });
    expect(auditLog).not.toBeNull();
    expect(auditLog?.resource).toBe(`documents/${body.id as string}`);
    expect(auditLog?.userId).toBe(ADMIN_A_ID);
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
    await testDb.db.collection('document_types').insertOne({
      id: typeBId,
      tenantId: TENANT_B,
      name: 'Tipo B',
      description: null,
      isGlobal: false,
      indexFields: [],
      deleted: false,
      createdAt: new Date(),
    });

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
});

describe('POST /documents — verificação de cota', () => {
  it('rejeita upload quando excede cota de disco com 422 QUOTA_EXCEEDED', async () => {
    // Configura tenant A com cota de 1 byte — qualquer upload vai exceder
    await testDb.db
      .collection('tenants')
      .updateOne({ id: TENANT_A }, { $set: { diskQuotaBytes: 1 } });

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
    await testDb.db.collection('documents').insertOne({
      id: newId(),
      tenantId: TENANT_A,
      departmentId: DEPT_A_ID,
      documentTypeId: null,
      filename: 'existente.pdf',
      originalFilename: 'existente.pdf',
      contentHash: 'a'.repeat(64),
      sizeBytes: halfQuota + 100, // ocupa mais que a metade
      mimeType: 'application/pdf',
      s3Key: 'test/key',
      status: 'READY',
      failureReason: null,
      tags: [],
      mongoContentId: null,
      indexValues: {},
      uploadedById: ADMIN_A_ID,
      uploadedAt: new Date(),
      processedAt: new Date(),
      costUsdCents: 0,
      deleted: false,
    });

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
//
// Conceder uma RAIZ dá acesso de leitura E escrita a toda a subárvore — filhos
// atuais E futuros — sem materializar os filhos em department_permissions.
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
    await testDb.db.collection('department_permissions').insertOne({
      id: newId(),
      userId: uploaderRaizId,
      departmentId: DEPT_A_ID,
      tenantId: TENANT_A,
      canRead: true,
      canWrite: true,
      deleted: false,
    });
    const tokenRaiz = await login('uploader-raiz@empresa.com');

    // 2. Filho EXISTENTE da raiz DEPT_A_ID (parentId = DEPT_A_ID, nível 1).
    const childId = newId();
    await testDb.db.collection('departments').insertOne({
      id: childId,
      tenantId: TENANT_A,
      parentId: DEPT_A_ID,
      name: 'Filho de A',
      level: 1,
      tags: [],
      deleted: false,
      createdAt: new Date(),
    });

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
    await testDb.db.collection('departments').insertOne({
      id: futureChildId,
      tenantId: TENANT_A,
      parentId: childId,
      name: 'Neto de A',
      level: 2,
      tags: [],
      deleted: false,
      createdAt: new Date(),
    });

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
    await testDb.db.collection('department_permissions').insertOne({
      id: newId(),
      userId: uploaderListId,
      departmentId: DEPT_A_ID,
      tenantId: TENANT_A,
      canRead: true,
      canWrite: true,
      deleted: false,
    });
    const tokenList = await login('uploader-list@empresa.com');

    // Filho da raiz + documento READY nesse filho (inserido direto no banco).
    const childId = newId();
    await testDb.db.collection('departments').insertOne({
      id: childId,
      tenantId: TENANT_A,
      parentId: DEPT_A_ID,
      name: 'Filho listável',
      level: 1,
      tags: [],
      deleted: false,
      createdAt: new Date(),
    });
    const docId = newId();
    await testDb.db.collection('documents').insertOne({
      id: docId,
      tenantId: TENANT_A,
      departmentId: childId,
      documentTypeId: null,
      filename: 'filho.pdf',
      originalFilename: 'filho.pdf',
      contentHash: 'c'.repeat(64),
      sizeBytes: 512,
      mimeType: 'application/pdf',
      s3Key: `tenants/${TENANT_A}/documents/${'c'.repeat(64)}/filho.pdf`,
      status: 'READY',
      failureReason: null,
      tags: [],
      mongoContentId: null,
      indexValues: {},
      uploadedById: uploaderListId,
      uploadedAt: new Date(),
      processedAt: new Date(),
      costUsdCents: 0,
      deleted: false,
    });

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
// Regressão: departamento excluído preserva acesso aos documentos órfãos.
//
// Regra de negócio: a exclusão de um departamento marca APENAS o departamento
// como deleted:true; os documentos (e department_permissions) continuam
// deleted:false. Admins precisam continuar acessando/editando esses documentos
// órfãos — os guards de ACL (assertCanReadDepartment/assertCanWriteDepartment)
// não devem exigir department.deleted === false.
// ---------------------------------------------------------------------------
describe('documentos órfãos — departamento soft-deletado preserva acesso', () => {
  /**
   * Cria um documento READY no departamento informado, diretamente no banco.
   * Retorna o id do documento criado.
   */
  async function seedReadyDocument(departmentId: string, tenantId: string): Promise<string> {
    const docId = newId();
    await testDb.db.collection('documents').insertOne({
      id: docId,
      tenantId,
      departmentId,
      documentTypeId: null,
      filename: 'orfao.pdf',
      originalFilename: 'orfao.pdf',
      contentHash: 'b'.repeat(64),
      sizeBytes: 1024,
      mimeType: 'application/pdf',
      s3Key: `tenants/${tenantId}/documents/${'b'.repeat(64)}/orfao.pdf`,
      status: 'READY',
      failureReason: null,
      tags: [],
      mongoContentId: null,
      indexValues: {},
      uploadedById: ADMIN_A_ID,
      uploadedAt: new Date(),
      processedAt: new Date(),
      costUsdCents: 0,
      deleted: false,
    });
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
    const deptDb = await testDb.db.collection('departments').findOne({ id: DEPT_A_ID });
    expect(deptDb?.deleted).toBe(true);
    const docDb = await testDb.db.collection('documents').findOne({ id: docId });
    expect(docDb?.deleted).toBe(false);

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
    const docDb = await testDb.db.collection('documents').findOne({ id: docId });
    expect(docDb?.deleted).toBe(true);
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
// document_events — registro imutável de upload (cobrança)
//
// Regra: TODO upload aceito gera exatamente 1 evento; reenvio dedup gera
// novo evento (deduplicated:true); QUOTA_EXCEEDED não gera evento; a exclusão
// do documento NÃO remove o evento; eventos são isolados por tenant.
// wiki "Histórico de eventos de upload e relatório de uso (cobrança)".
//
// A coleção document_events é consultada DIRETAMENTE (sem o TenantRepository),
// pois por regra de negócio não carrega `deleted` e não passa pelo wrapper.
// ---------------------------------------------------------------------------

interface RawDocumentEvent {
  id: string;
  tenantId: string;
  documentId: string | null;
  uploadedById: string;
  eventType: string;
  mimeType: string;
  documentTypeId: string | null;
  documentTypeName: string | null;
  sizeBytes: number;
  pageCount: number | null;
  deduplicated: boolean;
  createdAt: Date;
  deleted?: unknown;
}

async function listEvents(tenantId: string): Promise<RawDocumentEvent[]> {
  return testDb.db
    .collection<RawDocumentEvent>('document_events')
    .find({ tenantId })
    .sort({ createdAt: 1 })
    .toArray();
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
    expect(event.documentId).toBe(documentId);
    expect(event.tenantId).toBe(TENANT_A);
    expect(event.uploadedById).toBe(ADMIN_A_ID);
    expect(event.eventType).toBe('upload');
    expect(event.mimeType).toBe('application/pdf');
    expect(event.documentTypeId).toBe(DOC_TYPE_ID);
    expect(event.documentTypeName).toBe('Contrato A'); // denormalizado
    expect(event.sizeBytes).toBeGreaterThan(0);
    expect(event.pageCount).toBeNull(); // backfill posterior pelo worker
    // Append-only: NÃO carrega o campo `deleted`
    expect(event.deleted).toBeUndefined();
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
    expect(first!.documentId).toBe(documentId);

    expect(second!.deduplicated).toBe(true);
    // O evento de dedup aponta para o MESMO documento (nenhum novo doc criado)
    expect(second!.documentId).toBe(documentId);
    expect(second!.sizeBytes).toBe(first!.sizeBytes);
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

    // O evento continua na coleção (consulta direta — não filtra por deleted)
    const after = await listEvents(TENANT_A);
    expect(after).toHaveLength(1);
    expect(after[0]!.documentId).toBe(documentId);
    expect(after[0]!.deduplicated).toBe(false);
  });

  it('upload rejeitado por QUOTA_EXCEEDED NÃO gera evento', async () => {
    // Cota de 1 byte — qualquer upload excede e lança antes da emissão
    await testDb.db
      .collection('tenants')
      .updateOne({ id: TENANT_A }, { $set: { diskQuotaBytes: 1 } });

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
    expect(eventsA[0]!.tenantId).toBe(TENANT_A);
    expect(eventsB[0]!.tenantId).toBe(TENANT_B);
    // Nenhum evento de A vaza para a consulta de B e vice-versa
    expect(eventsA.every((e) => e.tenantId === TENANT_A)).toBe(true);
    expect(eventsB.every((e) => e.tenantId === TENANT_B)).toBe(true);
  });
});
