import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { EvaluatedDocumentEntriesRepository } from './evaluated-document-entries-repository.js';

/**
 * Testes de integração de `EvaluatedDocumentEntriesRepository` contra
 * PostgreSQL real (banco da execução, migrado com todas as migrations).
 *
 * Cobertura (T-155):
 * - CHECK `page_count > 0` e FK composta (usuário da MESMA empresa).
 * - Isolamento: A nunca lê, edita nem exclui linha de B.
 * - Soft delete: excluído some de findById, summary e listPaged.
 * - Filtros de período (bordas inclusivas) e de `userIds` batem com os totais.
 * - Ordenação e paginação do listPaged; before/after do update.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test';

const sql: Sql = postgres(DATABASE_URL, { onnotice: () => {} });

// UUIDs fixos e exclusivos deste arquivo.
const TENANT_A = '3e000000-0000-0000-0000-00000000000a';
const TENANT_B = '3e000000-0000-0000-0000-00000000000b';
const USER_A1 = '3e0000a1-0000-0000-0000-000000000001';
const USER_A2 = '3e0000a2-0000-0000-0000-000000000002';
const ADMIN_A = '3e0000ad-0000-0000-0000-000000000003';
const USER_B1 = '3e0000b1-0000-0000-0000-000000000004';
/** UUID bem formado que não existe em lugar nenhum. */
const MISSING_ID = '3e00ffff-0000-0000-0000-000000000000';

const repoA = new EvaluatedDocumentEntriesRepository(sql, { tenantId: TENANT_A });
const repoB = new EvaluatedDocumentEntriesRepository(sql, { tenantId: TENANT_B });

async function cleanup(): Promise<void> {
  await sql`DELETE FROM evaluated_document_entries WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`;
  // Por id também: o teste de promoção deixa um usuário com tenant_id NULL.
  await sql`DELETE FROM users
             WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})
                OR id IN (${USER_A1}, ${USER_A2}, ${ADMIN_A}, ${USER_B1})`;
  await sql`DELETE FROM tenants WHERE id IN (${TENANT_A}, ${TENANT_B})`;
}

beforeEach(async () => {
  await cleanup();
  await sql`INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active) VALUES
    (${TENANT_A}, 'Avaliados A', ${1_000_000}, ${10}, true),
    (${TENANT_B}, 'Avaliados B', ${1_000_000}, ${10}, true)`;
  await sql`INSERT INTO users (id, tenant_id, email, password_hash, name, role) VALUES
    (${USER_A1}, ${TENANT_A}, 'a1@avaliados.test', 'x', 'A1', 'USER'),
    (${USER_A2}, ${TENANT_A}, 'a2@avaliados.test', 'x', 'A2', 'UPLOADER'),
    (${ADMIN_A}, ${TENANT_A}, 'adm@avaliados.test', 'x', 'Admin A', 'TENANT_ADMIN'),
    (${USER_B1}, ${TENANT_B}, 'b1@avaliados.test', 'x', 'B1', 'USER')`;
});

afterAll(async () => {
  await cleanup();
  await sql.end();
});

/** Código SQLSTATE + constraint de um erro do postgres.js. */
async function pgError(p: Promise<unknown>): Promise<{ code?: string; constraint_name?: string }> {
  try {
    await p;
  } catch (err: unknown) {
    return err as { code?: string; constraint_name?: string };
  }
  throw new Error('esperava erro do banco, mas a operação passou');
}

