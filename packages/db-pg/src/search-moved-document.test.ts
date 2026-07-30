import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { hybridSearch, lexicalSearch, searchDocumentsPaged, vectorSearch } from './search.js';

/**
 * ACL do documento MOVIDO de departamento (T-111, épico E-9).
 *
 * O FATO ESTRUTURAL. `chunks.department_id` é uma coluna DENORMALIZADA — uma
 * cópia do departamento do documento feita no momento da ingestão — e é ELA, não
 * `documents.department_id`, que as buscas por conteúdo usam para filtrar acesso:
 *
 *   lexicalSearch          → search.ts:537-539
 *   vectorSearch           → search.ts:958-961
 *   hybridSearch           → search.ts:1110-1113
 *   searchDocumentsPaged   → search.ts:811-812 (CTE `content`)
 *
 * Enquanto o departamento de um documento era imutável, a cópia nunca divergia.
 * O E-9 permite MOVER um documento de departamento — e com isso a cópia passa a
 * poder mentir. Se o move atualizar só `documents`, surgem DOIS defeitos de ACL,
 * simétricos e ambos graves:
 *
 *   VAZAMENTO — quem tinha acesso só ao departamento ANTIGO continua recebendo o
 *   TEXTO do chunk na busca por conteúdo e, no RAG, dentro do prompt do LLM.
 *
 *   SUMIÇO — quem tem acesso ao departamento NOVO não encontra o documento por
 *   conteúdo. Ele aparece por metadado (que lê `documents`) e some da busca
 *   semântica: um documento "meio visível", o pior modo de falhar.
 *
 * Por isso o move roda `UPDATE documents` + `UPDATE chunks` na MESMA transação.
 * Este arquivo é a prova de que a invariante `chunks.department_id =
 * documents.department_id` é o que sustenta a ACL da busca — e o alarme que
 * dispara se alguém remover o segundo UPDATE.
 *
 * Modelado em `search-orphan-chunk.test.ts` (T-99), o precedente exato desse tipo
 * de defeito: chunk que sobrevive à condição que deveria escondê-lo.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test';

const sql: Sql = postgres(DATABASE_URL);

/** UUIDs gerados por arquivo: o `dmdoc_test` é compartilhado entre as suítes. */
const TENANT_ID = randomUUID();
const USER_ID = randomUUID();
/** Departamento de ORIGEM: quem só tem ele perde o acesso depois do move. */
const DEPT_A = randomUUID();
/** Departamento de DESTINO: quem tem ele ganha o acesso depois do move. */
const DEPT_B = randomUUID();
/** O documento que se move. */
const DOC_MOVED = randomUUID();
/** Documento que NÃO se move, e fica em DEPT_A — testemunha de que a busca continua viva. */
const DOC_STAYER = randomUUID();

const DIMS = 1536;

/** Termo que só existe nesta fixture — evita casar com dados de outras suítes. */
const NEEDLE = 'xandrofilia';
const MOVED_TEXT = `contrato de ${NEEDLE} com clausula confidencial`;
const STAYER_TEXT = `manual de ${NEEDLE} de circulacao interna`;

/** Quantidade de chunks do documento movido — todos precisam migrar juntos. */
const MOVED_CHUNK_COUNT = 3;

/**
 * Embedding unitário no plano (0,1), girado por `angle`. A distância cosine
 * cresce monotonicamente com o ângulo — dá controle exato sobre a ordem do
 * ranking vetorial (mesma técnica de `search-hybrid.test.ts`).
 */
function embeddingAtAngle(angle: number): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[0] = Math.cos(angle);
  v[1] = Math.sin(angle);
  return v;
}

function toLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

/** Embedding da query: eixo 0 puro (ângulo 0). */
const QUERY_EMBEDDING = embeddingAtAngle(0);

/**
 * `tags` e `index_values` ficam nos defaults (`'{}'`) de propósito: o ramo de
 * METADADOS de `searchDocumentsPaged` casa por `ILIKE` em filename/tags/índices,
 * e o needle não pode aparecer em nenhum deles — senão o documento seria
 * encontrado por metadado e o teste do sumiço perderia o sentido.
 */
async function insertDocument(id: string, suffix: string, departmentId: string): Promise<void> {
  await sql`INSERT INTO documents (
      id, tenant_id, department_id, filename, original_filename,
      content_hash, size_bytes, mime_type, storage_key, status, uploaded_by_id, deleted
    ) VALUES (
      ${id}, ${TENANT_ID}, ${departmentId}, ${`${suffix}.pdf`}, ${`${suffix}.pdf`},
      ${`hash-moved-${suffix}`}, ${100}, 'application/pdf',
      ${`tenants/${TENANT_ID}/${suffix}.pdf`}, 'READY', ${USER_ID}, false
    )`;
}

