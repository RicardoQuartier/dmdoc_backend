import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, resetDomainTables, type TestDb } from '../test/helpers.js';

/**
 * Testes E2E do enriquecimento da resposta do POST /search (T-12, épico E-2).
 *
 * Verifica que cada chunk retornado traz:
 *  - `title`: o título de exibição CONFIRMADO (`documents.title`), ou `null`
 *    quando não confirmado. A sugestão bruta da IA (`suggestedTitle`) NUNCA é
 *    exposta como título (invariante da wiki "Título de exibição sugerido por IA").
 *  - `indexValues`: apenas os campos com a flag "aparece na busca"
 *    (`document_type_index_fields.show_on_search = true`), com rótulo + valor,
 *    na ordem de exibição (`sort_order`).
 *
 * E, sobretudo, o ISOLAMENTO multi-tenant: um TENANT_ADMIN do tenant A que busca
 * um termo presente também num documento do tenant B NUNCA recebe o documento de
 * B — nem seu título, nem seus índices. Os novos campos não abrem brecha.
 */

const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();

const ADMIN_A_ID = crypto.randomUUID();

const DEPT_A_ID = crypto.randomUUID();
const DEPT_B_ID = crypto.randomUUID();

const TYPE_A_ID = crypto.randomUUID();
const TYPE_B_ID = crypto.randomUUID();

// Documento A: título confirmado + índices (um showOnSearch, um não).
const DOC_A_ID = crypto.randomUUID();
// Documento A antigo: sem título confirmado (title null), mas com suggestedTitle.
const DOC_A_OLD_ID = crypto.randomUUID();
// Documento B: pertence ao tenant B — nunca pode vazar para o admin de A.
const DOC_B_ID = crypto.randomUUID();

const PASSWORD = 'senha-muito-secreta-123';

// Termo distintivo presente nos chunks dos TRÊS documentos (A, A-old e B) para
// provar que o corte é por tenant, não por acaso do termo não casar em B.
const NEEDLE = 'girafa';

const EMBEDDING = `[${Array.from({ length: 1536 }, () => 0).join(',')}]`;

