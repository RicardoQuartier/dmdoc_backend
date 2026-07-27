import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { hybridSearch, lexicalSearch, vectorSearch } from './search.js';

/**
 * Regressão da T-99 — chunk ÓRFÃO não pode voltar em nenhuma busca por chunk.
 *
 * O DEFEITO. `lexicalSearch`, `vectorSearch` e `hybridSearch` liam `chunks`
 * direto, sem tocar em `documents`. A única barreira contra o chunk de um
 * documento excluído era o `filterDocumentIds` que a rota resolve a partir de
 * `documents` — e ele é `null` quando a requisição não traz filtro estruturado,
 * que é justamente o caso da busca livre e do RAG. Resultado medido antes da
 * correção: o TEXTO de um chunk cujo documento estava `deleted = true` voltava
 * nas três funções e, no RAG, entrava no prompt do LLM.
 *
 * COMO O CHUNK FICA ÓRFÃO (é cenário real, não hipotético): excluir um
 * documento enquanto ele está em `PROCESSING` — a exclusão apaga os chunks, o
 * worker termina depois e reinsere. Por isso a fixture insere o chunk DEPOIS de
 * o documento já estar marcado como excluído.
 *
 * O que estes testes afirmam:
 *  1. busca SEM `filterDocumentIds` não devolve chunk de documento excluído;
 *  2. nem de documento que ainda não está `READY`;
 *  3. o documento vivo continua sendo devolvido (a correção não fecha demais);
 *  4. na híbrida, o chunk órfão não ocupa vaga no pool de `topK*3` candidatos —
 *     é o teste que separa "filtro antes do corte" de "filtro no JOIN final".
 *     Com o filtro só no fim, o item 4 devolveria ZERO resultados apesar de
 *     haver chunks vivos elegíveis.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test';

const sql: Sql = postgres(DATABASE_URL);

const TENANT_ID = 'bb000000-0000-0000-0000-0000000000b1';
const USER_ID = 'bb000000-0000-0000-0000-0000000000b2';
const DEPT_ID = 'bb000000-0000-0000-0000-0000000000b3';
/** READY e não deletado: o único que pode aparecer. */
const DOC_LIVE = 'bb000000-0000-0000-0000-0000000000b4';
/** Soft-deletado, com chunk reinserido depois pelo worker. */
const DOC_DELETED = 'bb000000-0000-0000-0000-0000000000b5';
/** Ainda em PROCESSING: chunk já existe, documento não está indexável. */
const DOC_PENDING = 'bb000000-0000-0000-0000-0000000000b6';

const DIMS = 1536;

/** Termo que só existe nesta fixture — evita casar com dados de outras suítes. */
const NEEDLE = 'zarabatana';
const LIVE_TEXT = `documento vivo com ${NEEDLE} disponivel`;
const ORPHAN_TEXT = `segredo de ${NEEDLE} do documento excluido`;
const PENDING_TEXT = `rascunho de ${NEEDLE} ainda em processamento`;

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

async function insertDocument(
  id: string,
  suffix: string,
  status: string,
  deleted: boolean,
): Promise<void> {
  await sql`INSERT INTO documents (
      id, tenant_id, department_id, filename, original_filename,
      content_hash, size_bytes, mime_type, s3_key, status, uploaded_by_id, deleted
    ) VALUES (
      ${id}, ${TENANT_ID}, ${DEPT_ID}, ${`${suffix}.pdf`}, ${`${suffix}.pdf`},
      ${`hash-orphan-${suffix}`}, ${100}, 'application/pdf',
      ${`tenants/${TENANT_ID}/${suffix}.pdf`}, ${status}, ${USER_ID}, ${deleted}
    )`;
}