async function insertChunk(
  documentId: string,
  departmentId: string,
  chunkIndex: number,
  text: string,
  angle: number,
): Promise<void> {
  await sql`INSERT INTO chunks (
      document_id, tenant_id, department_id, chunk_index, text, embedding, token_count
    ) VALUES (
      ${documentId}, ${TENANT_ID}, ${departmentId}, ${chunkIndex}, ${text},
      ${toLiteral(embeddingAtAngle(angle))}::vector, ${10}
    )`;
}

/** Remove só o que este arquivo cria (nunca DELETE sem WHERE). */
async function cleanup(): Promise<void> {
  await sql`DELETE FROM chunks WHERE tenant_id = ${TENANT_ID}`;
  await sql`DELETE FROM documents WHERE tenant_id = ${TENANT_ID}`;
  await sql`DELETE FROM departments WHERE tenant_id = ${TENANT_ID}`;
  await sql`DELETE FROM users WHERE tenant_id = ${TENANT_ID}`;
  await sql`DELETE FROM tenants WHERE id = ${TENANT_ID}`;
}

/**
 * O move COMPLETO, exatamente como a rota o executa: os dois UPDATEs na MESMA
 * transação, ambos com filtro de tenant e o `<> destino` que torna a operação
 * idempotente (mover para onde já se está não escreve nada).
 */
async function applyFullMove(toDepartmentId: string): Promise<{
  movedDocuments: number;
  movedChunks: number;
}> {
  return sql.begin(async (tx) => {
    const docs = await tx`
      UPDATE documents SET department_id = ${toDepartmentId}
      WHERE tenant_id = ${TENANT_ID}
        AND id = ${DOC_MOVED}
        AND deleted = false
        AND department_id <> ${toDepartmentId}
      RETURNING id`;
    const chunkRows = await tx`
      UPDATE chunks SET department_id = ${toDepartmentId}
      WHERE tenant_id = ${TENANT_ID}
        AND document_id = ${DOC_MOVED}
        AND department_id <> ${toDepartmentId}
      RETURNING id`;
    return { movedDocuments: docs.length, movedChunks: chunkRows.length };
  });
}

/**
 * O move DEFEITUOSO: só o `UPDATE documents`. Existe exclusivamente para
 * demonstrar o defeito que o segundo UPDATE previne — ver o describe de
 * regressão no fim do arquivo.
 */
async function applyDocumentOnlyMove(toDepartmentId: string): Promise<void> {
  await sql`
    UPDATE documents SET department_id = ${toDepartmentId}
    WHERE tenant_id = ${TENANT_ID}
      AND id = ${DOC_MOVED}
      AND deleted = false
      AND department_id <> ${toDepartmentId}`;
}

/** Devolve o documento movido (e seus chunks) ao estado inicial, sincronizado em DEPT_A. */
async function resetMovedDocumentToDeptA(): Promise<void> {
  await sql`UPDATE documents SET department_id = ${DEPT_A}
    WHERE tenant_id = ${TENANT_ID} AND id = ${DOC_MOVED}`;
  await sql`UPDATE chunks SET department_id = ${DEPT_A}
    WHERE tenant_id = ${TENANT_ID} AND document_id = ${DOC_MOVED}`;
}

/** Departamento gravado no documento e o conjunto de departamentos dos seus chunks. */
async function readDepartments(documentId: string): Promise<{
  document: string;
  chunks: string[];
}> {
  const docRows = await sql<Array<{ departmentId: string }>>`
    SELECT department_id AS "departmentId" FROM documents
    WHERE tenant_id = ${TENANT_ID} AND id = ${documentId}`;
  const chunkRows = await sql<Array<{ departmentId: string }>>`
    SELECT DISTINCT department_id AS "departmentId" FROM chunks
    WHERE tenant_id = ${TENANT_ID} AND document_id = ${documentId}`;
  return {
    document: docRows.map((r) => r.departmentId).join(','),
    chunks: chunkRows.map((r) => r.departmentId),
  };
}

