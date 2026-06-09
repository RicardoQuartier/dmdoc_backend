import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, type TestDb } from '../test/helpers.js';
import type { S3Service } from '../services/s3.js';
import { newId } from '@dmdoc/db-mongo';

// ---------------------------------------------------------------------------
// Mock S3
// ---------------------------------------------------------------------------
function createMockS3(): S3Service {
  return {
    uploadFile: async () => undefined,
    getSignedDownloadUrl: async () => 'https://mock',
    deleteFile: async () => undefined,
  } as unknown as S3Service;
}

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------
const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const ADMIN_A_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SUPER_ADMIN_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const PASSWORD = 'senha-forte-de-teste-789';

const DISK_QUOTA = 100 * 1024 * 1024; // 100 MB
const USER_QUOTA = 20;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
let app: FastifyInstance;
let testDb: TestDb;
let tokenAdminA: string;
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
  await testDb.db.collection('users').deleteMany({});
  await testDb.db.collection('tenants').deleteMany({});
  await testDb.db.collection('documents').deleteMany({});

  await testDb.db.collection('tenants').insertMany([
    { id: TENANT_A, name: 'Empresa A', diskQuotaBytes: DISK_QUOTA, userQuota: USER_QUOTA, active: true },
    { id: TENANT_B, name: 'Empresa B', diskQuotaBytes: DISK_QUOTA, userQuota: USER_QUOTA, active: true },
  ]);

  await seedUser(testDb.db, {
    id: ADMIN_A_ID, tenantId: TENANT_A, email: 'admin-a@test.com',
    password: PASSWORD, role: 'TENANT_ADMIN',
  });
  await seedUser(testDb.db, {
    id: SUPER_ADMIN_ID, tenantId: null, email: 'super@test.com',
    password: PASSWORD, role: 'SUPER_ADMIN',
  });

  const loginA = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email: 'admin-a@test.com', password: PASSWORD },
  });
  tokenAdminA = (loginA.json() as { accessToken: string }).accessToken;

  const loginSA = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email: 'super@test.com', password: PASSWORD },
  });
  tokenSuperAdmin = (loginSA.json() as { accessToken: string }).accessToken;
});

