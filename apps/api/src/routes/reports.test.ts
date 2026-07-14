import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, resetDomainTables, type TestDb } from '../test/helpers.js';
import type { S3Service } from '../services/s3.js';
import { newId } from '@dmdoc/db-pg';

// ---------------------------------------------------------------------------
// Mock S3 — nunca toca AWS real
// ---------------------------------------------------------------------------
function createMockS3(): S3Service {
  return {
    uploadFile: async () => undefined,
    getSignedDownloadUrl: async () => 'https://mock',
    deleteFile: async () => undefined,
  } as unknown as S3Service;
}

// ---------------------------------------------------------------------------
// Constantes de fixture
// ---------------------------------------------------------------------------
// UUIDs de tenant por arquivo — evita colisão no `dmdoc_test` compartilhado.
const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();
const ADMIN_A_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ADMIN_B_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SUPER_ADMIN_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const USER_X_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const USER_Y_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const DOC_TYPE_CONTRATO = 'f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1';
const DOC_TYPE_NOTA = 'f2f2f2f2-f2f2-f2f2-f2f2-f2f2f2f2f2f2';
const PASSWORD = 'senha-forte-de-teste-relatorio';

const DISK_QUOTA = 100 * 1024 * 1024;
const USER_QUOTA = 20;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
let app: FastifyInstance;
let testDb: TestDb;
let tokenAdminA: string;
let tokenAdminB: string;
let tokenSuperAdmin: string;

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
  await resetDomainTables(testDb.db);

  await testDb.db`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
    VALUES
      (${TENANT_A}, 'Empresa A', ${DISK_QUOTA}, ${USER_QUOTA}, true, NOW()),
      (${TENANT_B}, 'Empresa B', ${DISK_QUOTA}, ${USER_QUOTA}, true, NOW())
    ON CONFLICT (id) DO NOTHING
  `;

  // Tipos de documento referenciados pelos eventos (FK document_events.document_type_id).
  await testDb.db`
    INSERT INTO document_types (id, tenant_id, name, description, is_global, index_fields, deleted, created_at)
    VALUES
      (${DOC_TYPE_CONTRATO}, ${TENANT_A}, 'Contrato', NULL, false, '[]'::jsonb, false, NOW()),
      (${DOC_TYPE_NOTA}, ${TENANT_A}, 'Nota', NULL, false, '[]'::jsonb, false, NOW())
    ON CONFLICT (id) DO NOTHING
  `;

  await seedUser(testDb.db, {
    id: ADMIN_A_ID, tenantId: TENANT_A, email: 'admin-a@test.com',
    password: PASSWORD, role: 'TENANT_ADMIN',
  });
  await seedUser(testDb.db, {
    id: ADMIN_B_ID, tenantId: TENANT_B, email: 'admin-b@test.com',
    password: PASSWORD, role: 'TENANT_ADMIN',
  });
  await seedUser(testDb.db, {
    id: SUPER_ADMIN_ID, tenantId: null, email: 'super@test.com',
    password: PASSWORD, role: 'SUPER_ADMIN',
  });
  await seedUser(testDb.db, {
    id: USER_X_ID, tenantId: TENANT_A, email: 'ricardo@test.com',
    password: PASSWORD, role: 'UPLOADER', name: 'Ricardo',
  });
  await seedUser(testDb.db, {
    id: USER_Y_ID, tenantId: TENANT_A, email: 'maria@test.com',
    password: PASSWORD, role: 'UPLOADER', name: 'Maria',
  });

  tokenAdminA = await login('admin-a@test.com');
  tokenAdminB = await login('admin-b@test.com');
  tokenSuperAdmin = await login('super@test.com');
});

async function login(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  return (res.json() as { accessToken: string }).accessToken;
}

// ---------------------------------------------------------------------------
// Helper: insere um evento de upload direto na tabela append-only
// ---------------------------------------------------------------------------
interface EventInput {
  tenantId: string;
  uploadedById: string;
  mimeType: string;
  documentTypeId: string | null;
  documentTypeName: string | null;
  sizeBytes: number;
  pageCount: number | null;
  deduplicated?: boolean;
  documentId?: string | null;
  createdAt: Date;
}