/** As três buscas por CHUNK (as que alimentam o RAG), com o mesmo conjunto de permissões. */
async function searchAllThree(allowedDepartmentIds: string[] | null): Promise<{
  lex: Awaited<ReturnType<typeof lexicalSearch>>;
  vec: Awaited<ReturnType<typeof vectorSearch>>;
  hyb: Awaited<ReturnType<typeof hybridSearch>>;
}> {
  const base = { tenantId: TENANT_ID, allowedDepartmentIds, topK: 50 } as const;
  const lex = await lexicalSearch(sql, { ...base, queryText: NEEDLE });
  const vec = await vectorSearch(sql, { ...base, queryEmbedding: QUERY_EMBEDDING });
  const hyb = await hybridSearch(sql, {
    ...base,
    queryText: NEEDLE,
    queryEmbedding: QUERY_EMBEDDING,
  });
  return { lex, vec, hyb };
}

/** As três buscas restritas ao documento movido: o "zero resultados" literal. */
async function searchAllThreeForMovedDocument(allowedDepartmentIds: string[] | null): Promise<{
  lex: Awaited<ReturnType<typeof lexicalSearch>>;
  vec: Awaited<ReturnType<typeof vectorSearch>>;
  hyb: Awaited<ReturnType<typeof hybridSearch>>;
}> {
  const base = {
    tenantId: TENANT_ID,
    allowedDepartmentIds,
    filterDocumentIds: [DOC_MOVED],
    topK: 50,
  } as const;
  const lex = await lexicalSearch(sql, { ...base, queryText: NEEDLE });
  const vec = await vectorSearch(sql, { ...base, queryEmbedding: QUERY_EMBEDDING });
  const hyb = await hybridSearch(sql, {
    ...base,
    queryText: NEEDLE,
    queryEmbedding: QUERY_EMBEDDING,
  });
  return { lex, vec, hyb };
}

beforeAll(async () => {
  await cleanup();

  await sql`INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active)
    VALUES (${TENANT_ID}, 'Moved Document Fixture', ${1_000_000}, ${10}, true)`;
  await sql`INSERT INTO users (id, tenant_id, email, password_hash, name, role)
    VALUES (${USER_ID}, ${TENANT_ID}, ${`moved-${TENANT_ID}@fixture.test`}, 'hash', 'Fixture', 'USER')`;
  await sql`INSERT INTO departments (id, tenant_id, name, level)
    VALUES (${DEPT_A}, ${TENANT_ID}, 'Origem', 0),
           (${DEPT_B}, ${TENANT_ID}, 'Destino', 0)`;

  // O documento que vai se mover nasce em DEPT_A, READY, com chunks sincronizados.
  await insertDocument(DOC_MOVED, 'movido', DEPT_A);
  for (let i = 0; i < MOVED_CHUNK_COUNT; i++) {
    await insertChunk(DOC_MOVED, DEPT_A, i, `${MOVED_TEXT} ${i}`, 0.001 * (i + 1));
  }

  // A testemunha: mesmo needle, mesmo departamento de origem, e NUNCA se move.
  // Sem ela, "zero resultados para DEPT_A" também passaria se a busca estivesse
  // simplesmente quebrada — com ela, os resultados de DEPT_A continuam existindo
  // e o que precisa sumir é só o documento movido.
  await insertDocument(DOC_STAYER, 'ficou', DEPT_A);
  for (let i = 0; i < 2; i++) {
    await insertChunk(DOC_STAYER, DEPT_A, i, `${STAYER_TEXT} ${i}`, 0.5 + 0.01 * i);
  }

  await sql`ANALYZE chunks`;
});

/**
 * Cada teste decide sozinho qual move aplicar. Voltar ao estado inicial
 * (sincronizado em DEPT_A) antes de cada um evita que a ordem dos testes importe
 * — em especial depois do caso de regressão, que deixa o banco dessincronizado
 * de propósito.
 */
beforeEach(async () => {
  await resetMovedDocumentToDeptA();
});

afterAll(async () => {
  await cleanup();
  await sql.end();
});

describe('documento movido — o move sincroniza documents e chunks (E-9)', () => {
  it('os dois UPDATEs migram o documento e TODOS os seus chunks', async () => {
    const result = await applyFullMove(DEPT_B);

    expect(result.movedDocuments).toBe(1);
    expect(result.movedChunks).toBe(MOVED_CHUNK_COUNT);

    const after = await readDepartments(DOC_MOVED);
    expect(after.document).toBe(DEPT_B);
    expect(after.chunks).toEqual([DEPT_B]);

    // O documento que não se move não é tocado.
    const stayer = await readDepartments(DOC_STAYER);
    expect(stayer.document).toBe(DEPT_A);
    expect(stayer.chunks).toEqual([DEPT_A]);
  });

  it('mover para o MESMO departamento não escreve nada (idempotência do `<>`)', async () => {
    const result = await applyFullMove(DEPT_A);

    expect(result.movedDocuments).toBe(0);
    expect(result.movedChunks).toBe(0);
  });
});