let app: FastifyInstance;
let testDb: TestDb;
let adminAToken: string;

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

  // TENANT_ADMIN de A: sem restrição de departamento (ACL null).
  await seedUser(testDb.db, {
    id: ADMIN_A_ID,
    tenantId: TENANT_A,
    email: 'admin-a@empresa.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
  });

  await testDb.db`
    INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
    VALUES
      (${DEPT_A_ID}, ${TENANT_A}, NULL, 'Dept A', 0, '{}'::text[], false, NOW()),
      (${DEPT_B_ID}, ${TENANT_B}, NULL, 'Dept B', 0, '{}'::text[], false, NOW())
  `;

  // Tipos de documento (um por tenant).
  await testDb.db`
    INSERT INTO document_types (id, tenant_id, name, is_global, deleted, created_at)
    VALUES
      (${TYPE_A_ID}, ${TENANT_A}, 'Nota Fiscal', false, false, NOW()),
      (${TYPE_B_ID}, ${TENANT_B}, 'Contrato B', false, false, NOW())
  `;

  // Campos de índice do tipo A:
  //  - numero_nota  → show_on_search = true  (deve aparecer na busca)
  //  - valor_interno → show_on_search = false (NUNCA aparece na busca)
  // sort_order define a ordem de exibição: numero_nota (0) antes de emissao (1).
  await testDb.db`
    INSERT INTO document_type_index_fields
      (id, document_type_id, name, field_type, required, ai_extraction_hint, sort_order, show_on_search, deleted)
    VALUES
      (${crypto.randomUUID()}, ${TYPE_A_ID}, 'numero_nota', 'TEXT', false, NULL, 0, true, false),
      (${crypto.randomUUID()}, ${TYPE_A_ID}, 'emissao', 'DATE', false, NULL, 1, true, false),
      (${crypto.randomUUID()}, ${TYPE_A_ID}, 'valor_interno', 'NUMBER', false, NULL, 2, false, false)
  `;

  // Campo showOnSearch do tipo B — se vazasse, apareceria com este rótulo.
  await testDb.db`
    INSERT INTO document_type_index_fields
      (id, document_type_id, name, field_type, required, ai_extraction_hint, sort_order, show_on_search, deleted)
    VALUES
      (${crypto.randomUUID()}, ${TYPE_B_ID}, 'segredo_b', 'TEXT', false, NULL, 0, true, false)
  `;

  const hashA = 'a'.repeat(64);
  const hashAOld = 'd'.repeat(64);
  const hashB = 'b'.repeat(64);

  await testDb.db`
    INSERT INTO documents (
      id, tenant_id, department_id, document_type_id,
      filename, original_filename, title, suggested_title,
      content_hash, size_bytes, mime_type, s3_key, status, tags, index_values,
      uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
    ) VALUES
      (
        ${DOC_A_ID}, ${TENANT_A}, ${DEPT_A_ID}, ${TYPE_A_ID},
        'a.pdf', 'a.pdf', 'Nota Fiscal Confirmada', 'Sugestao IA A',
        ${hashA}, 1024, 'application/pdf', ${`tenants/${TENANT_A}/${DOC_A_ID}.pdf`}, 'READY', ${['jaboticaba', 'contrato-locacao']}::text[],
        ${testDb.db.json({ numero_nota: 'NF-123', emissao: '2026-01-10', valor_interno: 9999 })},
        ${ADMIN_A_ID}, NOW(), NOW(), 0, false
      ),
      (
        ${DOC_A_OLD_ID}, ${TENANT_A}, ${DEPT_A_ID}, ${TYPE_A_ID},
        'a-old.pdf', 'a-old.pdf', NULL, 'Sugestao IA nao confirmada',
        ${hashAOld}, 1024, 'application/pdf', ${`tenants/${TENANT_A}/${DOC_A_OLD_ID}.pdf`}, 'READY', '{}'::text[],
        ${testDb.db.json({ numero_nota: 'NF-999' })},
        ${ADMIN_A_ID}, NOW(), NOW(), 0, false
      ),
      (
        ${DOC_B_ID}, ${TENANT_B}, ${DEPT_B_ID}, ${TYPE_B_ID},
        'b.pdf', 'b.pdf', 'Segredo B', 'Sugestao IA B',
        ${hashB}, 1024, 'application/pdf', ${`tenants/${TENANT_B}/${DOC_B_ID}.pdf`}, 'READY', ${['segredo-tag-b']}::text[],
        ${testDb.db.json({ segredo_b: 'CONFIDENCIAL-B' })},
        ${ADMIN_A_ID}, NOW(), NOW(), 0, false
      )
  `;

  // Chunks: o mesmo termo distintivo nos três documentos.
  await testDb.db`
    INSERT INTO chunks (document_id, tenant_id, department_id, document_type_name, page_number, chunk_index, text, embedding, token_count)
    VALUES
      (${DOC_A_ID}, ${TENANT_A}, ${DEPT_A_ID}, 'Nota Fiscal', 1, 0, ${`documento sobre uma ${NEEDLE} azul`}, ${EMBEDDING}::vector, 5),
      (${DOC_A_OLD_ID}, ${TENANT_A}, ${DEPT_A_ID}, 'Nota Fiscal', 1, 0, ${`outra ${NEEDLE} antiga no arquivo`}, ${EMBEDDING}::vector, 5),
      (${DOC_B_ID}, ${TENANT_B}, ${DEPT_B_ID}, 'Contrato B', 1, 0, ${`a ${NEEDLE} secreta do tenant B`}, ${EMBEDDING}::vector, 5)
  `;

  adminAToken = await login('admin-a@empresa.com');
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

interface RespIndexValue {
  fieldName: string;
  label: string;
  fieldType: string;
  value: string | number;
}

interface RespChunk {
  documentId: string;
  documentName: string | null;
  title: string | null;
  indexValues: RespIndexValue[];
  tags: string[];
  tenantId: string | null;
}

