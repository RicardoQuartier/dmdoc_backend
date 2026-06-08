import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoDbClient } from './client.js';
import { TenantRepository, type TenantDocument } from './tenant-repository.js';

/**
 * Documento de teste — uma entidade tenant-scoped genérica.
 */
interface Widget extends TenantDocument {
  name: string;
  createdAt: Date;
}

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

let mongo: MongoMemoryServer;
let db: MongoDbClient;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  db = await MongoDbClient.connect(mongo.getUri(), 'dmdoc_test');
});

afterAll(async () => {
  await db.close();
  await mongo.stop();
});

beforeEach(async () => {
  await db.getDb().collection('widgets').deleteMany({});
});

function repoFor(tenantId: string): TenantRepository<Widget> {
  const collection = db.getDb().collection<Widget>('widgets');
  return new TenantRepository<Widget>(collection, { tenantId });
}

describe('TenantRepository — isolamento multi-tenant', () => {
  it('insertOne grava o tenantId automaticamente (sem que o chamador informe)', async () => {
    const repo = repoFor(TENANT_A);
    const created = await repo.insertOne({ name: 'alpha', createdAt: new Date() });

    expect(created.tenantId).toBe(TENANT_A);
    expect(created.deleted).toBe(false);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

    // Confirma via query crua (sem o wrapper) que o tenantId foi persistido.
    const raw = await db.getDb().collection('widgets').findOne({ id: created.id });
    expect(raw?.tenantId).toBe(TENANT_A);
    expect(raw?.deleted).toBe(false);
  });

  it('query do tenant A nunca retorna documento do tenant B (findById alheio → null)', async () => {
    const repoA = repoFor(TENANT_A);
    const repoB = repoFor(TENANT_B);

    const docB = await repoB.insertOne({ name: 'segredo-da-empresa-B', createdAt: new Date() });

    // Tenant A busca por um id que existe, mas é de outra empresa: inalcançável.
    const seenByA = await repoA.findById(docB.id);
    expect(seenByA).toBeNull();

    // E o próprio dono ainda enxerga.
    const seenByB = await repoB.findById(docB.id);
    expect(seenByB?.id).toBe(docB.id);
  });

  it('findMany não vaza documentos de outra empresa', async () => {
    const repoA = repoFor(TENANT_A);
    const repoB = repoFor(TENANT_B);

    await repoA.insertOne({ name: 'a1', createdAt: new Date() });
    await repoA.insertOne({ name: 'a2', createdAt: new Date() });
    await repoB.insertOne({ name: 'b1', createdAt: new Date() });

    const pageA = await repoA.findMany();
    expect(pageA.items).toHaveLength(2);
    expect(pageA.items.every((w) => w.tenantId === TENANT_A)).toBe(true);

    const countA = await repoA.count();
    expect(countA).toBe(2);
  });
});

describe('TenantRepository — exclusão lógica (soft delete)', () => {
  it('leitura nunca retorna documento com deleted:true', async () => {
    const repo = repoFor(TENANT_A);
    const doc = await repo.insertOne({ name: 'temporario', createdAt: new Date() });

    expect(await repo.softDelete(doc.id)).toBe(true);

    expect(await repo.findById(doc.id)).toBeNull();
    expect(await repo.findOne({ name: 'temporario' })).toBeNull();
    expect(await repo.count()).toBe(0);
    expect((await repo.findMany()).items).toHaveLength(0);
  });

  it('softDelete some das leituras mas o documento persiste no banco', async () => {
    const repo = repoFor(TENANT_A);
    const doc = await repo.insertOne({ name: 'auditavel', createdAt: new Date() });

    await repo.softDelete(doc.id);

    // Query crua, sem o wrapper: o documento continua existindo, marcado.
    const raw = await db.getDb().collection('widgets').findOne({ id: doc.id });
    expect(raw).not.toBeNull();
    expect(raw?.deleted).toBe(true);
    expect(raw?.name).toBe('auditavel');
  });

  it('softDelete de id inexistente/alheio retorna false', async () => {
    const repoA = repoFor(TENANT_A);
    const repoB = repoFor(TENANT_B);
    const docB = await repoB.insertOne({ name: 'b', createdAt: new Date() });

    // Tenant A não consegue deletar recurso do tenant B.
    expect(await repoA.softDelete(docB.id)).toBe(false);
    // E o recurso de B segue intacto.
    expect((await repoB.findById(docB.id))?.deleted).toBe(false);
  });
});

describe('TenantRepository — update e cursor', () => {
  it('updateById só afeta recurso da própria empresa', async () => {
    const repoA = repoFor(TENANT_A);
    const repoB = repoFor(TENANT_B);
    const docB = await repoB.insertOne({ name: 'original', createdAt: new Date() });

    const fromA = await repoA.updateById(docB.id, { name: 'hackeado' });
    expect(fromA).toBeNull();

    const stillB = await repoB.findById(docB.id);
    expect(stillB?.name).toBe('original');
  });

  it('findMany pagina por cursor sem repetir itens', async () => {
    const repo = repoFor(TENANT_A);
    for (let i = 0; i < 5; i++) {
      await repo.insertOne({ name: `n${i}`, createdAt: new Date() });
    }

    const first = await repo.findMany({}, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await repo.findMany(
      {},
      { limit: 2, cursor: first.nextCursor ?? undefined }
    );
    expect(second.items).toHaveLength(2);

    const firstIds = new Set(first.items.map((w) => w.id));
    expect(second.items.some((w) => firstIds.has(w.id))).toBe(false);
  });
});

describe('TenantRepository — modo SUPER_ADMIN (contexto null)', () => {
  it('recusa operar sem empresa explícita', async () => {
    const collection = db.getDb().collection<Widget>('widgets');
    const superAdmin = new TenantRepository<Widget>(collection, null);

    await expect(superAdmin.findMany()).rejects.toThrow(/seleção explícita de empresa/);
    await expect(
      superAdmin.insertOne({ name: 'x', createdAt: new Date() })
    ).rejects.toThrow(/seleção explícita de empresa/);
  });

  it('opera apenas via forTenant(tenantId) explícito', async () => {
    const collection = db.getDb().collection<Widget>('widgets');
    const superAdmin = new TenantRepository<Widget>(collection, null);

    const created = await superAdmin.forTenant(TENANT_A).insertOne({
      name: 'criado-por-super-admin',
      createdAt: new Date(),
    });
    expect(created.tenantId).toBe(TENANT_A);

    // O escopo é por chamada: A enxerga, B não.
    expect(await superAdmin.forTenant(TENANT_A).findById(created.id)).not.toBeNull();
    expect(await superAdmin.forTenant(TENANT_B).findById(created.id)).toBeNull();
  });
});