describe('create / findById', () => {
  it('cria e lê de volta com data pura, tenant do contexto e autoria', async () => {
    const created = await repoA.create({
      userId: USER_A1,
      evaluatedOn: '2026-03-10',
      pageCount: 42,
      createdById: ADMIN_A,
    });

    expect(created.tenantId).toBe(TENANT_A);
    expect(created.userId).toBe(USER_A1);
    expect(created.evaluatedOn).toBe('2026-03-10');
    expect(created.pageCount).toBe(42);
    expect(created.createdById).toBe(ADMIN_A);
    expect(created.updatedById).toBeNull();
    expect(created.deleted).toBe(false);
    expect(created.deletedAt).toBeNull();
    expect(created.createdAt).toBeInstanceOf(Date);

    expect(await repoA.findById(created.id)).toEqual(created);
  });

  it('recusa contexto sem empresa (SUPER_ADMIN sem tenant)', async () => {
    const noTenant = new EvaluatedDocumentEntriesRepository(sql, null);
    await expect(noTenant.findById(MISSING_ID)).rejects.toThrow(/exige empresa/);
    await expect(noTenant.summary()).rejects.toThrow(/exige empresa/);
    await expect(
      noTenant.create({ userId: USER_A1, evaluatedOn: '2026-03-10', pageCount: 1, createdById: null }),
    ).rejects.toThrow(/exige empresa/);
    // `forTenant` deriva um repositório escopado e utilizável.
    expect((await noTenant.forTenant(TENANT_A).summary()).totals.entries).toBe(0);
  });

  it('recusa data fora de YYYY-MM-DD e devolve null para id que não é UUID', async () => {
    await expect(
      repoA.create({ userId: USER_A1, evaluatedOn: '10/03/2026', pageCount: 1, createdById: null }),
    ).rejects.toThrow(/YYYY-MM-DD/);
    expect(await repoA.findById('nao-e-uuid')).toBeNull();
    expect(await repoA.findById(MISSING_ID)).toBeNull();
  });
});

describe('restrições do banco', () => {
  it('INSERT com page_count = 0 (ou negativo) falha pelo CHECK', async () => {
    const zero = await pgError(sql`
      INSERT INTO evaluated_document_entries (tenant_id, user_id, evaluated_on, page_count)
      VALUES (${TENANT_A}, ${USER_A1}, '2026-03-10', 0)
    `);
    expect(zero.code).toBe('23514');
    expect(zero.constraint_name).toBe('evaluated_doc_entries_page_count_positive');

    const negative = await pgError(
      repoA.create({ userId: USER_A1, evaluatedOn: '2026-03-10', pageCount: -5, createdById: null }),
    );
    expect(negative.code).toBe('23514');
  });

  it('não aceita usuário inexistente (FK simples em users.id)', async () => {
    const onCreate = await pgError(
      repoA.create({ userId: MISSING_ID, evaluatedOn: '2026-03-10', pageCount: 3, createdById: ADMIN_A }),
    );
    expect(onCreate.code).toBe('23503');
    expect(onCreate.constraint_name).toBe('evaluated_document_entries_user_id_fkey');

    const entry = await repoA.create({
      userId: USER_A1,
      evaluatedOn: '2026-03-10',
      pageCount: 3,
      createdById: ADMIN_A,
    });
    const onUpdate = await pgError(repoA.update(entry.id, { userId: MISSING_ID, updatedById: ADMIN_A }));
    expect(onUpdate.code).toBe('23503');
    // A transação do update foi desfeita: a linha segue com o usuário original.
    expect((await repoA.findById(entry.id))?.userId).toBe(USER_A1);
  });

  it('promover usuário com lançamento a papel global (tenant_id = NULL) não quebra, e o lançamento segue contando', async () => {
    const entry = await repoA.create({
      userId: USER_A1,
      evaluatedOn: '2026-03-10',
      pageCount: 12,
      createdById: ADMIN_A,
    });

    // O que `PATCH /users/:id` grava ao promover a MULTI_TENANT_ADMIN.
    await sql`UPDATE users SET tenant_id = NULL, role = 'MULTI_TENANT_ADMIN' WHERE id = ${USER_A1}`;

    expect((await repoA.findById(entry.id))?.userId).toBe(USER_A1);
    const summary = await repoA.summary({ userIds: [USER_A1] });
    expect(summary.totals).toEqual({ entries: 1, pages: 12 });
    expect(summary.byUser).toEqual([{ userId: USER_A1, entries: 1, pages: 12 }]);
  });
});