async function insertChunk(
  documentId: string,
  chunkIndex: number,
  text: string,
  angle: number,
): Promise<void> {
  await sql`INSERT INTO chunks (
      document_id, tenant_id, department_id, chunk_index, text, embedding, token_count
    ) VALUES (
      ${documentId}, ${TENANT_ID}, ${DEPT_ID}, ${chunkIndex}, ${text},
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

beforeAll(async () => {
  await cleanup();

  await sql`INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active)
    VALUES (${TENANT_ID}, 'Orphan Chunk Fixture', ${1_000_000}, ${10}, true)`;
  await sql`INSERT INTO users (id, tenant_id, email, password_hash, name, role)
    VALUES (${USER_ID}, ${TENANT_ID}, 'orphan@fixture.test', 'hash', 'Fixture', 'USER')`;
  await sql`INSERT INTO departments (id, tenant_id, name, level)
    VALUES (${DEPT_ID}, ${TENANT_ID}, 'Fiscal', 0)`;

  await insertDocument(DOC_LIVE, 'live', 'READY', false);
  await insertDocument(DOC_DELETED, 'deleted', 'READY', true);
  await insertDocument(DOC_PENDING, 'pending', 'PROCESSING', false);

  // Os chunks do documento excluído são inseridos DEPOIS da exclusão e são os
  // MELHORES candidatos dos dois lados: texto repetido (ts_rank maior) e ângulo
  // minúsculo (distância cosine menor). Com 24 deles, sozinhos ocupam todo o
  // pool de topK*3 de uma busca com topK ≤ 8.
  for (let i = 0; i < 24; i++) {
    await insertChunk(DOC_DELETED, i, `${ORPHAN_TEXT} ${ORPHAN_TEXT}`, 0.0001 * (i + 1));
  }

  // O documento em PROCESSING também ranqueia bem — não pode aparecer.
  for (let i = 0; i < 4; i++) {
    await insertChunk(DOC_PENDING, i, `${PENDING_TEXT} ${PENDING_TEXT}`, 0.002 + 0.0001 * i);
  }

  // O documento vivo ranqueia PIOR nos dois lados: só aparece se o filtro de
  // documento vivo entrar antes do corte de candidatos.
  for (let i = 0; i < 6; i++) {
    await insertChunk(DOC_LIVE, i, LIVE_TEXT, 1.0 + 0.01 * i);
  }

  await sql`ANALYZE chunks`;
});

afterAll(async () => {
  await cleanup();
  await sql.end();
});

/** Parâmetros de uma busca livre: sem filtro estruturado nenhum. */
const freeSearchBase = {
  tenantId: TENANT_ID,
  allowedDepartmentIds: null,
} as const;

describe('chunk órfão — busca SEM filtros estruturados (T-99)', () => {
  it('lexicalSearch não devolve chunk de documento excluído nem de não-READY', async () => {
    const rows = await lexicalSearch(sql, {
      ...freeSearchBase,
      queryText: NEEDLE,
      topK: 50,
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.documentId === DOC_LIVE)).toBe(true);
    // O texto do documento excluído é o que vazava — e é o que vira prompt do LLM.
    expect(rows.some((r) => r.text.includes('excluido'))).toBe(false);
    expect(rows.some((r) => r.text.includes('processamento'))).toBe(false);
  });

  it('vectorSearch não devolve chunk de documento excluído nem de não-READY', async () => {
    const rows = await vectorSearch(sql, {
      ...freeSearchBase,
      queryEmbedding: QUERY_EMBEDDING,
      topK: 50,
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.documentId === DOC_LIVE)).toBe(true);
    expect(rows.some((r) => r.text.includes('excluido'))).toBe(false);
  });

  it('hybridSearch não devolve chunk de documento excluído nem de não-READY', async () => {
    const rows = await hybridSearch(sql, {
      ...freeSearchBase,
      queryText: NEEDLE,
      queryEmbedding: QUERY_EMBEDDING,
      topK: 50,
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.documentId === DOC_LIVE)).toBe(true);
    expect(rows.some((r) => r.text.includes('excluido'))).toBe(false);
  });

  it('o documento vivo continua sendo devolvido pelas três buscas', async () => {
    const lex = await lexicalSearch(sql, { ...freeSearchBase, queryText: NEEDLE, topK: 10 });
    const vec = await vectorSearch(sql, {
      ...freeSearchBase,
      queryEmbedding: QUERY_EMBEDDING,
      topK: 10,
    });
    const hyb = await hybridSearch(sql, {
      ...freeSearchBase,
      queryText: NEEDLE,
      queryEmbedding: QUERY_EMBEDDING,
      topK: 10,
    });

    // Os 6 chunks do documento vivo, e nada além deles.
    expect(lex).toHaveLength(6);
    expect(vec).toHaveLength(6);
    expect(hyb).toHaveLength(6);
    for (const rows of [lex, vec, hyb]) {
      expect(new Set(rows.map((r) => r.documentId))).toEqual(new Set([DOC_LIVE]));
    }
  });
});

describe('chunk órfão — o filtro entra ANTES do corte de topK*3 (T-99)', () => {
  it('hybridSearch preserva o recall: o órfão não ocupa vaga no pool de candidatos', async () => {
    // topK=5 ⇒ pool de 15 candidatos por CTE. Os 24 chunks do documento
    // excluído ranqueiam melhor nos DOIS lados: se o filtro fosse aplicado só no
    // JOIN final, o pool inteiro seria composto por eles e o resultado viria
    // VAZIO, mesmo havendo 6 chunks vivos elegíveis.
    const rows = await hybridSearch(sql, {
      ...freeSearchBase,
      queryText: NEEDLE,
      queryEmbedding: QUERY_EMBEDDING,
      topK: 5,
    });

    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.documentId === DOC_LIVE)).toBe(true);
  });

  it('lexicalSearch e vectorSearch também preservam o recall com topK pequeno', async () => {
    const lex = await lexicalSearch(sql, { ...freeSearchBase, queryText: NEEDLE, topK: 3 });
    const vec = await vectorSearch(sql, {
      ...freeSearchBase,
      queryEmbedding: QUERY_EMBEDDING,
      topK: 3,
    });

    expect(lex).toHaveLength(3);
    expect(vec).toHaveLength(3);
    expect(lex.every((r) => r.documentId === DOC_LIVE)).toBe(true);
    expect(vec.every((r) => r.documentId === DOC_LIVE)).toBe(true);
  });
});

describe('chunk órfão — com filterDocumentIds explícito (T-99)', () => {
  it('nem apontando o documento excluído diretamente o chunk volta', async () => {
    const params = {
      ...freeSearchBase,
      filterDocumentIds: [DOC_DELETED, DOC_PENDING],
      topK: 10,
    };

    const lex = await lexicalSearch(sql, { ...params, queryText: NEEDLE });
    const vec = await vectorSearch(sql, { ...params, queryEmbedding: QUERY_EMBEDDING });
    const hyb = await hybridSearch(sql, {
      ...params,
      queryText: NEEDLE,
      queryEmbedding: QUERY_EMBEDDING,
    });

    expect(lex).toEqual([]);
    expect(vec).toEqual([]);
    expect(hyb).toEqual([]);
  });
});
