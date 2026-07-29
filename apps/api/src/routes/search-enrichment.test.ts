import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, resetDomainTables, type TestDb } from '../test/helpers.js';

/**
 * Stub do SDK da OpenAI — necessário só para o bloco T-123.
 *
 * O ramo de metadados do caminho por CHUNK (`routes/search.ts:554-639`) só é
 * alcançável em `searchMode` `vector`/`hybrid` (o `lexical` sem `generateAnswer`
 * cai no caminho paginado, e o `generateAnswer` responde por SSE). Esses modos
 * exigem o embedding da query, e `searchRoutes` instancia o cliente OpenAI
 * internamente (`routes/search.ts:323`), sem ponto de injeção — daí o mock de
 * módulo em vez de um fake passado por `buildApp`.
 *
 * O vetor devolvido é sempre o mesmo (`e1`): a busca vetorial aqui é só o
 * veículo para chegar ao ramo de metadados, não o objeto do teste. Quem controla
 * quem vence o ranqueamento é o embedding SEMEADO em cada chunk.
 */
vi.mock('openai', () => {
  const queryEmbedding = [1, ...Array.from({ length: 1535 }, () => 0)];
  class OpenAIStub {
    static APIError = class extends Error {};
    embeddings = {
      create: async () => ({
        data: [{ embedding: queryEmbedding, index: 0 }],
        usage: { prompt_tokens: 3, total_tokens: 3 },
      }),
    };
  }
  return { default: OpenAIStub, OpenAI: OpenAIStub };
});

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
 *
 * O SEGUNDO bloco do arquivo (E-9 / T-123) trata de outro corte de acesso na
 * mesma rota: o ramo de METADADOS do caminho por chunk depois de um documento
 * mudar de DEPARTAMENTO. Ver o comentário do `describe` correspondente.
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

// ---------------------------------------------------------------------------
// Fixture do bloco T-123 (E-9) — documento movido entre departamentos.
// ---------------------------------------------------------------------------

/** Segundo departamento RAIZ do tenant A — destino do move. */
const DEPT_A2_ID = crypto.randomUUID();

/** UPLOADER com a raiz ANTIGA concedida (e só ela). */
const UPLOADER_ORIGEM_ID = crypto.randomUUID();
/** UPLOADER com a raiz NOVA concedida (e só ela). */
const UPLOADER_DESTINO_ID = crypto.randomUUID();
/** SUPER_ADMIN sem tenant — exercita o ramo SEM filtro de tenant. */
const SUPER_ID = crypto.randomUUID();

/** Documento que sai do DEPT_A para o DEPT_A2 pela rota real de move. */
const DOC_MOVIDO_ID = crypto.randomUUID();
/**
 * Documento-isca no departamento DESTINO. Existe para ocupar o único slot do
 * ramo de CONTEÚDO (`topK: 1`) com distância 0, empurrando o documento movido
 * para o ramo de METADADOS — que é o SQL sob teste.
 */
const DOC_ISCA_ID = crypto.randomUUID();

/** Casa só por METADADO (tag do documento movido); não existe em chunk nenhum. */
const META_NEEDLE = 'pterodactilo';
/** Vive só no TEXTO do chunk do documento movido; não existe em metadado nenhum. */
const CHUNK_NEEDLE = 'quiabo-fosforescente';
const TEXTO_CHUNK_MOVIDO = `laudo com ${CHUNK_NEEDLE} do documento movido`;

/** Igual ao embedding da query: distância 0, vence o slot do ramo de conteúdo. */
const EMBEDDING_ISCA = `[${[1, ...Array.from({ length: 1535 }, () => 0)].join(',')}]`;
/** Ortogonal à query (distância 1): perde o slot para a isca, por construção. */
const EMBEDDING_MOVIDO = `[${[0, 1, ...Array.from({ length: 1534 }, () => 0)].join(',')}]`;

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
      content_hash, size_bytes, mime_type, storage_key, status, tags, index_values,
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
  text: string;
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

/**
 * Busca pelo caminho por CHUNK (`vector`, sem `generateAnswer`) — o único que
 * passa pelo ramo de metadados de `routes/search.ts:554-639`.
 *
 * `topK: 1` é deliberado: com um único slot no ramo de conteúdo, o documento
 * que casa por metadado é obrigado a entrar pelo SQL sob teste. Com o `topK`
 * padrão (10) o ramo de conteúdo devolveria o chunk primeiro e o ramo de
 * metadados nunca rodaria — falso verde silencioso.
 *
 * Devolve também o corpo CRU: a asserção que importa no lado negativo é o texto
 * do chunk não aparecer em lugar NENHUM da resposta, não só fora de `chunks`.
 */
