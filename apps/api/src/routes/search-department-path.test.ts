import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, resetDomainTables, type TestDb } from '../test/helpers.js';

/**
 * Testes E2E dos campos de LOCALIZAÇÃO e FORMATO na resposta do `POST /search`
 * (épico E-10 / T-87): `departmentId`, `departmentPath` e `mimeType`.
 *
 * O que está sob teste é o enriquecimento (`routes/search.ts`,
 * `enrichResultsToChunks`) — em particular a CTE recursiva que sobe pela cadeia
 * de `parent_id` até a raiz. Os pontos que justificam um arquivo próprio, com
 * fixture de ÁRVORE (a de `search-enrichment.test.ts` só tem departamentos raiz):
 *
 *  1. o caminho vem na ordem RAIZ → FOLHA, e não invertido;
 *  2. o caminho vem COMPLETO para quem tem ACL de um ramo abaixo da raiz — é o
 *     cenário que motivou resolver isso no servidor em vez de no front, onde a
 *     lista de departamentos já chega recortada pela ACL;
 *  3. depois de um MOVE o card aponta para o destino — o departamento sai de
 *     `documents`, a fonte canônica, e não da cópia denormalizada em `chunks`;
 *  4. nenhum nome de departamento atravessa a fronteira de empresa.
 *
 * Só o caminho `lexical` sem `generateAnswer` é exercitado: é o que a tela de
 * busca usa, e o enriquecimento é compartilhado com o caminho por chunk (que
 * `search-enrichment.test.ts` já cobre do ponto de vista de isolamento).
 */

const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();

const ADMIN_A_ID = crypto.randomUUID();
/** USER de A com acesso concedido APENAS a "Notas Fiscais" (nível 1, não raiz). */
const USER_RAMO_ID = crypto.randomUUID();

// Árvore do tenant A: Financeiro > Notas Fiscais > 2026, mais uma raiz solta.
const DEPT_FINANCEIRO_ID = crypto.randomUUID();
const DEPT_NOTAS_ID = crypto.randomUUID();
const DEPT_2026_ID = crypto.randomUUID();
const DEPT_JURIDICO_ID = crypto.randomUUID();

/** Raiz do tenant B — o nome existe para poder ser procurado na resposta de A. */
const DEPT_B_ID = crypto.randomUUID();

const TYPE_A_ID = crypto.randomUUID();

/** Documento no fundo da árvore (nível 2) — o caso do caminho de 3 segmentos. */
const DOC_FUNDO_ID = crypto.randomUUID();
/** Documento direto numa RAIZ — o caso do caminho de 1 segmento. */
const DOC_RAIZ_ID = crypto.randomUUID();
/** Documento que nasce em "2026" e é movido para "Jurídico" pela rota real. */
const DOC_MOVIDO_ID = crypto.randomUUID();
/** Documento do tenant B — nunca pode vazar, nem ele nem o nome do seu dept. */
const DOC_B_ID = crypto.randomUUID();

const PASSWORD = 'senha-muito-secreta-123';

