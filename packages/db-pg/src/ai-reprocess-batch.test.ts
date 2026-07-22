import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import {
  createAiReprocessBatch,
  getAiReprocessBatch,
  getAiReprocessBatchGlobal,
  getAiReprocessBatchInTenants,
  incrementAiReprocessBatchProgress,
} from './ai-reprocess-batch.js';

/**
 * Testes de integração dos helpers de lote de reprocessamento de IA em massa
 * (épico E-4 / T-24) contra um PostgreSQL real (`dmdoc_test`, com a migration
 * 0011_ai_reprocess_batch.sql aplicada).
 *
 * Cobrem: criação, contadores atômicos (done/failed), transição para
 * `completed` quando `done + failed = total`, e isolamento multi-tenant na
 * leitura (lote de outro tenant → null).
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test';

const sql: Sql = postgres(DATABASE_URL);

const TENANT_A = 'ba7c4000-0000-0000-0000-0000000000a1';
const TENANT_B = 'ba7c4000-0000-0000-0000-0000000000b2';
const USER_A = 'ba7c4000-0000-0000-0000-0000000000c3';

beforeAll(async () => {
  await sql`DELETE FROM ai_reprocess_batch WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM users WHERE id = ${USER_A}`;
  await sql`DELETE FROM tenants WHERE id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota)
    VALUES
      (${TENANT_A}, 'Empresa A (batch)', ${1_000_000}, ${10}),
      (${TENANT_B}, 'Empresa B (batch)', ${1_000_000}, ${10})
  `;
  await sql`
    INSERT INTO users (id, tenant_id, email, password_hash, name, role)
    VALUES (${USER_A}, ${TENANT_A}, 'batch-a@test.dev', 'x', 'Ator A', 'TENANT_ADMIN')
  `;
});

beforeEach(async () => {
  await sql`DELETE FROM ai_reprocess_batch WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
});

afterAll(async () => {
  await sql`DELETE FROM ai_reprocess_batch WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  await sql`DELETE FROM users WHERE id = ${USER_A}`;
  await sql`DELETE FROM tenants WHERE id IN (${TENANT_A}, ${TENANT_B})`;
  await sql.end();
});

describe('createAiReprocessBatch', () => {
  it('cria lote com status running, contadores zerados e steps preservados', async () => {
    const batch = await createAiReprocessBatch(sql, {
      tenantId: TENANT_A,
      createdBy: USER_A,
      total: 3,
      steps: ['title', 'indexes', 'tags'],
    });

    expect(batch.tenantId).toBe(TENANT_A);
    expect(batch.createdBy).toBe(USER_A);
    expect(batch.total).toBe(3);
    expect(batch.done).toBe(0);
    expect(batch.failed).toBe(0);
    expect(batch.status).toBe('running');
    expect(batch.steps).toEqual(['title', 'indexes', 'tags']);
  });
});

describe('incrementAiReprocessBatchProgress', () => {
  it('incrementa done/failed e transiciona para completed quando done + failed = total', async () => {
    const batch = await createAiReprocessBatch(sql, {
      tenantId: TENANT_A,
      createdBy: USER_A,
      total: 3,
      steps: ['title'],
    });

    await incrementAiReprocessBatchProgress(sql, TENANT_A, batch.id, 'done');
    let read = await getAiReprocessBatch(sql, TENANT_A, batch.id);
    expect(read?.done).toBe(1);
    expect(read?.failed).toBe(0);
    expect(read?.status).toBe('running');

    await incrementAiReprocessBatchProgress(sql, TENANT_A, batch.id, 'failed');
    read = await getAiReprocessBatch(sql, TENANT_A, batch.id);
    expect(read?.done).toBe(1);
    expect(read?.failed).toBe(1);
    expect(read?.status).toBe('running');

    // 3º documento fecha o lote (1 done + 1 failed + 1 done = 3 = total).
    await incrementAiReprocessBatchProgress(sql, TENANT_A, batch.id, 'done');
    read = await getAiReprocessBatch(sql, TENANT_A, batch.id);
    expect(read?.done).toBe(2);
    expect(read?.failed).toBe(1);
    expect(read?.status).toBe('completed');
  });

  it('contadores concorrentes não perdem incremento (atomicidade)', async () => {
    const batch = await createAiReprocessBatch(sql, {
      tenantId: TENANT_A,
      createdBy: USER_A,
      total: 10,
      steps: ['tags'],
    });

    await Promise.all(
      Array.from({ length: 10 }, () =>
        incrementAiReprocessBatchProgress(sql, TENANT_A, batch.id, 'done'),
      ),
    );

    const read = await getAiReprocessBatch(sql, TENANT_A, batch.id);
    expect(read?.done).toBe(10);
    expect(read?.failed).toBe(0);
    expect(read?.status).toBe('completed');
  });
});

describe('leitura escopada por tenant', () => {
  it('getAiReprocessBatch não devolve lote de outro tenant (isolamento)', async () => {
    const batch = await createAiReprocessBatch(sql, {
      tenantId: TENANT_A,
      createdBy: USER_A,
      total: 1,
      steps: ['title'],
    });

    expect(await getAiReprocessBatch(sql, TENANT_A, batch.id)).not.toBeNull();
    // Tenant B tentando ler o lote de A → null (rota mapeia para 404).
    expect(await getAiReprocessBatch(sql, TENANT_B, batch.id)).toBeNull();
  });

  it('getAiReprocessBatchGlobal (SUPER_ADMIN) enxerga qualquer tenant', async () => {
    const batch = await createAiReprocessBatch(sql, {
      tenantId: TENANT_A,
      createdBy: USER_A,
      total: 1,
      steps: ['title'],
    });
    expect((await getAiReprocessBatchGlobal(sql, batch.id))?.id).toBe(batch.id);
  });

  it('getAiReprocessBatchInTenants respeita a lista de tenants permitidos (MTA)', async () => {
    const batch = await createAiReprocessBatch(sql, {
      tenantId: TENANT_A,
      createdBy: USER_A,
      total: 1,
      steps: ['title'],
    });
    expect((await getAiReprocessBatchInTenants(sql, [TENANT_A], batch.id))?.id).toBe(batch.id);
    expect(await getAiReprocessBatchInTenants(sql, [TENANT_B], batch.id)).toBeNull();
    expect(await getAiReprocessBatchInTenants(sql, [], batch.id)).toBeNull();
  });
});