describe('isolamento entre empresas', () => {
  it('A nunca lê, edita nem exclui lançamento de B', async () => {
    const a1 = await repoA.create({ userId: USER_A1, evaluatedOn: '2026-03-01', pageCount: 10, createdById: ADMIN_A });
    const a2 = await repoA.create({ userId: USER_A2, evaluatedOn: '2026-03-02', pageCount: 20, createdById: ADMIN_A });
    const b1 = await repoB.create({ userId: USER_B1, evaluatedOn: '2026-03-01', pageCount: 999, createdById: null });

    expect(await repoA.findById(b1.id)).toBeNull();

    const summaryA = await repoA.summary();
    expect(summaryA.totals).toEqual({ entries: 2, pages: 30 });
    expect(summaryA.byUser.map((r) => r.userId)).not.toContain(USER_B1);

    const pageA = await repoA.listPaged();
    expect(pageA.total).toBe(2);
    expect(pageA.items.map((i) => i.id).sort()).toEqual([a1.id, a2.id].sort());
    expect(pageA.items.every((i) => i.tenantId === TENANT_A)).toBe(true);

    // Filtro por usuário de B, visto de A, também não vaza nada.
    expect((await repoA.summary({ userIds: [USER_B1] })).totals).toEqual({ entries: 0, pages: 0 });

    expect(await repoA.update(b1.id, { pageCount: 1, updatedById: ADMIN_A })).toBeNull();
    expect(await repoA.softDelete(b1.id, ADMIN_A)).toBeNull();

    const stillB = await repoB.findById(b1.id);
    expect(stillB?.pageCount).toBe(999);
    expect(stillB?.deleted).toBe(false);
    expect((await repoB.summary()).totals).toEqual({ entries: 1, pages: 999 });
  });
});

describe('soft delete', () => {
  it('excluído some de findById, summary e listPaged, mas a linha permanece', async () => {
    const e1 = await repoA.create({ userId: USER_A1, evaluatedOn: '2026-04-01', pageCount: 5, createdById: ADMIN_A });
    const e2 = await repoA.create({ userId: USER_A1, evaluatedOn: '2026-04-02', pageCount: 7, createdById: ADMIN_A });

    const deleted = await repoA.softDelete(e1.id, ADMIN_A);
    expect(deleted?.deleted).toBe(true);
    expect(deleted?.deletedById).toBe(ADMIN_A);
    expect(deleted?.deletedAt).toBeInstanceOf(Date);
    // Campos de negócio preservados — é o `before` que a API audita.
    expect(deleted?.pageCount).toBe(5);
    expect(deleted?.evaluatedOn).toBe('2026-04-01');

    expect(await repoA.findById(e1.id)).toBeNull();

    const summary = await repoA.summary();
    expect(summary.totals).toEqual({ entries: 1, pages: 7 });
    expect(summary.byUser).toEqual([{ userId: USER_A1, entries: 1, pages: 7 }]);

    const page = await repoA.listPaged();
    expect(page.total).toBe(1);
    expect(page.items.map((i) => i.id)).toEqual([e2.id]);

    // Segunda exclusão e edição do excluído → null (404 na API).
    expect(await repoA.softDelete(e1.id, ADMIN_A)).toBeNull();
    expect(await repoA.update(e1.id, { pageCount: 99, updatedById: ADMIN_A })).toBeNull();

    // Nada é apagado fisicamente.
    const raw = await sql<Array<{ deleted: boolean; page_count: number }>>`
      SELECT deleted, page_count FROM evaluated_document_entries WHERE id = ${e1.id}
    `;
    expect(raw).toEqual([{ deleted: true, page_count: 5 }]);
  });
});

describe('filtros de período e usuário', () => {
  beforeEach(async () => {
    const seed: Array<[string, string, number]> = [
      [USER_A1, '2026-01-31', 10],
      [USER_A1, '2026-02-01', 20],
      [USER_A2, '2026-02-15', 30],
      [USER_A1, '2026-02-28', 40],
      [USER_A2, '2026-03-01', 50],
    ];
    for (const [userId, evaluatedOn, pageCount] of seed) {
      await repoA.create({ userId, evaluatedOn, pageCount, createdById: ADMIN_A });
    }
  });

  it('período com bordas inclusivas', async () => {
    const feb = await repoA.summary({ dateFrom: '2026-02-01', dateTo: '2026-02-28' });
    expect(feb.totals).toEqual({ entries: 3, pages: 90 });
    // Páginas DESC.
    expect(feb.byUser).toEqual([
      { userId: USER_A1, entries: 2, pages: 60 },
      { userId: USER_A2, entries: 1, pages: 30 },
    ]);

    const febPage = await repoA.listPaged({ dateFrom: '2026-02-01', dateTo: '2026-02-28' });
    expect(febPage.total).toBe(3);
    expect(febPage.items.map((i) => i.evaluatedOn)).toEqual(['2026-02-28', '2026-02-15', '2026-02-01']);

    // Borda única: dateFrom = dateTo pega exatamente o dia.
    expect((await repoA.summary({ dateFrom: '2026-02-28', dateTo: '2026-02-28' })).totals).toEqual({
      entries: 1,
      pages: 40,
    });
    // Só um dos lados do intervalo.
    expect((await repoA.summary({ dateFrom: '2026-02-28' })).totals).toEqual({ entries: 2, pages: 90 });
    expect((await repoA.summary({ dateTo: '2026-01-31' })).totals).toEqual({ entries: 1, pages: 10 });
  });

  it('userIds filtra e combina com o período', async () => {
    expect((await repoA.summary({ userIds: [USER_A2] })).totals).toEqual({ entries: 2, pages: 80 });
    expect((await repoA.summary({ userIds: [USER_A1, USER_A2] })).totals).toEqual({
      entries: 5,
      pages: 150,
    });

    const combined = { dateFrom: '2026-02-01', dateTo: '2026-02-28', userIds: [USER_A2] };
    expect((await repoA.summary(combined)).totals).toEqual({ entries: 1, pages: 30 });
    expect((await repoA.listPaged(combined)).total).toBe(1);
  });

  it('userIds vazio = nenhum usuário (falha fechada), nunca "todos"', async () => {
    const summary = await repoA.summary({ userIds: [] });
    expect(summary.totals).toEqual({ entries: 0, pages: 0 });
    expect(summary.byUser).toEqual([]);
    const page = await repoA.listPaged({ userIds: [] });
    expect(page.total).toBe(0);
    expect(page.items).toEqual([]);
  });

  it('período sem lançamento devolve totais zerados', async () => {
    const empty = await repoA.summary({ dateFrom: '2025-01-01', dateTo: '2025-12-31' });
    expect(empty).toEqual({ totals: { entries: 0, pages: 0 }, byUser: [] });
  });
});

