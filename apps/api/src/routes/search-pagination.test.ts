import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import {
  startTestDb,
  seedUser,
  testConfig,
  resetDomainTables,
  type TestDb,
} from '../test/helpers.js';

/**
 * Testes E2E da PAGINAÇÃO da busca (T-63, épico E-5).
 *
 * O que esta suíte prova, contra PostgreSQL real e pelo HTTP (`POST /search`):
 *
 *  - a página é de DOCUMENTO, não de chunk: 25 documentos × 3 chunks casando o
 *    mesmo termo devolvem `total: 25`, nunca 75;
 *  - a navegação é estável e completa: a união das páginas é exatamente o
 *    conjunto casado, sem duplicata nem buraco, INCLUSIVE atravessando blocos de
 *    score empatado (o tiebreaker `document_id ASC` da query paginada);
 *  - o `total` respeita o isolamento — este é o ponto central do épico. Um
 *    `total` calculado fora das CTEs filtradas VAZA informação (quantos
 *    documentos a outra empresa tem) mesmo quando nenhum item vaza. Os casos 6 e
 *    7 existem para falhar se alguém mover o filtro de tenant/departamento para
 *    fora das CTEs de `searchDocumentsPaged`.
 *
 * `searchMode: 'lexical'` em todos os casos: é o único modo paginado (T-62) e
 * não toca no cliente OpenAI — nenhum mock necessário.
 *
 * O seed é montado UMA vez (`beforeAll`): todos os casos são de leitura.
 */

// ---------------------------------------------------------------------------
// Termos e constantes do seed
// ---------------------------------------------------------------------------

/** Termo distintivo da busca. Não é stopword e não colide com o resto do seed. */
const NEEDLE = 'zorblax';

/** Tag usada no caso 11 (filtro estruturado por tag). */
const LOTE_TAG = 'lote-x';

const PASSWORD = 'senha-muito-secreta-123';

const EMBEDDING = `[${Array.from({ length: 1536 }, () => 0).join(',')}]`;

const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();

/** Dois departamentos RAIZ em A: a ACL do USER cobre só o primeiro. */
const DEPT_A1 = crypto.randomUUID();
const DEPT_A2 = crypto.randomUUID();
const DEPT_B = crypto.randomUUID();

const ADMIN_A_ID = crypto.randomUUID();
const ADMIN_B_ID = crypto.randomUUID();
/** MTA com acesso só à empresa A. */
const MTA_ONE_ID = crypto.randomUUID();
/** MTA com acesso a A e B. */
const MTA_BOTH_ID = crypto.randomUUID();
/** USER de A com permissão de leitura apenas em DEPT_A1. */
const USER_A1_ID = crypto.randomUUID();

// --- Os 25 documentos de A que casam com o termo -----------------------------

/** 8 documentos com o termo no conteúdo, repetido 12..5 vezes → scores distintos. */
const CONTENT_IDS: string[] = Array.from({ length: 8 }, () => crypto.randomUUID());
/** Documento cujo MELHOR chunk é o de índice 2 (termo repetido lá, não no 0). */
const CHUNK2_ID = crypto.randomUUID();
/** Documento que casa nos DOIS ramos: conteúdo e metadado (tag). */
const OVERLAP_ID = crypto.randomUUID();
/** 6 documentos com texto IDÊNTICO → empate exato de `ts_rank`. */
const TIED_IDS: string[] = Array.from({ length: 6 }, () => crypto.randomUUID());
/** 8 documentos em que o termo só existe em tag / filename / indexValues. */
const META_IDS: string[] = Array.from({ length: 8 }, () => crypto.randomUUID());
/** Documento READY SEM NENHUM chunk, com o termo na tag (contrato da T-59). */
const NOCHUNKS_ID = crypto.randomUUID();

/**
 * Ordem canônica dos 25. Também define o valor do índice `ordem` (1..25), usado
 * no caso 11 — `ordem >= 20` recorta META_IDS[3..7] + NOCHUNKS (6 documentos).
 */
const MATCHING_IDS: string[] = [
  ...CONTENT_IDS,
  CHUNK2_ID,
  OVERLAP_ID,
  ...TIED_IDS,
  ...META_IDS,
  NOCHUNKS_ID,
];

/** Os 10 documentos que casam por CONTEÚDO com score distinto (> score do empate). */
const CONTENT_SCORED_IDS: string[] = [...CONTENT_IDS, CHUNK2_ID, OVERLAP_ID];
/** Os 9 documentos de score ZERO (ramo de metadados + o documento sem chunks). */
const ZERO_SCORE_IDS: string[] = [...META_IDS, NOCHUNKS_ID];