async function insertEvent(input: EventInput): Promise<void> {
  const id = newId();
  // `document_events.document_id` é anulável e tem FK para documents. Nos
  // eventos sintéticos deste relatório não há documento real; o default é NULL
  // (gerar um id aleatório violaria a FK). Os testes agregam pelos campos
  // denormalizados do evento, não pelo document_id.
  const documentId = input.documentId !== undefined ? input.documentId : null;
  await testDb.db`
    INSERT INTO document_events (
      id, tenant_id, document_id, uploaded_by_id, event_type,
      mime_type, document_type_id, document_type_name,
      size_bytes, page_count, deduplicated, created_at
    ) VALUES (
      ${id},
      ${input.tenantId},
      ${documentId},
      ${input.uploadedById},
      'upload',
      ${input.mimeType},
      ${input.documentTypeId},
      ${input.documentTypeName},
      ${input.sizeBytes},
      ${input.pageCount},
      ${input.deduplicated ?? false},
      ${input.createdAt}
    )
  `;
}

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

interface UploadsReport {
  tenantId: string;
  filters: {
    dateFrom: string | null;
    dateTo: string | null;
    userIds: string[];
    mimeTypes: string[];
    documentTypeIds: string[];
    groupBy: string | null;
  };
  totals: { files: number; pages: number; sizeBytes: number };
  byFormat: Array<{ mimeType: string; files: number; pages: number; sizeBytes: number }>;
  groups: Array<{ key: string | null; label: string | null; files: number; pages: number; sizeBytes: number }>;
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

describe('GET /reports/uploads', () => {
  it('retorna 401 sem token', async () => {
    const res = await app.inject({ method: 'GET', url: '/reports/uploads' });
    expect(res.statusCode).toBe(401);
  });

  it('TENANT_ADMIN: totais e byFormat para tenant sem eventos vêm zerados/vazios', async () => {
    const res = await app.inject({
      method: 'GET', url: '/reports/uploads',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as UploadsReport;
    expect(body.tenantId).toBe(TENANT_A);
    expect(body.totals).toEqual({ files: 0, pages: 0, sizeBytes: 0 });
    expect(body.byFormat).toEqual([]);
    expect(body.groups).toEqual([]);
    expect(body.filters.groupBy).toBeNull();
  });

  it('agrega totais e byFormat sobre todos os eventos do tenant', async () => {
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_X_ID, mimeType: PDF, documentTypeId: DOC_TYPE_CONTRATO, documentTypeName: 'Contrato', sizeBytes: 1000, pageCount: 10, createdAt: new Date('2026-03-01') });
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_X_ID, mimeType: PDF, documentTypeId: DOC_TYPE_CONTRATO, documentTypeName: 'Contrato', sizeBytes: 2000, pageCount: 5, createdAt: new Date('2026-03-02') });
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_Y_ID, mimeType: DOCX, documentTypeId: DOC_TYPE_NOTA, documentTypeName: 'Nota', sizeBytes: 500, pageCount: 3, createdAt: new Date('2026-03-03') });

    const res = await app.inject({
      method: 'GET', url: '/reports/uploads',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as UploadsReport;
    expect(body.totals).toEqual({ files: 3, pages: 18, sizeBytes: 3500 });

    const pdf = body.byFormat.find((f) => f.mimeType === PDF);
    const docx = body.byFormat.find((f) => f.mimeType === DOCX);
    expect(pdf).toEqual({ mimeType: PDF, files: 2, pages: 15, sizeBytes: 3000 });
    expect(docx).toEqual({ mimeType: DOCX, files: 1, pages: 3, sizeBytes: 500 });
  });