describe('listPaged', () => {
  it('ordena por evaluated_on DESC, created_at DESC e pagina sem duplicar nem pular', async () => {
    const ids: string[] = [];
    const dates = ['2026-05-01', '2026-05-03', '2026-05-03', '2026-05-02', '2026-05-03'];
    for (const [i, evaluatedOn] of dates.entries()) {
      const e = await repoA.create({ userId: USER_A1, evaluatedOn, pageCount: i + 1, createdById: ADMIN_A });
      // created_at determinístico: cada lançamento 1 minuto depois do anterior.
      await sql`UPDATE evaluated_document_entries
                   SET created_at = '2026-05-10T12:00:00Z'::timestamptz + make_interval(mins => ${i})
                 WHERE id = ${e.id}`;
      ids.push(e.id);
    }
    // Ordem esperada: 05-03 (i=4, 2, 1), 05-02 (i=3), 05-01 (i=0).
    const expected = [ids[4], ids[2], ids[1], ids[3], ids[0]];

    const p1 = await repoA.listPaged({ page: 1, pageSize: 2 });
    const p2 = await repoA.listPaged({ page: 2, pageSize: 2 });
    const p3 = await repoA.listPaged({ page: 3, pageSize: 2 });
    expect([p1, p2, p3].map((p) => p.total)).toEqual([5, 5, 5]);
    expect([...p1.items, ...p2.items, ...p3.items].map((i) => i.id)).toEqual(expected);
    expect(p3.items).toHaveLength(1);
    expect((await repoA.listPaged({ page: 4, pageSize: 2 })).items).toEqual([]);
  });

  it('normaliza page e pageSize', async () => {
    const page = await repoA.listPaged({ page: 0, pageSize: 1000 });
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(100);
    expect((await repoA.listPaged()).pageSize).toBe(20);
  });
});