/** Documentos de A que ficam em DEPT_A2 — invisíveis para o USER de DEPT_A1. */
const DEPT_A2_IDS: string[] = [
  CONTENT_IDS[6]!,
  CONTENT_IDS[7]!,
  OVERLAP_ID,
  TIED_IDS[4]!,
  TIED_IDS[5]!,
  META_IDS[6]!,
  META_IDS[7]!,
];
/** Os 18 documentos casados que ficam em DEPT_A1. */
const DEPT_A1_MATCHING_IDS: string[] = MATCHING_IDS.filter((id) => !DEPT_A2_IDS.includes(id));

// --- Ruído: documentos de A que NÃO podem entrar no total --------------------

/** 3 documentos de A que não casam com o termo (mas casam no filtro do caso 11). */
const NOISE_IDS: string[] = Array.from({ length: 3 }, () => crypto.randomUUID());
/** Documento PENDING com o termo no conteúdo e na tag — não é READY, não conta. */
const PENDING_ID = crypto.randomUUID();
/** Documento soft-deletado com o termo no conteúdo e na tag — não conta. */
const DELETED_ID = crypto.randomUUID();

/** 40 documentos da empresa B com o MESMO termo no conteúdo. */
const TENANT_B_IDS: string[] = Array.from({ length: 40 }, () => crypto.randomUUID());

/** Documentos que carregam a tag do caso 11 (5 casados + 2 ruídos + 3 de B). */
const LOTE_TAGGED_MATCHING: string[] = [
  CONTENT_IDS[0]!,
  CONTENT_IDS[7]!,
  TIED_IDS[0]!,
  META_IDS[0]!,
  NOCHUNKS_ID,
];

// ---------------------------------------------------------------------------
// Tipos da resposta
// ---------------------------------------------------------------------------

interface RespChunk {
  documentId: string;
  documentName: string | null;
  title: string | null;
  tags: string[];
  tenantId: string;
  documentTypeName: string | null;
  pageNumber: number | null;
  chunkIndex: number;
  text: string;
  score: number;
}