  it('pageCount null conta como 0 mas o evento ainda soma files e sizeBytes', async () => {
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_X_ID, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 1234, pageCount: null, createdAt: new Date('2026-03-01') });
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_X_ID, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 1000, pageCount: 7, createdAt: new Date('2026-03-02') });

    const res = await app.inject({
      method: 'GET', url: '/reports/uploads',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    const body = res.json() as UploadsReport;
    // files=2, sizeBytes=2234, pages = 0 (null) + 7 = 7
    expect(body.totals).toEqual({ files: 2, pages: 7, sizeBytes: 2234 });
  });

  it('conta eventos deduplicated e de documentos deletados (sem filtro de deleted)', async () => {
    // evento normal
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_X_ID, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 100, pageCount: 1, createdAt: new Date('2026-03-01') });
    // evento deduplicado — deve contar
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_X_ID, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 100, pageCount: 1, deduplicated: true, createdAt: new Date('2026-03-02') });
    // evento cujo documento foi deletado (documentId null) — deve contar
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_X_ID, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 100, pageCount: 1, documentId: null, createdAt: new Date('2026-03-03') });

    const res = await app.inject({
      method: 'GET', url: '/reports/uploads',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    const body = res.json() as UploadsReport;
    expect(body.totals.files).toBe(3);
    expect(body.totals.sizeBytes).toBe(300);
    expect(body.totals.pages).toBe(3);
  });

  it('filtra por período (dateFrom/dateTo) sobre createdAt', async () => {
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_X_ID, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 100, pageCount: 1, createdAt: new Date('2026-01-15') });
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_X_ID, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 200, pageCount: 2, createdAt: new Date('2026-03-15') });
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_X_ID, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 400, pageCount: 4, createdAt: new Date('2026-06-15') });

    const res = await app.inject({
      method: 'GET',
      url: '/reports/uploads?dateFrom=2026-02-01&dateTo=2026-04-01',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    const body = res.json() as UploadsReport;
    expect(body.totals).toEqual({ files: 1, pages: 2, sizeBytes: 200 });
  });

  it('período inválido (dateFrom > dateTo) retorna 422', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/reports/uploads?dateFrom=2026-06-01&dateTo=2026-01-01',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(res.statusCode).toBe(422);
  });

  it('CSV de id inválido retorna 422', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/reports/uploads?userIds=nao-e-uuid',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(res.statusCode).toBe(422);
  });

  it('filtros combinados: período + usuário + formato + tipo', async () => {
    // alvo: dentro de tudo
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_X_ID, mimeType: PDF, documentTypeId: DOC_TYPE_CONTRATO, documentTypeName: 'Contrato', sizeBytes: 1000, pageCount: 10, createdAt: new Date('2026-03-10') });
    // usuário errado
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_Y_ID, mimeType: PDF, documentTypeId: DOC_TYPE_CONTRATO, documentTypeName: 'Contrato', sizeBytes: 9999, pageCount: 9, createdAt: new Date('2026-03-10') });
    // formato errado
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_X_ID, mimeType: DOCX, documentTypeId: DOC_TYPE_CONTRATO, documentTypeName: 'Contrato', sizeBytes: 9999, pageCount: 9, createdAt: new Date('2026-03-10') });
    // tipo errado
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_X_ID, mimeType: PDF, documentTypeId: DOC_TYPE_NOTA, documentTypeName: 'Nota', sizeBytes: 9999, pageCount: 9, createdAt: new Date('2026-03-10') });
    // período errado
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_X_ID, mimeType: PDF, documentTypeId: DOC_TYPE_CONTRATO, documentTypeName: 'Contrato', sizeBytes: 9999, pageCount: 9, createdAt: new Date('2026-08-10') });

    const url =
      `/reports/uploads?dateFrom=2026-01-01&dateTo=2026-06-30` +
      `&userIds=${USER_X_ID}&mimeTypes=${encodeURIComponent(PDF)}&documentTypeIds=${DOC_TYPE_CONTRATO}`;
    const res = await app.inject({
      method: 'GET', url,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as UploadsReport;
    expect(body.totals).toEqual({ files: 1, pages: 10, sizeBytes: 1000 });
    expect(body.byFormat).toEqual([{ mimeType: PDF, files: 1, pages: 10, sizeBytes: 1000 }]);
  });

  it('groupBy=format devolve groups com key=label=mimeType', async () => {
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_X_ID, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 1000, pageCount: 5, createdAt: new Date('2026-03-01') });
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_X_ID, mimeType: DOCX, documentTypeId: null, documentTypeName: null, sizeBytes: 500, pageCount: 2, createdAt: new Date('2026-03-02') });

    const res = await app.inject({
      method: 'GET', url: '/reports/uploads?groupBy=format',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    const body = res.json() as UploadsReport;
    expect(body.filters.groupBy).toBe('format');
    const pdf = body.groups.find((g) => g.key === PDF);
    expect(pdf).toEqual({ key: PDF, label: PDF, files: 1, pages: 5, sizeBytes: 1000 });
  });

  it('groupBy=user denormaliza nome do usuário; null quando não encontrado', async () => {
    const GHOST_USER = '99999999-9999-9999-9999-999999999999';
    // O evento referencia o uploader via FK (users.id). Para simular "usuário
    // não encontrado" na denormalização do nome, o ghost é um usuário
    // soft-deletado: a FK do evento é satisfeita, mas o lookup do nome no
    // relatório filtra `deleted = false`, então o label sai null.
    await testDb.db`
      INSERT INTO users (id, tenant_id, email, password_hash, name, role, active, created_at, deleted)
      VALUES (${GHOST_USER}, ${TENANT_A}, 'ghost@test.com', 'x', 'Ghost', 'USER', true, NOW(), true)
    `;
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_X_ID, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 100, pageCount: 1, createdAt: new Date('2026-03-01') });
    await insertEvent({ tenantId: TENANT_A, uploadedById: GHOST_USER, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 200, pageCount: 2, createdAt: new Date('2026-03-02') });

    const res = await app.inject({
      method: 'GET', url: '/reports/uploads?groupBy=user',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    const body = res.json() as UploadsReport;
    const ricardo = body.groups.find((g) => g.key === USER_X_ID);
    const ghost = body.groups.find((g) => g.key === GHOST_USER);
    expect(ricardo?.label).toBe('Ricardo');
    expect(ghost?.label).toBeNull();
  });

  it('groupBy=documentType usa documentTypeName do evento; key/label null sem tipo', async () => {
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_X_ID, mimeType: PDF, documentTypeId: DOC_TYPE_CONTRATO, documentTypeName: 'Contrato', sizeBytes: 1000, pageCount: 4, createdAt: new Date('2026-03-01') });
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_X_ID, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 500, pageCount: 1, createdAt: new Date('2026-03-02') });

    const res = await app.inject({
      method: 'GET', url: '/reports/uploads?groupBy=documentType',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    const body = res.json() as UploadsReport;
    const contrato = body.groups.find((g) => g.key === DOC_TYPE_CONTRATO);
    const semTipo = body.groups.find((g) => g.key === null);
    expect(contrato).toEqual({ key: DOC_TYPE_CONTRATO, label: 'Contrato', files: 1, pages: 4, sizeBytes: 1000 });
    expect(semTipo).toEqual({ key: null, label: null, files: 1, pages: 1, sizeBytes: 500 });
  });

  it('groups vazio quando groupBy ausente', async () => {
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_X_ID, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 100, pageCount: 1, createdAt: new Date('2026-03-01') });
    const res = await app.inject({
      method: 'GET', url: '/reports/uploads',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    const body = res.json() as UploadsReport;
    expect(body.groups).toEqual([]);
  });

  it('isolamento: eventos do tenant A não aparecem na consulta do tenant B', async () => {
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_X_ID, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 5000, pageCount: 50, createdAt: new Date('2026-03-01') });

    const res = await app.inject({
      method: 'GET', url: '/reports/uploads',
      headers: { authorization: `Bearer ${tokenAdminB}` },
    });
    const body = res.json() as UploadsReport;
    expect(body.tenantId).toBe(TENANT_B);
    expect(body.totals).toEqual({ files: 0, pages: 0, sizeBytes: 0 });
    expect(body.byFormat).toEqual([]);
  });

  it('TENANT_ADMIN não enxerga outro tenant via ?tenantId (param ignorado)', async () => {
    await insertEvent({ tenantId: TENANT_B, uploadedById: ADMIN_B_ID, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 7000, pageCount: 70, createdAt: new Date('2026-03-01') });

    const res = await app.inject({
      method: 'GET', url: `/reports/uploads?tenantId=${TENANT_B}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as UploadsReport;
    // param ignorado para não-SA → vê TENANT_A (vazio)
    expect(body.tenantId).toBe(TENANT_A);
    expect(body.totals.files).toBe(0);
  });

  it('SUPER_ADMIN sem tenantId retorna 409', async () => {
    const res = await app.inject({
      method: 'GET', url: '/reports/uploads',
      headers: { authorization: `Bearer ${tokenSuperAdmin}` },
    });
    expect(res.statusCode).toBe(409);
  });

  it('SUPER_ADMIN com ?tenantId vê o relatório do tenant informado', async () => {
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_X_ID, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 1000, pageCount: 10, createdAt: new Date('2026-03-01') });
    await insertEvent({ tenantId: TENANT_B, uploadedById: ADMIN_B_ID, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 9999, pageCount: 99, createdAt: new Date('2026-03-01') });

    const res = await app.inject({
      method: 'GET', url: `/reports/uploads?tenantId=${TENANT_A}`,
      headers: { authorization: `Bearer ${tokenSuperAdmin}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as UploadsReport;
    expect(body.tenantId).toBe(TENANT_A);
    expect(body.totals).toEqual({ files: 1, pages: 10, sizeBytes: 1000 });
  });
});