async function searchTerm(token: string, term: string): Promise<RespChunk[]> {
  const res = await app.inject({
    method: 'POST',
    url: '/search',
    headers: { authorization: `Bearer ${token}` },
    payload: { query: term, searchMode: 'lexical', generateAnswer: false },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { chunks: RespChunk[] }).chunks;
}

async function searchNeedle(token: string): Promise<RespChunk[]> {
  return searchTerm(token, NEEDLE);
}

describe('POST /search — enriquecimento com title e indexValues (T-12)', () => {
  it('expõe o título CONFIRMADO e os índices showOnSearch, na ordem de exibição', async () => {
    const chunks = await searchNeedle(adminAToken);

    const chunkA = chunks.find((c) => c.documentId === DOC_A_ID);
    expect(chunkA).toBeDefined();

    // Título confirmado exposto; nome do arquivo continua disponível.
    expect(chunkA!.title).toBe('Nota Fiscal Confirmada');
    expect(chunkA!.documentName).toBe('a.pdf');

    // Só os campos showOnSearch com valor: numero_nota e emissao (0 e 1),
    // NUNCA valor_interno (show_on_search = false), mesmo tendo valor.
    const fieldNames = chunkA!.indexValues.map((v) => v.fieldName);
    expect(fieldNames).toEqual(['numero_nota', 'emissao']);
    expect(fieldNames).not.toContain('valor_interno');

    const numero = chunkA!.indexValues.find((v) => v.fieldName === 'numero_nota');
    expect(numero).toMatchObject({
      fieldName: 'numero_nota',
      // Sem `label` explícito no campo (T-15): derivado do `name` snake_case.
      label: 'Numero Nota',
      fieldType: 'TEXT',
      value: 'NF-123',
    });
  });

  it('documento sem título confirmado vem com title null (não expõe suggestedTitle)', async () => {
    const chunks = await searchNeedle(adminAToken);

    const chunkOld = chunks.find((c) => c.documentId === DOC_A_OLD_ID);
    expect(chunkOld).toBeDefined();
    expect(chunkOld!.title).toBeNull();
    expect(chunkOld!.documentName).toBe('a-old.pdf');

    // Só um campo showOnSearch tem valor neste doc (numero_nota); emissao ausente.
    expect(chunkOld!.indexValues.map((v) => v.fieldName)).toEqual(['numero_nota']);

    // A sugestão bruta da IA jamais aparece como título em nenhum chunk.
    const raw = JSON.stringify(chunks);
    expect(raw).not.toContain('Sugestao IA nao confirmada');
  });

  it('expõe as tags CONFIRMADAS do documento no chunk (chips da busca — Fase 9 / E-3)', async () => {
    const chunks = await searchNeedle(adminAToken);

    const chunkA = chunks.find((c) => c.documentId === DOC_A_ID);
    expect(chunkA).toBeDefined();
    expect(chunkA!.tags).toEqual(['jaboticaba', 'contrato-locacao']);

    // Documento sem tags confirmadas vem com array vazio (nunca undefined).
    const chunkOld = chunks.find((c) => c.documentId === DOC_A_OLD_ID);
    expect(chunkOld!.tags).toEqual([]);
  });

  it('busca livre por uma TAG confirmada traz o documento (case-insensitive/substring)', async () => {
    // "jaboticaba" não aparece em nenhum texto de chunk — só na tag do DOC_A.
    // Digitar parte da tag em caixa alta deve trazer o documento mesmo assim.
    const chunks = await searchTerm(adminAToken, 'JABOTI');

    const chunkA = chunks.find((c) => c.documentId === DOC_A_ID);
    expect(chunkA).toBeDefined();
    expect(chunkA!.tags).toContain('jaboticaba');
  });

  it('ISOLAMENTO: buscar pela tag do tenant B não traz o documento de B para o admin de A', async () => {
    const chunks = await searchTerm(adminAToken, 'segredo-tag-b');
    expect(chunks.some((c) => c.documentId === DOC_B_ID)).toBe(false);
    const raw = JSON.stringify(chunks);
    expect(raw).not.toContain('segredo-tag-b');
  });

  it('ISOLAMENTO: admin de A nunca recebe documento, título ou índices do tenant B', async () => {
    const chunks = await searchNeedle(adminAToken);

    // Nenhum chunk do tenant B, mesmo o termo casando no chunk de B.
    expect(chunks.some((c) => c.documentId === DOC_B_ID)).toBe(false);
    expect(chunks.every((c) => c.tenantId === TENANT_A)).toBe(true);

    // Nem o título nem o índice de B podem aparecer em lugar nenhum da resposta.
    const raw = JSON.stringify(chunks);
    expect(raw).not.toContain('Segredo B');
    expect(raw).not.toContain('segredo_b');
    expect(raw).not.toContain('CONFIDENCIAL-B');
  });
});