describe('update', () => {
  it('aplica patch parcial, grava autoria e devolve before/after', async () => {
    const entry = await repoA.create({
      userId: USER_A1,
      evaluatedOn: '2026-06-01',
      pageCount: 10,
      createdById: ADMIN_A,
    });

    const result = await repoA.update(entry.id, { pageCount: 15, updatedById: ADMIN_A });
    expect(result).not.toBeNull();
    expect(result?.before.pageCount).toBe(10);
    expect(result?.after.pageCount).toBe(15);
    // Campos fora do patch não mudam.
    expect(result?.after.userId).toBe(USER_A1);
    expect(result?.after.evaluatedOn).toBe('2026-06-01');
    expect(result?.after.createdById).toBe(ADMIN_A);
    expect(result?.after.updatedById).toBe(ADMIN_A);
    expect(result?.before.updatedById).toBeNull();
    expect(result!.after.updatedAt.getTime()).toBeGreaterThan(result!.before.updatedAt.getTime());

    const moved = await repoA.update(entry.id, {
      userId: USER_A2,
      evaluatedOn: '2026-06-02',
      updatedById: ADMIN_A,
    });
    expect(moved?.before.userId).toBe(USER_A1);
    expect(moved?.after.userId).toBe(USER_A2);
    expect(moved?.after.evaluatedOn).toBe('2026-06-02');
    expect(moved?.after.pageCount).toBe(15);

    expect(await repoA.findById(entry.id)).toEqual(moved?.after);
    expect(await repoA.update(MISSING_ID, { pageCount: 1, updatedById: ADMIN_A })).toBeNull();
  });

  it('dentro de transação externa: rollback desfaz update e softDelete', async () => {
    const entry = await repoA.create({ userId: USER_A1, evaluatedOn: '2026-06-01', pageCount: 10, createdById: ADMIN_A });
    const other = await repoA.create({ userId: USER_A2, evaluatedOn: '2026-06-02', pageCount: 20, createdById: ADMIN_A });

    await expect(
      sql.begin(async (tx) => {
        const repoTx = new EvaluatedDocumentEntriesRepository(tx, { tenantId: TENANT_A });
        const changed = await repoTx.update(entry.id, { pageCount: 99, updatedById: ADMIN_A });
        expect(changed?.after.pageCount).toBe(99);
        // Dentro do tx a mudança é visível…
        expect((await repoTx.findById(entry.id))?.pageCount).toBe(99);
        expect(await repoTx.softDelete(other.id, ADMIN_A)).not.toBeNull();
        // …e o "audit log" falha: tudo tem de voltar.
        throw new Error('audit falhou');
      }),
    ).rejects.toThrow('audit falhou');

    const after = await repoA.findById(entry.id);
    expect(after?.pageCount).toBe(10);
    expect(after?.updatedById).toBeNull();
    expect((await repoA.findById(other.id))?.deleted).toBe(false);
  });

  it('dentro de transação externa: commit grava update + audit juntos', async () => {
    const entry = await repoA.create({ userId: USER_A1, evaluatedOn: '2026-06-01', pageCount: 10, createdById: ADMIN_A });

    await sql.begin(async (tx) => {
      const repoTx = new EvaluatedDocumentEntriesRepository(tx, { tenantId: TENANT_A });
      await repoTx.update(entry.id, { pageCount: 15, updatedById: ADMIN_A });
      await tx`INSERT INTO audit_logs (tenant_id, user_id, action, resource, metadata)
               VALUES (${TENANT_A}, ${ADMIN_A}, 'evaluated_documents.update',
                       ${`evaluated-documents/${entry.id}`}, ${tx.json({ justification: 'teste tx' })})`;
    });

    expect((await repoA.findById(entry.id))?.pageCount).toBe(15);
    const audit = await sql<Array<{ t: string }>>`
      SELECT jsonb_typeof(metadata) AS t FROM audit_logs
       WHERE resource = ${`evaluated-documents/${entry.id}`}
    `;
    expect(audit).toEqual([{ t: 'object' }]);
    await sql`DELETE FROM audit_logs WHERE resource = ${`evaluated-documents/${entry.id}`}`;
  });

  it('dentro de transação externa: erro no update volta só ao savepoint e o tx segue utilizável', async () => {
    const entry = await repoA.create({ userId: USER_A1, evaluatedOn: '2026-06-01', pageCount: 10, createdById: ADMIN_A });

    await sql.begin(async (tx) => {
      const repoTx = new EvaluatedDocumentEntriesRepository(tx, { tenantId: TENANT_A });
      const err = await pgError(repoTx.update(entry.id, { pageCount: 0, updatedById: ADMIN_A }));
      expect(err.code).toBe('23514');
      // Sem savepoint, esta chamada falharia com "current transaction is aborted".
      await repoTx.update(entry.id, { pageCount: 11, updatedById: ADMIN_A });
    });

    expect((await repoA.findById(entry.id))?.pageCount).toBe(11);
  });

  it('update com pageCount = 0 falha pelo CHECK e não altera a linha', async () => {
    const entry = await repoA.create({ userId: USER_A1, evaluatedOn: '2026-06-01', pageCount: 10, createdById: ADMIN_A });
    const err = await pgError(repoA.update(entry.id, { pageCount: 0, updatedById: ADMIN_A }));
    expect(err.code).toBe('23514');
    expect((await repoA.findById(entry.id))?.pageCount).toBe(10);
  });
});