// ---------------------------------------------------------------------------
// GET /reports/uploaders
// ---------------------------------------------------------------------------

interface Uploader {
  id: string;
  name: string;
  email: string;
}

describe('GET /reports/uploaders', () => {
  it('retorna 401 sem token', async () => {
    const res = await app.inject({ method: 'GET', url: '/reports/uploaders' });
    expect(res.statusCode).toBe(401);
  });

  it('usuário TENANT_ADMIN com evento no tenant aparece na lista', async () => {
    await insertEvent({ tenantId: TENANT_A, uploadedById: ADMIN_A_ID, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 100, pageCount: 1, documentId: null, createdAt: new Date('2026-03-01') });

    const res = await app.inject({
      method: 'GET', url: '/reports/uploaders',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Uploader[];
    const admin = body.find((u) => u.id === ADMIN_A_ID);
    expect(admin).toEqual({ id: ADMIN_A_ID, name: expect.any(String), email: 'admin-a@test.com' });
  });

  it('TENANT_ADMIN continua vendo UPLOADER que subiu documento (nível ≤ 60)', async () => {
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_X_ID, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 100, pageCount: 1, documentId: null, createdAt: new Date('2026-03-01') });

    const res = await app.inject({
      method: 'GET', url: '/reports/uploaders',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Uploader[];
    expect(body.find((u) => u.id === USER_X_ID)).toBeDefined();
  });

  it('TENANT_ADMIN NÃO vê MULTI_TENANT_ADMIN mesmo com upload dele no tenant (hierarquia)', async () => {
    const mtaId = newId();
    await seedUser(testDb.db, {
      id: mtaId, tenantId: null, email: 'mta-uploaders@plataforma.com', password: PASSWORD,
      role: 'MULTI_TENANT_ADMIN', allowedTenantIds: [TENANT_A], name: 'MTA Uploader',
    });

    await insertEvent({ tenantId: TENANT_A, uploadedById: mtaId, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 100, pageCount: 1, documentId: null, createdAt: new Date('2026-03-01') });

    const res = await app.inject({
      method: 'GET', url: '/reports/uploaders',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Uploader[];
    // TENANT_ADMIN (60) não enxerga MULTI_TENANT_ADMIN (80): nível acima do ator.
    expect(body.find((u) => u.id === mtaId)).toBeUndefined();
  });

  it('SUPER_ADMIN VÊ o MULTI_TENANT_ADMIN uploader (nível ≤ 100)', async () => {
    const mtaId = newId();
    await seedUser(testDb.db, {
      id: mtaId, tenantId: null, email: 'mta-sa@plataforma.com', password: PASSWORD,
      role: 'MULTI_TENANT_ADMIN', allowedTenantIds: [TENANT_A], name: 'MTA Uploader',
    });

    await insertEvent({ tenantId: TENANT_A, uploadedById: mtaId, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 100, pageCount: 1, documentId: null, createdAt: new Date('2026-03-01') });

    const res = await app.inject({
      method: 'GET', url: `/reports/uploaders?tenantId=${TENANT_A}`,
      headers: { authorization: `Bearer ${tokenSuperAdmin}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Uploader[];
    expect(body.find((u) => u.id === mtaId)).toEqual({
      id: mtaId,
      name: 'MTA Uploader',
      email: 'mta-sa@plataforma.com',
    });
  });

  it('MTA VÊ outro MULTI_TENANT_ADMIN uploader (mesmo nível 80)', async () => {
    const mtaActorId = newId();
    await seedUser(testDb.db, {
      id: mtaActorId, tenantId: null, email: 'mta-actor@plataforma.com', password: PASSWORD,
      role: 'MULTI_TENANT_ADMIN', allowedTenantIds: [TENANT_A], name: 'MTA Actor',
    });
    const mtaUploaderId = newId();
    await seedUser(testDb.db, {
      id: mtaUploaderId, tenantId: null, email: 'mta-up@plataforma.com', password: PASSWORD,
      role: 'MULTI_TENANT_ADMIN', allowedTenantIds: [TENANT_A], name: 'MTA Up',
    });

    await insertEvent({ tenantId: TENANT_A, uploadedById: mtaUploaderId, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 100, pageCount: 1, documentId: null, createdAt: new Date('2026-03-01') });

    const mtaToken = await login('mta-actor@plataforma.com');
    const res = await app.inject({
      method: 'GET', url: `/reports/uploaders?tenantId=${TENANT_A}`,
      headers: { authorization: `Bearer ${mtaToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Uploader[];
    expect(body.find((u) => u.id === mtaUploaderId)).toBeDefined();
  });

  it('groupBy=user: TENANT_ADMIN mantém o grupo do MTA mas SEM o nome (label null, hierarquia)', async () => {
    const mtaId = newId();
    await seedUser(testDb.db, {
      id: mtaId, tenantId: null, email: 'mta-group@plataforma.com', password: PASSWORD,
      role: 'MULTI_TENANT_ADMIN', allowedTenantIds: [TENANT_A], name: 'MTA Group',
    });
    await insertEvent({ tenantId: TENANT_A, uploadedById: mtaId, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 300, pageCount: 3, createdAt: new Date('2026-03-01') });

    const res = await app.inject({
      method: 'GET', url: '/reports/uploads?groupBy=user',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as UploadsReport;
    const mtaGroup = body.groups.find((g) => g.key === mtaId);
    // O grupo (contagem) permanece, mas o nome do MTA não é exposto ao TENANT_ADMIN.
    expect(mtaGroup).toBeDefined();
    expect(mtaGroup?.files).toBe(1);
    expect(mtaGroup?.label).toBeNull();
  });

  it('usuário sem nenhum evento no tenant não aparece na lista', async () => {
    // USER_Y_ID nunca fez upload em nenhum teste deste bloco
    const res = await app.inject({
      method: 'GET', url: '/reports/uploaders',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Uploader[];
    expect(body.find((u) => u.id === USER_Y_ID)).toBeUndefined();
  });

  it('isolamento: evento de outro tenant não vaza para a lista deste tenant', async () => {
    await insertEvent({ tenantId: TENANT_B, uploadedById: ADMIN_B_ID, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 100, pageCount: 1, documentId: null, createdAt: new Date('2026-03-01') });

    const res = await app.inject({
      method: 'GET', url: '/reports/uploaders',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Uploader[];
    expect(body.find((u) => u.id === ADMIN_B_ID)).toBeUndefined();
  });

  it('SUPER_ADMIN sem tenantId retorna 409', async () => {
    const res = await app.inject({
      method: 'GET', url: '/reports/uploaders',
      headers: { authorization: `Bearer ${tokenSuperAdmin}` },
    });
    expect(res.statusCode).toBe(409);
  });

  it('SUPER_ADMIN com ?tenantId vê os uploaders do tenant informado', async () => {
    await insertEvent({ tenantId: TENANT_A, uploadedById: USER_X_ID, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 100, pageCount: 1, documentId: null, createdAt: new Date('2026-03-01') });

    const res = await app.inject({
      method: 'GET', url: `/reports/uploaders?tenantId=${TENANT_A}`,
      headers: { authorization: `Bearer ${tokenSuperAdmin}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Uploader[];
    expect(body.find((u) => u.id === USER_X_ID)).toBeDefined();
  });

  it('TENANT_ADMIN não enxerga uploaders de outro tenant via ?tenantId (param ignorado)', async () => {
    await insertEvent({ tenantId: TENANT_B, uploadedById: ADMIN_B_ID, mimeType: PDF, documentTypeId: null, documentTypeName: null, sizeBytes: 100, pageCount: 1, documentId: null, createdAt: new Date('2026-03-01') });

    const res = await app.inject({
      method: 'GET', url: `/reports/uploaders?tenantId=${TENANT_B}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Uploader[];
    // param ignorado para não-SA → nada de TENANT_B aparece
    expect(body.find((u) => u.id === ADMIN_B_ID)).toBeUndefined();
  });
});