describe('documento movido — NÃO VAZA para o departamento antigo (E-9)', () => {
  beforeEach(async () => {
    await applyFullMove(DEPT_B);
  });

  it('lexicalSearch não devolve mais o texto do documento movido', async () => {
    const { lex } = await searchAllThree([DEPT_A]);

    // A busca continua funcionando em DEPT_A — só o documento movido saiu.
    expect(lex.length).toBeGreaterThan(0);
    expect(lex.some((r) => r.documentId === DOC_MOVED)).toBe(false);
    expect(lex.every((r) => r.documentId === DOC_STAYER)).toBe(true);
    // O texto do chunk é o que entra no prompt do LLM: é ele que não pode vazar.
    expect(lex.some((r) => r.text.includes('confidencial'))).toBe(false);
  });

  it('vectorSearch não devolve mais o texto do documento movido', async () => {
    const { vec } = await searchAllThree([DEPT_A]);

    expect(vec.length).toBeGreaterThan(0);
    expect(vec.some((r) => r.documentId === DOC_MOVED)).toBe(false);
    expect(vec.some((r) => r.text.includes('confidencial'))).toBe(false);
  });

  it('hybridSearch não devolve mais o texto do documento movido', async () => {
    const { hyb } = await searchAllThree([DEPT_A]);

    expect(hyb.length).toBeGreaterThan(0);
    expect(hyb.some((r) => r.documentId === DOC_MOVED)).toBe(false);
    expect(hyb.some((r) => r.text.includes('confidencial'))).toBe(false);
  });

  it('apontando o documento movido diretamente, as três devolvem ZERO resultados', async () => {
    const { lex, vec, hyb } = await searchAllThreeForMovedDocument([DEPT_A]);

    expect(lex).toEqual([]);
    expect(vec).toEqual([]);
    expect(hyb).toEqual([]);
  });

  it('searchDocumentsPaged não lista mais o documento movido em DEPT_A', async () => {
    const paged = await searchDocumentsPaged(sql, {
      tenantId: TENANT_ID,
      allowedDepartmentIds: [DEPT_A],
      queryText: NEEDLE,
      page: 1,
      pageSize: 20,
    });

    expect(paged.items.some((r) => r.documentId === DOC_MOVED)).toBe(false);
    expect(paged.items.map((r) => r.documentId)).toEqual([DOC_STAYER]);
    // O `total` também não pode contar o documento proibido (vazamento por contagem).
    expect(paged.total).toBe(1);
  });
});

describe('documento movido — NÃO SOME para o departamento novo (E-9)', () => {
  beforeEach(async () => {
    await applyFullMove(DEPT_B);
  });

  it('as três buscas encontram o documento por CONTEÚDO sob DEPT_B', async () => {
    const { lex, vec, hyb } = await searchAllThree([DEPT_B]);

    for (const rows of [lex, vec, hyb]) {
      // Só o documento movido está em DEPT_B — a testemunha ficou em DEPT_A.
      expect(rows).toHaveLength(MOVED_CHUNK_COUNT);
      expect(new Set(rows.map((r) => r.documentId))).toEqual(new Set([DOC_MOVED]));
      expect(new Set(rows.map((r) => r.departmentId))).toEqual(new Set([DEPT_B]));
      expect(rows.every((r) => r.text.includes(NEEDLE))).toBe(true);
    }
  });

  it('searchDocumentsPaged acha o documento em DEPT_B pelo ramo de CONTEÚDO (score > 0)', async () => {
    const paged = await searchDocumentsPaged(sql, {
      tenantId: TENANT_ID,
      allowedDepartmentIds: [DEPT_B],
      queryText: NEEDLE,
      page: 1,
      pageSize: 20,
    });

    expect(paged.items.map((r) => r.documentId)).toEqual([DOC_MOVED]);
    expect(paged.total).toBe(1);
    // `score = 0` significaria que o documento entrou só pelo ramo de METADADOS
    // (`meta`, que lê `documents`) — exatamente o sintoma do sumiço: achável por
    // nome de arquivo, invisível por conteúdo. O needle não existe no filename,
    // então o único caminho até aqui é a CTE `content`, que filtra pelo chunk.
    expect(paged.items.every((r) => r.score > 0)).toBe(true);
    expect(paged.items.every((r) => r.text.includes(NEEDLE))).toBe(true);
  });
});