// ---------------------------------------------------------------------------
// Helper: inserir documento de teste
// ---------------------------------------------------------------------------
async function insertDocument(
  tenantId: string,
  sizeBytes: number,
  costUsdCents = 0,
  deleted = false,
  status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED' = 'READY'
): Promise<void> {
  await testDb.db.collection('documents').insertOne({
    id: newId(),
    tenantId,
    departmentId: newId(),
    documentTypeId: null,
    filename: 'test.pdf',
    originalFilename: 'test.pdf',
    contentHash: newId(),
    sizeBytes,
    mimeType: 'application/pdf',
    s3Key: `tenants/${tenantId}/test.pdf`,
    status,
    failureReason: null,
    tags: [],
    mongoContentId: null,
    indexValues: {},
    uploadedById: ADMIN_A_ID,
    uploadedAt: new Date(),
    processedAt: status === 'READY' ? new Date() : null,
    costUsdCents,
    deleted,
  });
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

describe('GET /usage', () => {
  it('retorna 401 sem token', async () => {
    const res = await app.inject({ method: 'GET', url: '/usage' });
    expect(res.statusCode).toBe(401);
  });

  it('retorna estrutura correta com valores zero para tenant sem documentos', async () => {
    const res = await app.inject({
      method: 'GET', url: '/usage',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      tenantId: string;
      disk: { usedBytes: number; quotaBytes: number; usedPercent: number };
      users: { active: number; quota: number; usedPercent: number };
      ai: { costUsdCents: number; costUsd: number };
      documents: { total: number; byStatus: Record<string, number> };
    };

    expect(body.tenantId).toBe(TENANT_A);
    expect(body.disk.usedBytes).toBe(0);
    expect(body.disk.quotaBytes).toBe(DISK_QUOTA);
    expect(body.disk.usedPercent).toBe(0);
    expect(body.users.active).toBe(1); // apenas ADMIN_A inserido
    expect(body.users.quota).toBe(USER_QUOTA);
    expect(body.ai.costUsdCents).toBe(0);
    expect(body.ai.costUsd).toBe(0);
    expect(body.documents.total).toBe(0);
  });

  it('soma corretamente o disco de documentos não deletados', async () => {
    await insertDocument(TENANT_A, 1_000_000, 0, false);
    await insertDocument(TENANT_A, 2_000_000, 0, false);
    await insertDocument(TENANT_A, 500_000, 0, true); // deletado — não conta no disco
    await insertDocument(TENANT_B, 5_000_000, 0, false); // outro tenant

    const res = await app.inject({
      method: 'GET', url: '/usage',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { disk: { usedBytes: number } };
    expect(body.disk.usedBytes).toBe(3_000_000); // 1M + 2M (excluindo deletado e outro tenant)
  });

  it('calcula usedPercent corretamente', async () => {
    await insertDocument(TENANT_A, DISK_QUOTA / 2); // 50%

    const res = await app.inject({
      method: 'GET', url: '/usage',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { disk: { usedPercent: number } };
    expect(body.disk.usedPercent).toBe(50);
  });

  it('soma custo IA incluindo documentos deletados', async () => {
    await insertDocument(TENANT_A, 1000, 150, false); // 150 cents
    await insertDocument(TENANT_A, 1000, 75, true);   // 75 cents (deletado — custo já incorrido)
    await insertDocument(TENANT_B, 1000, 999, false); // outro tenant

    const res = await app.inject({
      method: 'GET', url: '/usage',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ai: { costUsdCents: number; costUsd: number } };
    expect(body.ai.costUsdCents).toBe(225); // 150 + 75
    expect(body.ai.costUsd).toBeCloseTo(2.25);
  });

  it('agrupa documentos por status', async () => {
    await insertDocument(TENANT_A, 1000, 0, false, 'READY');
    await insertDocument(TENANT_A, 1000, 0, false, 'READY');
    await insertDocument(TENANT_A, 1000, 0, false, 'FAILED');
    await insertDocument(TENANT_A, 1000, 0, false, 'PENDING');

    const res = await app.inject({
      method: 'GET', url: '/usage',
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { documents: { total: number; byStatus: Record<string, number> } };
    expect(body.documents.total).toBe(4);
    expect(body.documents.byStatus['READY']).toBe(2);
    expect(body.documents.byStatus['FAILED']).toBe(1);
    expect(body.documents.byStatus['PENDING']).toBe(1);
  });

  it('SUPER_ADMIN sem tenantId retorna 409', async () => {
    const res = await app.inject({
      method: 'GET', url: '/usage',
      headers: { authorization: `Bearer ${tokenSuperAdmin}` },
    });
    expect(res.statusCode).toBe(409);
  });

  it('SUPER_ADMIN com ?tenantId retorna uso do tenant especificado', async () => {
    await insertDocument(TENANT_A, 1_000_000, 0, false);

    const res = await app.inject({
      method: 'GET', url: `/usage?tenantId=${TENANT_A}`,
      headers: { authorization: `Bearer ${tokenSuperAdmin}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { tenantId: string; disk: { usedBytes: number } };
    expect(body.tenantId).toBe(TENANT_A);
    expect(body.disk.usedBytes).toBe(1_000_000);
  });

  it('TENANT_ADMIN não pode ver uso de outro tenant via ?tenantId', async () => {
    await insertDocument(TENANT_B, 5_000_000, 0, false);

    const res = await app.inject({
      method: 'GET', url: `/usage?tenantId=${TENANT_B}`,
      headers: { authorization: `Bearer ${tokenAdminA}` },
    });
    // resolveTenantId ignora o param para não-SUPER_ADMIN → vê TENANT_A (0 bytes)
    expect(res.statusCode).toBe(200);
    const body = res.json() as { disk: { usedBytes: number } };
    expect(body.disk.usedBytes).toBe(0);
  });
});