interface SearchBody {
  answer: string | null;
  chunks: RespChunk[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
  costUsd: number;
}

let app: FastifyInstance;
let testDb: TestDb;

const tokens: Record<string, string> = {};

// ---------------------------------------------------------------------------
// Helpers de seed
// ---------------------------------------------------------------------------

/**
 * Texto com o termo repetido `times` vezes. `ts_rank` cresce estritamente com a
 * frequência do lexema, então a frequência é o controle exato do score — sem
 * depender de valores mágicos.
 */
function needleText(times: number, filler: string): string {
  return `${filler} ${Array.from({ length: times }, () => NEEDLE).join(' ')} do arquivo`;
}

/** Texto SEM o termo — para chunks de documentos que só casam por metadado. */
function plainText(seed: string): string {
  return `relatorio administrativo ${seed} sem palavra alguma de interesse`;
}

/** Texto IDÊNTICO nos 6 documentos empatados: mesmo tsvector → mesmo ts_rank. */
const TIED_TEXT = needleText(1, 'bloco empatado exatamente igual');

interface InsertDocInput {
  id: string;
  tenantId: string;
  departmentId: string;
  uploaderId: string;
  originalFilename: string;
  tags?: string[];
  indexValues?: Record<string, string | number>;
  status?: string;
  deleted?: boolean;
}

async function insertDocument(input: InsertDocInput): Promise<void> {
  const hex = input.id.replace(/-/g, '');
  await testDb.db`
    INSERT INTO documents (
      id, tenant_id, department_id, document_type_id,
      filename, original_filename, title, suggested_title,
      content_hash, size_bytes, mime_type, s3_key, status, tags, index_values,
      uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
    ) VALUES (
      ${input.id}, ${input.tenantId}, ${input.departmentId}, NULL,
      ${input.originalFilename}, ${input.originalFilename}, NULL, NULL,
      ${`${hex}${hex}`}, 1024, 'application/pdf',
      ${`tenants/${input.tenantId}/${input.id}.pdf`},
      ${input.status ?? 'READY'}, ${input.tags ?? []}::text[],
      ${testDb.db.json(input.indexValues ?? {})},
      ${input.uploaderId}, NOW(), NOW(), 0, ${input.deleted ?? false}
    )
  `;
}

async function insertChunks(
  documentId: string,
  tenantId: string,
  departmentId: string,
  texts: string[],
): Promise<void> {
  for (const [index, text] of texts.entries()) {
    await testDb.db`
      INSERT INTO chunks (
        document_id, tenant_id, department_id, document_type_name,
        page_number, chunk_index, text, embedding, token_count
      ) VALUES (
        ${documentId}, ${tenantId}, ${departmentId}, NULL,
        ${index + 1}, ${index}, ${text}, ${EMBEDDING}::vector, 10
      )
    `;
  }
}

function deptOf(id: string): string {
  return DEPT_A2_IDS.includes(id) ? DEPT_A2 : DEPT_A1;
}

function ordemOf(id: string): number {
  return MATCHING_IDS.indexOf(id) + 1;
}

function tagsOf(id: string, extra: string[] = []): string[] {
  return LOTE_TAGGED_MATCHING.includes(id) ? [...extra, LOTE_TAG] : extra;
}

// ---------------------------------------------------------------------------
// Helpers de request
// ---------------------------------------------------------------------------

async function login(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return res.json().accessToken as string;
}

type SearchPayload = Record<string, unknown>;

async function rawSearch(token: string, payload: SearchPayload) {
  return app.inject({
    method: 'POST',
    url: '/search',
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

/** Busca lexical bem-sucedida — falha o teste se não vier 200. */
async function search(token: string, payload: SearchPayload): Promise<SearchBody> {
  const res = await rawSearch(token, { query: NEEDLE, searchMode: 'lexical', ...payload });
  expect(res.statusCode).toBe(200);
  return res.json() as SearchBody;
}

interface Sweep {
  /** Documentos na ordem em que apareceram, página após página. */
  ordered: string[];
  pages: string[][];
  total: number;
  pageCount: number;
}

/** Percorre TODAS as páginas de uma busca e devolve a sequência completa. */
async function sweep(
  token: string,
  pageSize: number,
  extra: SearchPayload = {},
): Promise<Sweep> {
  const first = await search(token, { ...extra, page: 1, pageSize });
  const pages: string[][] = [first.chunks.map((c) => c.documentId)];

  for (let page = 2; page <= first.pageCount; page += 1) {
    const body = await search(token, { ...extra, page, pageSize });
    expect(body.total).toBe(first.total);
    expect(body.pageCount).toBe(first.pageCount);
    pages.push(body.chunks.map((c) => c.documentId));
  }

  return {
    ordered: pages.flat(),
    pages,
    total: first.total,
    pageCount: first.pageCount,
  };
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

beforeAll(async () => {
  testDb = await startTestDb();
  app = await buildApp({ config: testConfig(), db: testDb.db });

  await resetDomainTables(testDb.db);

  await testDb.db`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
    VALUES
      (${TENANT_A}, 'Empresa A', ${10 * 1024 ** 3}, 200, true, NOW()),
      (${TENANT_B}, 'Empresa B', ${10 * 1024 ** 3}, 200, true, NOW())
  `;

  await testDb.db`
    INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
    VALUES
      (${DEPT_A1}, ${TENANT_A}, NULL, 'Fiscal A1', 0, '{}'::text[], false, NOW()),
      (${DEPT_A2}, ${TENANT_A}, NULL, 'Juridico A2', 0, '{}'::text[], false, NOW()),
      (${DEPT_B}, ${TENANT_B}, NULL, 'Dept B', 0, '{}'::text[], false, NOW())
  `;

  await seedUser(testDb.db, {
    id: ADMIN_A_ID,
    tenantId: TENANT_A,
    email: 'admin-a@empresa.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
  });
  await seedUser(testDb.db, {
    id: ADMIN_B_ID,
    tenantId: TENANT_B,
    email: 'admin-b@empresa.com',
    password: PASSWORD,
    role: 'TENANT_ADMIN',
  });
  await seedUser(testDb.db, {
    id: MTA_ONE_ID,
    tenantId: null,
    email: 'mta-um@plataforma.com',
    password: PASSWORD,
    role: 'MULTI_TENANT_ADMIN',
    allowedTenantIds: [TENANT_A],
  });
  await seedUser(testDb.db, {
    id: MTA_BOTH_ID,
    tenantId: null,
    email: 'mta-dois@plataforma.com',
    password: PASSWORD,
    role: 'MULTI_TENANT_ADMIN',
    allowedTenantIds: [TENANT_A, TENANT_B],
  });
  await seedUser(testDb.db, {
    id: USER_A1_ID,
    tenantId: TENANT_A,
    email: 'user-a1@empresa.com',
    password: PASSWORD,
    role: 'USER',
  });

  // ACL: o USER lê apenas a raiz DEPT_A1 (DEPT_A2 é outra raiz, fora da subárvore).
  await testDb.db`
    INSERT INTO department_permissions (id, tenant_id, user_id, department_id, can_read, can_write, deleted)
    VALUES (${crypto.randomUUID()}, ${TENANT_A}, ${USER_A1_ID}, ${DEPT_A1}, true, false, false)
  `;

  // --- 8 documentos com score de conteúdo distinto (frequência 12..5) --------
  for (const [i, id] of CONTENT_IDS.entries()) {
    await insertDocument({
      id,
      tenantId: TENANT_A,
      departmentId: deptOf(id),
      uploaderId: ADMIN_A_ID,
      originalFilename: `contrato-conteudo-${i}.pdf`,
      tags: tagsOf(id, ['conteudo']),
      indexValues: { ordem: ordemOf(id), referencia: `REF-C-${i}` },
    });
    await insertChunks(id, TENANT_A, deptOf(id), [
      needleText(12 - i, `pagina inicial ${i}`),
      needleText(1, `pagina do meio ${i}`),
      needleText(1, `pagina final ${i}`),
    ]);
  }

  // --- Documento cujo MELHOR chunk é o de índice 2 ---------------------------
  await insertDocument({
    id: CHUNK2_ID,
    tenantId: TENANT_A,
    departmentId: deptOf(CHUNK2_ID),
    uploaderId: ADMIN_A_ID,
    originalFilename: 'contrato-melhor-chunk.pdf',
    tags: tagsOf(CHUNK2_ID, ['conteudo']),
    indexValues: { ordem: ordemOf(CHUNK2_ID), referencia: 'REF-CH2' },
  });
  await insertChunks(CHUNK2_ID, TENANT_A, deptOf(CHUNK2_ID), [
    needleText(1, 'capa do documento'),
    needleText(1, 'sumario do documento'),
    needleText(4, 'corpo do documento'),
  ]);

  // --- Documento que casa nos DOIS ramos (conteúdo E tag) -------------------
  await insertDocument({
    id: OVERLAP_ID,
    tenantId: TENANT_A,
    departmentId: deptOf(OVERLAP_ID),
    uploaderId: ADMIN_A_ID,
    originalFilename: 'contrato-overlap.pdf',
    tags: tagsOf(OVERLAP_ID, [`${NEEDLE}-tambem-na-tag`]),
    indexValues: { ordem: ordemOf(OVERLAP_ID), referencia: 'REF-OV' },
  });
  await insertChunks(OVERLAP_ID, TENANT_A, deptOf(OVERLAP_ID), [
    needleText(3, 'documento que casa duas vezes'),
    plainText('overlap-1'),
    plainText('overlap-2'),
  ]);

  // --- 6 documentos com texto IDÊNTICO (empate exato de score) --------------
  for (const [i, id] of TIED_IDS.entries()) {
    await insertDocument({
      id,
      tenantId: TENANT_A,
      departmentId: deptOf(id),
      uploaderId: ADMIN_A_ID,
      originalFilename: `empate-${i}.pdf`,
      tags: tagsOf(id, ['empate']),
      indexValues: { ordem: ordemOf(id), referencia: `REF-T-${i}` },
    });
    await insertChunks(id, TENANT_A, deptOf(id), [TIED_TEXT, TIED_TEXT, TIED_TEXT]);
  }

  // --- 8 documentos que casam SÓ por metadado -------------------------------
  //  0..2 → tag        3..5 → original_filename        6..7 → index_values
  for (const [i, id] of META_IDS.entries()) {
    const viaTag = i < 3;
    const viaFilename = i >= 3 && i < 6;
    await insertDocument({
      id,
      tenantId: TENANT_A,
      departmentId: deptOf(id),
      uploaderId: ADMIN_A_ID,
      originalFilename: viaFilename ? `relatorio-${NEEDLE}-${i}.pdf` : `relatorio-meta-${i}.pdf`,
      tags: tagsOf(id, viaTag ? [`${NEEDLE}-lote`] : ['meta']),
      indexValues: viaFilename || viaTag
        ? { ordem: ordemOf(id), referencia: `REF-M-${i}` }
        : { ordem: ordemOf(id), referencia: `${NEEDLE}/2026-${i}` },
    });
    await insertChunks(id, TENANT_A, deptOf(id), [
      plainText(`meta-${i}-a`),
      plainText(`meta-${i}-b`),
      plainText(`meta-${i}-c`),
    ]);
  }

  // --- Documento READY SEM chunks, com o termo na tag -----------------------
  await insertDocument({
    id: NOCHUNKS_ID,
    tenantId: TENANT_A,
    departmentId: deptOf(NOCHUNKS_ID),
    uploaderId: ADMIN_A_ID,
    originalFilename: 'escaneado-sem-texto.pdf',
    tags: tagsOf(NOCHUNKS_ID, [`${NEEDLE}-sem-chunk`]),
    indexValues: { ordem: ordemOf(NOCHUNKS_ID), referencia: 'REF-NC' },
  });

  // --- Ruído de A: não casa com o termo (mas 2 deles casam no filtro do 11) --
  for (const [i, id] of NOISE_IDS.entries()) {
    await insertDocument({
      id,
      tenantId: TENANT_A,
      departmentId: DEPT_A1,
      uploaderId: ADMIN_A_ID,
      originalFilename: `ruido-${i}.pdf`,
      tags: i < 2 ? [LOTE_TAG] : [],
      indexValues: { ordem: 90 + i, referencia: `REF-N-${i}` },
    });
    await insertChunks(id, TENANT_A, DEPT_A1, [plainText(`ruido-${i}`)]);
  }

  // --- PENDING e soft-deletado: casam pelo termo, mas NÃO podem contar ------
  await insertDocument({
    id: PENDING_ID,
    tenantId: TENANT_A,
    departmentId: DEPT_A1,
    uploaderId: ADMIN_A_ID,
    originalFilename: `pendente-${NEEDLE}.pdf`,
    tags: [`${NEEDLE}-pendente`],
    indexValues: { ordem: 93, referencia: 'REF-P' },
    status: 'PENDING',
  });
  await insertChunks(PENDING_ID, TENANT_A, DEPT_A1, [needleText(6, 'documento pendente')]);

  await insertDocument({
    id: DELETED_ID,
    tenantId: TENANT_A,
    departmentId: DEPT_A1,
    uploaderId: ADMIN_A_ID,
    originalFilename: `apagado-${NEEDLE}.pdf`,
    tags: [`${NEEDLE}-apagado`],
    indexValues: { ordem: 94, referencia: 'REF-D' },
    deleted: true,
  });
  await insertChunks(DELETED_ID, TENANT_A, DEPT_A1, [needleText(6, 'documento apagado')]);

  // --- Empresa B: 40 documentos com o MESMO termo ---------------------------
  for (const [i, id] of TENANT_B_IDS.entries()) {
    await insertDocument({
      id,
      tenantId: TENANT_B,
      departmentId: DEPT_B,
      uploaderId: ADMIN_B_ID,
      originalFilename: `empresa-b-${i}.pdf`,
      tags: i < 3 ? [LOTE_TAG] : [],
      indexValues: { ordem: 100 + i, referencia: `REF-B-${i}` },
    });
    await insertChunks(id, TENANT_B, DEPT_B, [needleText(2, `documento b ${i}`)]);
  }

  tokens['adminA'] = await login('admin-a@empresa.com');
  tokens['mtaOne'] = await login('mta-um@plataforma.com');
  tokens['mtaBoth'] = await login('mta-dois@plataforma.com');
  tokens['userA1'] = await login('user-a1@empresa.com');
}, 240_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

// ---------------------------------------------------------------------------
// Casos
// ---------------------------------------------------------------------------

describe('POST /search — paginação por documento (T-63)', () => {
  it('caso 1: total é de DOCUMENTOS (25), não de chunks (75), com pageCount coerente', async () => {
    const body = await search(tokens['adminA']!, { page: 1, pageSize: 10 });

    // 25 documentos casados × 3 chunks cada = 75 chunks. O total é 25.
    expect(body.total).toBe(25);
    expect(body.pageCount).toBe(3);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(10);
    expect(body.chunks).toHaveLength(10);

    // Uma linha por documento — nenhuma repetição dentro da página.
    const ids = body.chunks.map((c) => c.documentId);
    expect(new Set(ids).size).toBe(ids.length);

    // Ruído, PENDING e soft-deletado nunca entram (o semi-join de `filtered`
    // acontece ANTES da contagem).
    const sweepAll = await sweep(tokens['adminA']!, 10);
    for (const excluded of [...NOISE_IDS, PENDING_ID, DELETED_ID]) {
      expect(sweepAll.ordered).not.toContain(excluded);
    }
  });

  it('caso 2: o documento com o termo no chunk 2 volta com chunkIndex 2 (melhor chunk)', async () => {
    const body = await search(tokens['adminA']!, { page: 1, pageSize: 10 });

    const item = body.chunks.find((c) => c.documentId === CHUNK2_ID);
    expect(item).toBeDefined();
    expect(item!.chunkIndex).toBe(2);
    expect(item!.text).toContain('corpo do documento');

    // Contraste: nos documentos de conteúdo o melhor chunk é o 0.
    const plain = body.chunks.find((c) => c.documentId === CONTENT_IDS[0]);
    expect(plain!.chunkIndex).toBe(0);
  });

  it('caso 3: união das páginas = 25 ids distintos, sem duplicata nem buraco', async () => {
    const result = await sweep(tokens['adminA']!, 10);

    expect(result.pageCount).toBe(3);
    expect(result.ordered).toHaveLength(25);
    expect(new Set(result.ordered).size).toBe(25);
    expect(new Set(result.ordered)).toEqual(new Set(MATCHING_IDS));

    // Interseções par-a-par vazias.
    for (let i = 0; i < result.pages.length; i += 1) {
      for (let j = i + 1; j < result.pages.length; j += 1) {
        const overlap = result.pages[i]!.filter((id) => result.pages[j]!.includes(id));
        expect(overlap).toEqual([]);
      }
    }
  });

  it('caso 3b: o bloco de 6 documentos com score EMPATADO atravessa páginas sem se perder', async () => {
    // pageSize 4 põe fronteiras em 4/8/12/16/20/24. O bloco empatado ocupa as
    // posições 11..16 do ranking global — atravessa DUAS fronteiras. Sem o
    // tiebreaker `document_id ASC` é aqui que aparecem duplicatas e buracos.
    const result = await sweep(tokens['adminA']!, 4);

    expect(result.total).toBe(25);
    expect(result.pageCount).toBe(7);
    expect(result.ordered).toHaveLength(25);
    expect(new Set(result.ordered).size).toBe(25);

    // Cada empatado aparece exatamente uma vez...
    for (const id of TIED_IDS) {
      expect(result.ordered.filter((x) => x === id)).toHaveLength(1);
    }

    // ...e o bloco vem contíguo, na ordem determinística do desempate por id.
    const positions = TIED_IDS.map((id) => result.ordered.indexOf(id)).sort((a, b) => a - b);
    expect(positions[positions.length - 1]! - positions[0]!).toBe(TIED_IDS.length - 1);
    const tiedInOrder = result.ordered.filter((id) => TIED_IDS.includes(id));
    expect(tiedInOrder).toEqual([...TIED_IDS].sort());

    // O bloco realmente atravessa fronteira de página (não está todo numa só).
    const pagesTouched = result.pages.filter((p) => p.some((id) => TIED_IDS.includes(id)));
    expect(pagesTouched.length).toBeGreaterThan(1);

    // E os scores são de fato iguais entre eles (empate exato, não aproximado).
    const bodies = await Promise.all(
      [1, 2, 3].map((page) => search(tokens['adminA']!, { page, pageSize: 10 })),
    );
    const allChunks = bodies.flatMap((b) => b.chunks);
    const tiedScores = allChunks
      .filter((c) => TIED_IDS.includes(c.documentId))
      .map((c) => c.score);
    expect(tiedScores).toHaveLength(6);
    expect(new Set(tiedScores).size).toBe(1);
  });

  it('caso 4: pedir a mesma página duas vezes devolve exatamente a mesma lista', async () => {
    const first = await search(tokens['adminA']!, { page: 2, pageSize: 10 });
    const second = await search(tokens['adminA']!, { page: 2, pageSize: 10 });

    expect(second.chunks.map((c) => c.documentId)).toEqual(
      first.chunks.map((c) => c.documentId),
    );
    expect(second.total).toBe(first.total);
    expect(second.pageCount).toBe(first.pageCount);
  });

  it('caso 5: última página parcial (5 itens) e página além do fim (0 itens, total preservado)', async () => {
    const last = await search(tokens['adminA']!, { page: 3, pageSize: 10 });
    expect(last.chunks).toHaveLength(5);
    expect(last.total).toBe(25);
    expect(last.pageCount).toBe(3);

    const beyond = await search(tokens['adminA']!, { page: 4, pageSize: 10 });
    expect(beyond.chunks).toEqual([]);
    // O `total` NÃO pode zerar só porque a página está além do fim — é o
    // fallback de contagem da T-59.
    expect(beyond.total).toBe(25);
    expect(beyond.pageCount).toBe(3);
    expect(beyond.page).toBe(4);
  });

  it('caso 6: o TOTAL respeita o isolamento multi-tenant (não só os itens)', async () => {
    // TENANT_ADMIN de A: 25, jamais 65 (A tem 25 casados, B tem 40).
    const adminA = await search(tokens['adminA']!, { page: 1, pageSize: 10 });
    expect(adminA.total).toBe(25);
    expect(adminA.pageCount).toBe(3);

    // MTA restrito a [A]: enxerga exatamente o mesmo universo do admin de A.
    const mtaOne = await search(tokens['mtaOne']!, { page: 1, pageSize: 10 });
    expect(mtaOne.total).toBe(25);
    expect(mtaOne.pageCount).toBe(3);

    // MTA com [A, B]: 25 + 40 = 65.
    const mtaBoth = await search(tokens['mtaBoth']!, { page: 1, pageSize: 10 });
    expect(mtaBoth.total).toBe(65);
    expect(mtaBoth.pageCount).toBe(7);

    // Os ITENS também não vazam — nem numa varredura completa.
    const sweepAdminA = await sweep(tokens['adminA']!, 10);
    const sweepMtaOne = await sweep(tokens['mtaOne']!, 10);
    for (const bId of TENANT_B_IDS) {
      expect(sweepAdminA.ordered).not.toContain(bId);
      expect(sweepMtaOne.ordered).not.toContain(bId);
    }

    const pageAdminA = await search(tokens['adminA']!, { page: 1, pageSize: 100 });
    expect(pageAdminA.chunks.every((c) => c.tenantId === TENANT_A)).toBe(true);

    // O MTA com os dois tenants vê os dois — prova que o 25 acima é filtro, e
    // não coincidência de o termo não casar em B.
    const pageMtaBoth = await search(tokens['mtaBoth']!, { page: 1, pageSize: 100 });
    const tenantsSeen = new Set(pageMtaBoth.chunks.map((c) => c.tenantId));
    expect(tenantsSeen).toEqual(new Set([TENANT_A, TENANT_B]));
  });

  it('caso 7: o TOTAL respeita a ACL de departamento (USER só de DEPT_A1)', async () => {
    const body = await search(tokens['userA1']!, { page: 1, pageSize: 10 });

    // 18 dos 25 casados estão em DEPT_A1 — o total NÃO pode ser 25.
    expect(DEPT_A1_MATCHING_IDS).toHaveLength(18);
    expect(body.total).toBe(18);
    expect(body.pageCount).toBe(2);

    const result = await sweep(tokens['userA1']!, 10);
    expect(result.ordered).toHaveLength(18);
    expect(new Set(result.ordered)).toEqual(new Set(DEPT_A1_MATCHING_IDS));

    // Nenhum documento de DEPT_A2 (nem de outra empresa) aparece.
    for (const id of DEPT_A2_IDS) {
      expect(result.ordered).not.toContain(id);
    }
    for (const id of TENANT_B_IDS) {
      expect(result.ordered).not.toContain(id);
    }
  });

  it('caso 8: ramo de metadados unificado — os 8 entram no total, com score 0 e depois do conteúdo', async () => {
    const result = await sweep(tokens['adminA']!, 10);

    for (const id of META_IDS) {
      expect(result.ordered).toContain(id);
    }

    // Todo documento de score 0 vem DEPOIS de todo documento de conteúdo.
    const lastContent = Math.max(
      ...[...CONTENT_SCORED_IDS, ...TIED_IDS].map((id) => result.ordered.indexOf(id)),
    );
    const firstZero = Math.min(...ZERO_SCORE_IDS.map((id) => result.ordered.indexOf(id)));
    expect(firstZero).toBeGreaterThan(lastContent);

    // E os scores confirmam a separação (metadado = 0, conteúdo > 0).
    const bodies = await Promise.all(
      [1, 2, 3].map((page) => search(tokens['adminA']!, { page, pageSize: 10 })),
    );
    const byId = new Map(bodies.flatMap((b) => b.chunks).map((c) => [c.documentId, c]));
    for (const id of META_IDS) {
      expect(byId.get(id)!.score).toBe(0);
    }
    for (const id of CONTENT_SCORED_IDS) {
      expect(byId.get(id)!.score).toBeGreaterThan(0);
    }
    // O empate fica estritamente entre os dois grupos.
    const tiedScore = byId.get(TIED_IDS[0]!)!.score;
    expect(tiedScore).toBeGreaterThan(0);
    for (const id of CONTENT_SCORED_IDS) {
      expect(byId.get(id)!.score).toBeGreaterThan(tiedScore);
    }
  });

  it('caso 9: documento que casa nos dois ramos aparece UMA vez, com o score de conteúdo', async () => {
    const result = await sweep(tokens['adminA']!, 10);

    expect(result.ordered.filter((id) => id === OVERLAP_ID)).toHaveLength(1);

    const body = await search(tokens['adminA']!, { page: 1, pageSize: 10 });
    const item = body.chunks.find((c) => c.documentId === OVERLAP_ID);
    expect(item).toBeDefined();
    // Conteúdo vence metadado no `max(score)` — não pode virar 0.
    expect(item!.score).toBeGreaterThan(0);
    expect(item!.tags).toContain(`${NEEDLE}-tambem-na-tag`);

    // Conta 1 no total: 25 e não 26.
    expect(body.total).toBe(25);
  });

  it('caso 10: documento READY sem chunks aparece com text vazio (contrato da T-59)', async () => {
    // Página única grande: dentro do grupo de score 0 a ordem é por
    // `document_id ASC`, então em qual das páginas de 10 ele cai depende do
    // uuid sorteado — o que importa aqui é o CONTRATO do item, não a posição.
    const all = await search(tokens['adminA']!, { page: 1, pageSize: 100 });

    const item = all.chunks.find((c) => c.documentId === NOCHUNKS_ID);
    expect(item).toBeDefined();
    expect(item!.text).toBe('');
    expect(item!.chunkIndex).toBe(0);
    expect(item!.pageNumber).toBeNull();
    expect(item!.score).toBe(0);
    // O enriquecimento continua funcionando (o documento existe de verdade).
    expect(item!.documentName).toBe('escaneado-sem-texto.pdf');
    expect(item!.tags).toContain(`${NEEDLE}-sem-chunk`);
  });

  it('caso 11: filtros estruturados reduzem o total de forma coerente e a soma das páginas bate', async () => {
    // (a) Filtro por TAG: 5 dos 25 casados carregam a tag. Os 2 documentos de
    //     ruído e os 3 de B que também a carregam NÃO entram — o filtro é
    //     interseção com a busca e com o tenant, não substituto dela.
    const byTag = await sweep(tokens['adminA']!, 2, { filters: { tags: [LOTE_TAG] } });
    expect(byTag.total).toBe(5);
    expect(byTag.pageCount).toBe(3);
    expect(byTag.ordered).toHaveLength(5);
    expect(new Set(byTag.ordered)).toEqual(new Set(LOTE_TAGGED_MATCHING));

    // (b) Filtro por índice numérico: ordem >= 20 recorta 6 dos 25.
    const expectedByIndex = MATCHING_IDS.filter((id) => ordemOf(id) >= 20);
    expect(expectedByIndex).toHaveLength(6);

    const byIndex = await sweep(tokens['adminA']!, 4, {
      filters: { indexFilters: { ordem: { gte: 20 } } },
    });
    expect(byIndex.total).toBe(6);
    expect(byIndex.pageCount).toBe(2);
    expect(byIndex.ordered).toHaveLength(6);
    expect(new Set(byIndex.ordered)).toEqual(new Set(expectedByIndex));

    // (c) Filtro por departamento reduz o total do próprio admin.
    const byDept = await search(tokens['adminA']!, {
      page: 1,
      pageSize: 100,
      filters: { departmentIds: [DEPT_A2] },
    });
    expect(byDept.total).toBe(DEPT_A2_IDS.length);
    expect(new Set(byDept.chunks.map((c) => c.documentId))).toEqual(new Set(DEPT_A2_IDS));

    // (d) Combinação insatisfazível para o USER (departamento fora da ACL):
    //     200 com total 0 — nunca 403, nunca vazamento de contagem.
    const forbidden = await search(tokens['userA1']!, {
      page: 1,
      pageSize: 10,
      filters: { departmentIds: [DEPT_A2] },
    });
    expect(forbidden.total).toBe(0);
    expect(forbidden.chunks).toEqual([]);
    expect(forbidden.pageCount).toBe(0);
  });

  it('caso 12: retrocompatibilidade — request sem page/pageSize continua 200 com chunks', async () => {
    const res = await rawSearch(tokens['adminA']!, {
      query: NEEDLE,
      searchMode: 'lexical',
      generateAnswer: false,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as SearchBody;
    expect(Array.isArray(body.chunks)).toBe(true);
    // Defaults do SearchRequestSchema: page 1, pageSize 20.
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(20);
    expect(body.chunks).toHaveLength(20);
    expect(body.total).toBe(25);
    expect(body.pageCount).toBe(2);
    expect(body.answer).toBeNull();
  });

  it('caso 13: guardas de 400 — generateAnswer + page, paginação fora do lexical e profundidade', async () => {
    // (a) generateAnswer com page > 1.
    const withAnswer = await rawSearch(tokens['adminA']!, {
      query: NEEDLE,
      searchMode: 'lexical',
      generateAnswer: true,
      page: 2,
    });
    expect(withAnswer.statusCode).toBe(400);
    expect(withAnswer.json().error.code).toBe('BAD_REQUEST');

    // (b) page/pageSize em modo não-lexical. `page: 1` explícito é recusado: a
    //     rota lê o corpo CRU antes do parse do Zod, então "1 enviado" não se
    //     confunde com o default.
    for (const payload of [
      { searchMode: 'vector', page: 1 },
      { searchMode: 'vector', page: 2 },
      { searchMode: 'hybrid', pageSize: 10 },
    ]) {
      const res = await rawSearch(tokens['adminA']!, { query: NEEDLE, ...payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BAD_REQUEST');
      expect(res.json().error.message).toContain('lexical');
    }

    // Sem page/pageSize, o modo vetorial NÃO é barrado pela guarda — segue para
    // o caminho por chunk (que aqui falha por falta de credencial de embedding,
    // e é justamente isso que prova que passou da guarda).
    const vectorNoPaging = await rawSearch(tokens['adminA']!, {
      query: NEEDLE,
      searchMode: 'vector',
    });
    expect(vectorNoPaging.statusCode).not.toBe(400);

    // (c) Profundidade: a fronteira exata (page 51 × pageSize 100 = 5000) passa.
    const atLimit = await rawSearch(tokens['adminA']!, {
      query: NEEDLE,
      searchMode: 'lexical',
      page: 51,
      pageSize: 100,
    });
    expect(atLimit.statusCode).toBe(200);
    const atLimitBody = atLimit.json() as SearchBody;
    expect(atLimitBody.chunks).toEqual([]);
    expect(atLimitBody.total).toBe(25);

    // Um passo além do teto: 400.
    const beyondLimit = await rawSearch(tokens['adminA']!, {
      query: NEEDLE,
      searchMode: 'lexical',
      page: 52,
      pageSize: 100,
    });
    expect(beyondLimit.statusCode).toBe(400);
    expect(beyondLimit.json().error.code).toBe('BAD_REQUEST');
    expect(beyondLimit.json().error.message).toContain('profundidade');
  });
});