async function searchByChunkPath(
  token: string,
  term: string,
): Promise<{ chunks: RespChunk[]; raw: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/search',
    headers: { authorization: `Bearer ${token}` },
    payload: { query: term, searchMode: 'vector', generateAnswer: false, topK: 1 },
  });
  expect(res.statusCode).toBe(200);
  return { chunks: (res.json() as { chunks: RespChunk[] }).chunks, raw: res.body };
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

/**
 * ACL do ramo de METADADOS da busca depois de um move de departamento
 * (épico E-9 / T-123).
 *
 * A invariante do épico — `chunks.department_id` acompanha
 * `documents.department_id` na mesma transação — já está provada na camada de
 * banco (`packages/db-pg/src/search-moved-document.test.ts`) e nas rotas de move
 * (`documents-move.test.ts`, `documents-bulk-move.test.ts`). Faltava o TERCEIRO
 * consumidor: `routes/search.ts:554-639` monta SQL PRÓPRIO contra `chunks`, com
 * uma variante por escopo de papel, e filtra `AND department_id = ANY(...)` —
 * o do CHUNK, não o do documento. Nenhum teste exercitava esse filtro com um
 * documento movido; mexer nele não quebrava nada.
 *
 * Como o caminho é alcançado (nada disso é acidental):
 *   - `searchMode: 'vector'` sem `generateAnswer` — `lexical` sem
 *     `generateAnswer` cai no caminho PAGINADO (`searchDocumentsPaged`), que dá
 *     falso verde: ele esconde o documento dos DOIS lados porque a CTE `merged`
 *     semi-junta com `filtered`, lida de `documents` (achado da T-111);
 *   - `topK: 1` + documento-isca com embedding idêntico ao da query: a isca
 *     ocupa o slot do ramo de conteúdo e o documento movido só pode entrar pelo
 *     ramo de metadados;
 *   - a query de busca é o `META_NEEDLE`, que casa APENAS na tag do documento
 *     movido; o `CHUNK_NEEDLE` vive apenas no texto do chunk — é o payload que
 *     não pode vazar.
 *
 * Sobre o `departmentId` projetado em `routes/search.ts:627`: ele alimenta o
 * `ChunkSearchResult`, mas MORRE no enriquecimento — `SearchChunk`
 * (`packages/shared-types/src/search.ts`) não tem esse campo e `EnrichableResult`
 * não o seleciona. Ou seja, não há `departmentId` no corpo da resposta para
 * conferir. O que é observável — e é o que estes testes travam — é o EFEITO do
 * filtro: quem tem só a raiz nova recebe o chunk, quem tem só a antiga não, e o
 * departamento das duas tabelas é conferido direto no banco.
 */