/** Termo presente no texto dos chunks dos QUATRO documentos (A e B). */
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

  await seedUser(testDb.db, {
    id: ADMIN_A_ID,
    tenantId: TENANT_A,
    email: 'admin-a@empresa.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
  });

  await seedUser(testDb.db, {
    id: USER_RAMO_ID,
    tenantId: TENANT_A,
    email: 'user-ramo@empresa.com',
    password: PASSWORD,
    role: 'USER',
  });

  await testDb.db`
    INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
    VALUES
      (${DEPT_FINANCEIRO_ID}, ${TENANT_A}, NULL, 'Financeiro', 0, '{}'::text[], false, NOW()),
      (${DEPT_NOTAS_ID}, ${TENANT_A}, ${DEPT_FINANCEIRO_ID}, 'Notas Fiscais', 1, '{}'::text[], false, NOW()),
      (${DEPT_2026_ID}, ${TENANT_A}, ${DEPT_NOTAS_ID}, '2026', 2, '{}'::text[], false, NOW()),
      (${DEPT_JURIDICO_ID}, ${TENANT_A}, NULL, 'Juridico', 0, '{}'::text[], false, NOW()),
      (${DEPT_B_ID}, ${TENANT_B}, NULL, 'Departamento Secreto B', 0, '{}'::text[], false, NOW())
  `;

  // ACL do USER: apenas "Notas Fiscais" — um nó de NÍVEL 1, deliberadamente não
  // a raiz. A leitura se expande para a subárvore (inclui "2026"), mas
  // "Financeiro" fica FORA do conjunto acessível. É exatamente esse ancestral
  // que o caminho tem que continuar mostrando.
  await testDb.db`
    INSERT INTO department_permissions (id, tenant_id, user_id, department_id, can_read, can_write, deleted)
    VALUES (${crypto.randomUUID()}, ${TENANT_A}, ${USER_RAMO_ID}, ${DEPT_NOTAS_ID}, true, false, false)
  `;

  await testDb.db`
    INSERT INTO document_types (id, tenant_id, name, is_global, deleted, created_at)
    VALUES (${TYPE_A_ID}, ${TENANT_A}, 'Nota Fiscal', false, false, NOW())
  `;

  // Mimes deliberadamente distintos: o teste de formato precisa distinguir os
  // documentos pelo `mimeType`, não por acaso de todos serem PDF.
  await testDb.db`
    INSERT INTO documents (
      id, tenant_id, department_id, document_type_id,
      filename, original_filename, title, suggested_title,
      content_hash, size_bytes, mime_type, s3_key, status, tags, index_values,
      uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
    ) VALUES
      (
        ${DOC_FUNDO_ID}, ${TENANT_A}, ${DEPT_2026_ID}, ${TYPE_A_ID},
        'fundo.pdf', 'fundo.pdf', 'Nota do fundo da arvore', NULL,
        ${'a'.repeat(64)}, 1024, 'application/pdf', ${`tenants/${TENANT_A}/${DOC_FUNDO_ID}.pdf`}, 'READY', '{}'::text[],
        ${testDb.db.json({})},
        ${ADMIN_A_ID}, NOW(), NOW(), 0, false
      ),
      (
        ${DOC_RAIZ_ID}, ${TENANT_A}, ${DEPT_JURIDICO_ID}, ${TYPE_A_ID},
        'raiz.docx', 'raiz.docx', 'Documento direto na raiz', NULL,
        ${'b'.repeat(64)}, 1024,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ${`tenants/${TENANT_A}/${DOC_RAIZ_ID}.docx`}, 'READY', '{}'::text[],
        ${testDb.db.json({})},
        ${ADMIN_A_ID}, NOW(), NOW(), 0, false
      ),
      (
        ${DOC_MOVIDO_ID}, ${TENANT_A}, ${DEPT_2026_ID}, ${TYPE_A_ID},
        'movido.txt', 'movido.txt', 'Documento que sera movido', NULL,
        ${'c'.repeat(64)}, 1024, 'text/plain', ${`tenants/${TENANT_A}/${DOC_MOVIDO_ID}.txt`}, 'READY', '{}'::text[],
        ${testDb.db.json({})},
        ${ADMIN_A_ID}, NOW(), NOW(), 0, false
      ),
      (
        ${DOC_B_ID}, ${TENANT_B}, ${DEPT_B_ID}, NULL,
        'b.pdf', 'b.pdf', 'Documento do tenant B', NULL,
        ${'d'.repeat(64)}, 1024, 'application/pdf', ${`tenants/${TENANT_B}/${DOC_B_ID}.pdf`}, 'READY', '{}'::text[],
        ${testDb.db.json({})},
        ${ADMIN_A_ID}, NOW(), NOW(), 0, false
      )
  `;

  await testDb.db`
    INSERT INTO chunks (document_id, tenant_id, department_id, document_type_name, page_number, chunk_index, text, embedding, token_count)
    VALUES
      (${DOC_FUNDO_ID}, ${TENANT_A}, ${DEPT_2026_ID}, 'Nota Fiscal', 1, 0, ${`nota com uma ${NEEDLE} no fundo`}, ${EMBEDDING}::vector, 5),
      (${DOC_RAIZ_ID}, ${TENANT_A}, ${DEPT_JURIDICO_ID}, 'Nota Fiscal', 1, 0, ${`parecer com ${NEEDLE} na raiz`}, ${EMBEDDING}::vector, 5),
      (${DOC_MOVIDO_ID}, ${TENANT_A}, ${DEPT_2026_ID}, 'Nota Fiscal', 1, 0, ${`laudo com ${NEEDLE} a ser movido`}, ${EMBEDDING}::vector, 5),
      (${DOC_B_ID}, ${TENANT_B}, ${DEPT_B_ID}, NULL, 1, 0, ${`a ${NEEDLE} secreta do tenant B`}, ${EMBEDDING}::vector, 5)
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

interface RespChunk {
  documentId: string;
  documentName: string | null;
  departmentId: string;
  departmentPath: string[];
  mimeType: string;
  tenantId: string | null;
  text: string;
}

/** Busca lexical paginada — o caminho que a tela de busca usa. */
async function searchNeedle(token: string): Promise<{ chunks: RespChunk[]; raw: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/search',
    headers: { authorization: `Bearer ${token}` },
    payload: { query: NEEDLE, searchMode: 'lexical', generateAnswer: false },
  });
  expect(res.statusCode).toBe(200);
  return { chunks: (res.json() as { chunks: RespChunk[] }).chunks, raw: res.body };
}

function findDoc(chunks: RespChunk[], documentId: string): RespChunk {
  const found = chunks.find((c) => c.documentId === documentId);
  expect(found).toBeDefined();
  return found as RespChunk;
}

describe('POST /search — caminho do departamento e formato do arquivo (E-10 / T-87)', () => {
  it('devolve o caminho COMPLETO, da raiz até a folha, em departamento aninhado', async () => {
    const { chunks } = await searchNeedle(adminAToken);

    const doc = findDoc(chunks, DOC_FUNDO_ID);
    expect(doc.departmentId).toBe(DEPT_2026_ID);
    // Ordem raiz → folha. Invertida, o card mostraria "2026 / Notas Fiscais /
    // Financeiro", que é a leitura errada da hierarquia.
    expect(doc.departmentPath).toEqual(['Financeiro', 'Notas Fiscais', '2026']);
  });

  it('documento em departamento RAIZ tem caminho de um único segmento', async () => {
    const { chunks } = await searchNeedle(adminAToken);

    const doc = findDoc(chunks, DOC_RAIZ_ID);
    expect(doc.departmentId).toBe(DEPT_JURIDICO_ID);
    expect(doc.departmentPath).toEqual(['Juridico']);
  });

  it('expõe o mimeType cru de cada documento, sem formatar', async () => {
    const { chunks } = await searchNeedle(adminAToken);

    expect(findDoc(chunks, DOC_FUNDO_ID).mimeType).toBe('application/pdf');
    expect(findDoc(chunks, DOC_RAIZ_ID).mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(findDoc(chunks, DOC_MOVIDO_ID).mimeType).toBe('text/plain');
  });

  it('USER com ACL de um ramo abaixo da raiz recebe o caminho COMPLETO', async () => {
    const userToken = await login('user-ramo@empresa.com');
    const { chunks } = await searchNeedle(userToken);

    // A ACL concede "Notas Fiscais": a subárvore ("2026") é acessível, o
    // "Juridico" não. O documento da outra raiz nem aparece.
    expect(chunks.map((c) => c.documentId).sort()).toEqual(
      [DOC_FUNDO_ID, DOC_MOVIDO_ID].sort(),
    );

    // E o caminho inclui "Financeiro", que está ACIMA da raiz concedida. É o
    // ponto do épico: resolver no front truncaria justamente aqui.
    expect(findDoc(chunks, DOC_FUNDO_ID).departmentPath).toEqual([
      'Financeiro',
      'Notas Fiscais',
      '2026',
    ]);
  });

  it('documento MOVIDO passa a exibir o caminho do destino, não o da origem', async () => {
    const antes = await searchNeedle(adminAToken);
    expect(findDoc(antes.chunks, DOC_MOVIDO_ID).departmentPath).toEqual([
      'Financeiro',
      'Notas Fiscais',
      '2026',
    ]);

    const move = await app.inject({
      method: 'PATCH',
      url: `/documents/${DOC_MOVIDO_ID}/move`,
      headers: { authorization: `Bearer ${adminAToken}` },
      payload: { departmentId: DEPT_JURIDICO_ID },
    });
    expect(move.statusCode).toBe(200);

    const depois = await searchNeedle(adminAToken);
    const doc = findDoc(depois.chunks, DOC_MOVIDO_ID);

    expect(doc.departmentId).toBe(DEPT_JURIDICO_ID);
    expect(doc.departmentPath).toEqual(['Juridico']);
  });

  it('nenhum nome de departamento do tenant B aparece na busca do tenant A', async () => {
    const { chunks, raw } = await searchNeedle(adminAToken);

    expect(chunks.every((c) => c.tenantId === TENANT_A)).toBe(true);
    expect(chunks.some((c) => c.documentId === DOC_B_ID)).toBe(false);
    // Sobre o corpo CRU: o nome do departamento de B não pode existir em lugar
    // NENHUM da resposta, nem dentro de um caminho.
    expect(raw).not.toContain('Departamento Secreto B');
    expect(chunks.flatMap((c) => c.departmentPath)).not.toContain('Departamento Secreto B');
  });

  it('caminho ignora soft-delete de ancestral — a cadeia de parent_id continua inteira', async () => {
    // Excluir um departamento NÃO desliga os documentos abaixo dele (wiki
    // "Exclusão de departamento preserva documentos e permissões"). Se a
    // recursão filtrasse `deleted`, o caminho viria com buraco no meio —
    // ["Financeiro", "2026"] ou pior, só ["2026"].
    await testDb.db`
      UPDATE departments SET deleted = true WHERE id = ${DEPT_NOTAS_ID}
    `;

    const { chunks } = await searchNeedle(adminAToken);
    expect(findDoc(chunks, DOC_FUNDO_ID).departmentPath).toEqual([
      'Financeiro',
      'Notas Fiscais',
      '2026',
    ]);
  });
});