/**
 * REGRESSÃO DELIBERADA — este describe afirma o COMPORTAMENTO DEFEITUOSO.
 *
 * Aqui aplicamos só o `UPDATE documents`, omitindo o de `chunks`, e afirmamos
 * que a busca VAZA. Não é um teste de comportamento desejado: é a demonstração
 * executável do motivo pelo qual o segundo UPDATE existe.
 *
 * SE ESTES CASOS COMEÇAREM A FALHAR, não "conserte" as asserções. Falhar aqui
 * significa que a busca deixou de depender de `chunks.department_id` (por
 * exemplo, passou a filtrar por `documents.department_id` via join). Nesse caso,
 * a mudança certa é reescrever este describe descrevendo o novo contrato — e
 * reavaliar se o `UPDATE chunks` do move ainda é necessário.
 */
describe('REGRESSÃO — só `UPDATE documents`: a busca vaza (E-9)', () => {
  beforeEach(async () => {
    await applyDocumentOnlyMove(DEPT_B);
  });

  it('o chunk fica dessincronizado: documento em DEPT_B, chunks em DEPT_A', async () => {
    const after = await readDepartments(DOC_MOVED);
    expect(after.document).toBe(DEPT_B);
    expect(after.chunks).toEqual([DEPT_A]);
  });

  it('VAZAMENTO: as três buscas ainda entregam o texto a quem só tem DEPT_A', async () => {
    const { lex, vec, hyb } = await searchAllThreeForMovedDocument([DEPT_A]);

    for (const rows of [lex, vec, hyb]) {
      expect(rows).toHaveLength(MOVED_CHUNK_COUNT);
      expect(rows.every((r) => r.documentId === DOC_MOVED)).toBe(true);
      // O texto confidencial de um documento que já não pertence ao DEPT_A —
      // é isto que iria para o prompt do LLM no RAG.
      expect(rows.every((r) => r.text.includes('confidencial'))).toBe(true);
      // E o `departmentId` devolvido é o do CHUNK: a resposta ainda mente sobre
      // onde o documento está.
      expect(rows.every((r) => r.departmentId === DEPT_A)).toBe(true);
    }
  });

  it('SUMIÇO: quem tem DEPT_B não acha o documento por conteúdo', async () => {
    const { lex, vec, hyb } = await searchAllThree([DEPT_B]);

    expect(lex).toEqual([]);
    expect(vec).toEqual([]);
    expect(hyb).toEqual([]);
  });

  it('searchDocumentsPaged: some dos DOIS lados (nem antigo nem novo o encontram)', async () => {
    // O ramo de conteúdo casa pelo chunk (DEPT_A) mas o semi-join com `filtered`
    // — que lê `documents` (DEPT_B) — descarta a linha: a busca paginada não
    // vaza, mas some para todo mundo. É outro rosto do mesmo defeito, e a razão
    // de a paginada NÃO ser suficiente para provar a invariante: as buscas por
    // chunk (as do RAG) não têm esse semi-join com o departamento do documento.
    const fromOld = await searchDocumentsPaged(sql, {
      tenantId: TENANT_ID,
      allowedDepartmentIds: [DEPT_A],
      queryText: NEEDLE,
      page: 1,
      pageSize: 20,
    });
    expect(fromOld.items.some((r) => r.documentId === DOC_MOVED)).toBe(false);

    const fromNew = await searchDocumentsPaged(sql, {
      tenantId: TENANT_ID,
      allowedDepartmentIds: [DEPT_B],
      queryText: NEEDLE,
      page: 1,
      pageSize: 20,
    });
    expect(fromNew.items).toEqual([]);
    expect(fromNew.total).toBe(0);
  });
});

describe('documento movido — invariante global de denormalização (E-9)', () => {
  it('nenhum chunk do banco diverge do departamento ou do tenant do seu documento', async () => {
    // Depois do move CORRETO (e do `beforeEach` que ressincroniza o estado
    // sujo deixado pelo describe de regressão), a invariante vale para a base
    // inteira — não só para esta fixture.
    await applyFullMove(DEPT_B);

    const rows = await sql<Array<{ divergentes: string }>>`
      SELECT count(*) AS divergentes
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.department_id <> d.department_id
         OR c.tenant_id <> d.tenant_id`;

    expect(rows.map((r) => Number(r.divergentes))).toEqual([0]);
  });
});