describe('POST /search — chunk de documento movido de departamento (E-9 / T-123)', () => {
  let tokenOrigem = '';
  let tokenDestino = '';
  let tokenSuper = '';

  /** Departamentos DISTINTOS dos chunks do documento (desync apareceria aqui). */
  async function chunkDepartments(documentId: string): Promise<string[]> {
    const rows = await testDb.db<Array<{ department_id: string }>>`
      SELECT DISTINCT department_id FROM chunks WHERE document_id = ${documentId}
    `;
    return rows.map((r) => r.department_id);
  }

  /** Move pela ROTA REAL — o objetivo é validar o caminho de ponta a ponta. */
  async function moveDocumento(token: string, documentId: string, departmentId: string) {
    const res = await app.inject({
      method: 'PATCH',
      url: `/documents/${documentId}/move`,
      headers: { authorization: `Bearer ${token}` },
      payload: { departmentId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().departmentId).toBe(departmentId);
  }

  beforeEach(async () => {
    // Segunda raiz do tenant A: o DESTINO do move.
    await testDb.db`
      INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
      VALUES (${DEPT_A2_ID}, ${TENANT_A}, NULL, 'Dept A2', 0, '{}'::text[], false, NOW())
    `;

    await seedUser(testDb.db, {
      id: UPLOADER_ORIGEM_ID,
      tenantId: TENANT_A,
      email: 'up-origem@empresa.com',
      password: PASSWORD,
      role: 'UPLOADER',
    });
    await seedUser(testDb.db, {
      id: UPLOADER_DESTINO_ID,
      tenantId: TENANT_A,
      email: 'up-destino@empresa.com',
      password: PASSWORD,
      role: 'UPLOADER',
    });
    await seedUser(testDb.db, {
      id: SUPER_ID,
      tenantId: null,
      email: 'super@plataforma.com',
      password: PASSWORD,
      role: 'SUPER_ADMIN',
    });

    // ACL por RAIZ: cada UPLOADER com exatamente um dos lados do move.
    await testDb.db`
      INSERT INTO department_permissions (id, tenant_id, user_id, department_id, can_read, can_write, deleted)
      VALUES
        (${crypto.randomUUID()}, ${TENANT_A}, ${UPLOADER_ORIGEM_ID}, ${DEPT_A_ID}, true, true, false),
        (${crypto.randomUUID()}, ${TENANT_A}, ${UPLOADER_DESTINO_ID}, ${DEPT_A2_ID}, true, true, false)
    `;

    // Documento movido: nasce READY no DEPT_A, com o needle de metadado na tag.
    // Isca: já nasce no DEPT_A2, SEM nenhum dos needles.
    await testDb.db`
      INSERT INTO documents (
        id, tenant_id, department_id, document_type_id,
        filename, original_filename, title, suggested_title,
        content_hash, size_bytes, mime_type, storage_key, status, tags, index_values,
        uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
      ) VALUES
        (
          ${DOC_MOVIDO_ID}, ${TENANT_A}, ${DEPT_A_ID}, NULL,
          'movido.pdf', 'movido.pdf', 'Documento Movido', NULL,
          ${'e'.repeat(64)}, 1024, 'application/pdf', ${`tenants/${TENANT_A}/${DOC_MOVIDO_ID}.pdf`},
          'READY', ${[`${META_NEEDLE}-fase-9`]}::text[], '{}'::jsonb,
          ${ADMIN_A_ID}, NOW(), NOW(), 0, false
        ),
        (
          ${DOC_ISCA_ID}, ${TENANT_A}, ${DEPT_A2_ID}, NULL,
          'isca.pdf', 'isca.pdf', 'Documento Isca', NULL,
          ${'f'.repeat(64)}, 1024, 'application/pdf', ${`tenants/${TENANT_A}/${DOC_ISCA_ID}.pdf`},
          'READY', '{}'::text[], '{}'::jsonb,
          ${ADMIN_A_ID}, NOW(), NOW(), 0, false
        )
    `;

    await testDb.db`
      INSERT INTO chunks (document_id, tenant_id, department_id, document_type_name, page_number, chunk_index, text, embedding, token_count)
      VALUES
        (${DOC_MOVIDO_ID}, ${TENANT_A}, ${DEPT_A_ID}, NULL, 1, 0, ${TEXTO_CHUNK_MOVIDO}, ${EMBEDDING_MOVIDO}::vector, 7),
        (${DOC_ISCA_ID}, ${TENANT_A}, ${DEPT_A2_ID}, NULL, 1, 0, 'texto neutro da isca', ${EMBEDDING_ISCA}::vector, 4)
    `;

    tokenOrigem = await login('up-origem@empresa.com');
    tokenDestino = await login('up-destino@empresa.com');
    tokenSuper = await login('super@plataforma.com');
  });

  it('quem tem acesso só à raiz NOVA passa a receber o chunk depois do move', async () => {
    // Baseline: antes do move o documento é invisível para o destino — sem isso
    // a asserção de depois passaria mesmo com a busca quebrada.
    const antes = await searchByChunkPath(tokenDestino, META_NEEDLE);
    expect(antes.chunks.some((c) => c.documentId === DOC_MOVIDO_ID)).toBe(false);
    expect(antes.raw).not.toContain(CHUNK_NEEDLE);

    await moveDocumento(adminAToken, DOC_MOVIDO_ID, DEPT_A2_ID);

    // A invariante nas duas tabelas: é o `department_id` do CHUNK que o SQL do
    // ramo de metadados filtra. Se o move não o reescrevesse, o chunk sumiria
    // para os dois lados (o caso do último teste deste bloco).
    expect(await chunkDepartments(DOC_MOVIDO_ID)).toEqual([DEPT_A2_ID]);

    const depois = await searchByChunkPath(tokenDestino, META_NEEDLE);
    const movido = depois.chunks.find((c) => c.documentId === DOC_MOVIDO_ID);
    expect(movido).toBeDefined();
    expect(movido!.text).toBe(TEXTO_CHUNK_MOVIDO);
    expect(movido!.documentName).toBe('movido.pdf');
    expect(movido!.title).toBe('Documento Movido');
  });

  it('quem tem acesso só à raiz ANTIGA deixa de receber o chunk — e o texto dele', async () => {
    // Baseline: antes do move a origem enxerga o documento.
    const antes = await searchByChunkPath(tokenOrigem, META_NEEDLE);
    expect(antes.chunks.some((c) => c.documentId === DOC_MOVIDO_ID)).toBe(true);
    expect(antes.raw).toContain(CHUNK_NEEDLE);

    await moveDocumento(adminAToken, DOC_MOVIDO_ID, DEPT_A2_ID);

    const depois = await searchByChunkPath(tokenOrigem, META_NEEDLE);
    expect(depois.chunks.some((c) => c.documentId === DOC_MOVIDO_ID)).toBe(false);
    // Não basta sumir da lista: o TEXTO é o payload que vai para a tela e para o
    // prompt do LLM — ele não pode sobrar em canto nenhum da resposta.
    expect(depois.raw).not.toContain(CHUNK_NEEDLE);
    expect(depois.raw).not.toContain(TEXTO_CHUNK_MOVIDO);

    // Nem buscando pelo próprio texto do chunk, que é a tentativa óbvia.
    const porTexto = await searchByChunkPath(tokenOrigem, CHUNK_NEEDLE);
    expect(porTexto.chunks.some((c) => c.documentId === DOC_MOVIDO_ID)).toBe(false);
    expect(porTexto.raw).not.toContain(CHUNK_NEEDLE);
  });

  it('TENANT_ADMIN (ramo sem filtro de departamento) recebe o chunk no departamento novo', async () => {
    await moveDocumento(adminAToken, DOC_MOVIDO_ID, DEPT_A2_ID);

    // Variante `singleTenantId` com `allowedDepartmentIds === null`
    // (routes/search.ts:599-606): sem cláusula de departamento, mas ainda presa
    // ao tenant. O move não pode esconder o documento de quem vê tudo.
    const { chunks } = await searchByChunkPath(adminAToken, META_NEEDLE);
    const movido = chunks.find((c) => c.documentId === DOC_MOVIDO_ID);
    expect(movido).toBeDefined();
    expect(movido!.text).toBe(TEXTO_CHUNK_MOVIDO);
    expect(movido!.tenantId).toBe(TENANT_A);
  });

  it('SUPER_ADMIN (ramo sem filtro de tenant) recebe o chunk e nada do outro tenant', async () => {
    await moveDocumento(adminAToken, DOC_MOVIDO_ID, DEPT_A2_ID);

    // Variante sem tenant nenhum no WHERE (routes/search.ts:609-614).
    const { chunks, raw } = await searchByChunkPath(tokenSuper, META_NEEDLE);
    const movido = chunks.find((c) => c.documentId === DOC_MOVIDO_ID);
    expect(movido).toBeDefined();
    expect(movido!.text).toBe(TEXTO_CHUNK_MOVIDO);

    // A query de metadado casa só no documento movido: nada do tenant B entra
    // de carona por o ramo não ter filtro de tenant.
    expect(chunks.some((c) => c.documentId === DOC_B_ID)).toBe(false);
    expect(raw).not.toContain('CONFIDENCIAL-B');
  });

  it('o filtro é pelo departamento do CHUNK: chunk deixado para trás não volta pelo metadado', async () => {
    await moveDocumento(adminAToken, DOC_MOVIDO_ID, DEPT_A2_ID);

    // Regressão simulada: `documents` foi movido e `chunks` ficou para trás —
    // exatamente o estado que a invariante do épico proíbe. O corte do ramo de
    // metadados tem de vir do departamento do CHUNK; se algum dia esse filtro
    // passar a olhar o departamento do DOCUMENTO (ou for embora), este teste
    // quebra — que é o ponto dele.
    await testDb.db`
      UPDATE chunks SET department_id = ${DEPT_A_ID} WHERE document_id = ${DOC_MOVIDO_ID}
    `;

    // O destino casa o documento por metadado (o `documents.department_id` é o
    // novo), mas o chunk está fora da ACL dele: some, não vaza.
    const destino = await searchByChunkPath(tokenDestino, META_NEEDLE);
    expect(destino.chunks.some((c) => c.documentId === DOC_MOVIDO_ID)).toBe(false);
    expect(destino.raw).not.toContain(CHUNK_NEEDLE);

    // Nada é afirmado aqui sobre a ORIGEM de propósito: no estado desincronizado
    // o chunk ainda diz pertencer ao departamento antigo e volta para ela pelo
    // ramo de CONTEÚDO — é justamente o vazamento que a invariante do épico
    // existe para impedir (medido em
    // packages/db-pg/src/search-moved-document.test.ts), não um comportamento a
    // congelar em asserção.
  });
});
