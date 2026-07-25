import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { hybridSearch } from './search.js';

/**
 * Testes de integração do `hybridSearch` (RRF manual) contra o PostgreSQL real.
 *
 * Cobrem os defeitos corrigidos na T-60:
 *
 * 1. DETERMINISMO — com empate de `ts_rank` e de distância cosine, o ranking
 *    dependia da ordem física das linhas: os `ROW_NUMBER()` não tinham
 *    tiebreaker e o CTE lexical nem ORDER BY de statement antes do `LIMIT`
 *    tinha. A mesma busca devolvia ordens (e até conjuntos) diferentes entre
 *    execuções. Os testes forçam a mudança de ordem física entre as duas
 *    execuções (um `UPDATE` reescreve as tuplas no fim do heap, invertendo a
 *    ordem de um seq scan) — sem tiebreaker isso muda o resultado; com
 *    tiebreaker por `id`, não muda nada.
 *
 *    Nota sobre o corte vetorial: o `LIMIT` do lado vetorial ordena só por
 *    distância, de propósito, para não inviabilizar o índice HNSW (ver
 *    docstring de `hybridSearch`). Por isso os cenários de empate EXATO de
 *    embedding usam `topK` grande o bastante para que `topK*3` cubra todo o
 *    universo empatado: o que se afirma determinístico é a NUMERAÇÃO dos
 *    candidatos, não qual linha sobrevive a um corte no meio de um empate
 *    exato de distância.
 *
 * 2. FILTRO TARDIO — `filterDocumentIds` era aplicado só no JOIN final, depois
 *    do corte de `topK*3` candidatos. Um documento que passa no filtro mas cujos
 *    chunks não entram no pool de candidatos (porque outros documentos ranqueiam
 *    melhor) sumia do resultado: a busca devolvia menos que `topK`, às vezes
 *    zero. O cenário abaixo é exatamente esse.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test';

const sql: Sql = postgres(DATABASE_URL);

const TENANT_ID = 'aa000000-0000-0000-0000-0000000000a1';
const USER_ID = 'aa000000-0000-0000-0000-0000000000a2';
const DEPT_ID = 'aa000000-0000-0000-0000-0000000000a3';
/** Documento "ruidoso": muitos chunks, ranqueia bem nos dois lados. */
const DOC_NOISE = 'aa000000-0000-0000-0000-0000000000a4';
/** Documento alvo do filtro estruturado: poucos chunks e ranking pior. */
const DOC_TARGET = 'aa000000-0000-0000-0000-0000000000a5';
/** Documento com chunks 100% idênticos entre si — usado no teste de empate. */
const DOC_TIES = 'aa000000-0000-0000-0000-0000000000a6';

const DIMS = 1536;

/**
 * Embedding unitário na direção do eixo 0, girado no plano (0,1) por `angle`.
 * Distância cosine cresce monotonicamente com o ângulo — dá controle exato
 * sobre a ordem do ranking vetorial sem depender de valores aleatórios.
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

const MATCHING_TEXT = 'nota fiscal de servico prestado ao cliente';

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

async function insertDocument(id: string, suffix: string): Promise<void> {
  await sql`INSERT INTO documents (
      id, tenant_id, department_id, filename, original_filename,
      content_hash, size_bytes, mime_type, s3_key, status, uploaded_by_id
    ) VALUES (
      ${id}, ${TENANT_ID}, ${DEPT_ID}, ${`${suffix}.pdf`}, ${`${suffix}.pdf`},
      ${`hash-${suffix}`}, ${100}, 'application/pdf', ${`tenants/${TENANT_ID}/${suffix}.pdf`},
      'READY', ${USER_ID}
    )`;
}

/** Remove só o que este arquivo cria (não usa DELETE sem WHERE). */
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
    VALUES (${TENANT_ID}, 'Hybrid RRF Fixture', ${1_000_000}, ${10}, true)`;
  await sql`INSERT INTO users (id, tenant_id, email, password_hash, name, role)
    VALUES (${USER_ID}, ${TENANT_ID}, 'hybrid@fixture.test', 'hash', 'Fixture', 'USER')`;
  await sql`INSERT INTO departments (id, tenant_id, name, level)
    VALUES (${DEPT_ID}, ${TENANT_ID}, 'Fiscal', 0)`;

  await insertDocument(DOC_NOISE, 'noise');
  await insertDocument(DOC_TARGET, 'target');
  await insertDocument(DOC_TIES, 'ties');

  // 30 chunks do documento ruidoso: casam na busca lexical e ficam MUITO perto
  // do embedding da query (ângulos minúsculos) — ocupam sozinhos os topK*3
  // candidatos das duas CTEs.
  for (let i = 0; i < 30; i++) {
    await insertChunk(DOC_NOISE, i, `${MATCHING_TEXT} ${MATCHING_TEXT}`, 0.0001 * (i + 1));
  }

  // 6 chunks do documento alvo: casam na busca lexical (texto mais curto, logo
  // ts_rank menor) e ficam longe no espaço vetorial. Sozinhos, nunca entram no
  // pool de candidatos — só aparecem se o filtro for aplicado ANTES do corte.
  for (let i = 0; i < 6; i++) {
    await insertChunk(DOC_TARGET, i, MATCHING_TEXT, 1.0 + 0.01 * i);
  }

  // 20 chunks rigorosamente idênticos (mesmo texto, mesmo embedding): empate
  // total de ts_rank e de distância cosine nos dois rankings.
  for (let i = 0; i < 20; i++) {
    await insertChunk(DOC_TIES, i, MATCHING_TEXT, 0.5);
  }

  await sql`ANALYZE chunks`;
});

afterAll(async () => {
  await cleanup();
  await sql.end();
});

/**
 * Reescreve fisicamente as tuplas dos chunks do tenant. Um `UPDATE` no
 * PostgreSQL cria uma nova versão da linha no fim do heap: a ordem de um seq
 * scan depois disto é diferente da de antes. É o gatilho que expõe qualquer
 * ordenação não determinística do ranking.
 */
async function shufflePhysicalOrder(): Promise<void> {
  await sql`UPDATE chunks SET token_count = token_count + 1
            WHERE tenant_id = ${TENANT_ID} AND chunk_index % 2 = 0`;
  await sql`UPDATE chunks SET token_count = token_count - 1
            WHERE tenant_id = ${TENANT_ID} AND chunk_index % 2 = 0`;
  await sql`ANALYZE chunks`;
}

/** Assinatura comparável de um resultado (ignora `text`, que é repetido). */
function signature(rows: Array<{ documentId: string; chunkIndex: number; score: number }>): string {
  return rows.map((r) => `${r.documentId}#${r.chunkIndex}@${r.score.toFixed(12)}`).join('|');
}

describe('hybridSearch — determinismo do ranking RRF', () => {
  it('duas execuções idênticas devolvem exatamente a mesma ordem, mesmo com empate total', async () => {
    // topK=8 ⇒ pool de candidatos 24 ≥ os 20 chunks empatados: nenhum corte
    // cai no meio do empate, então o que está sob teste é só a numeração.
    const params = {
      tenantId: TENANT_ID,
      allowedDepartmentIds: null,
      queryText: MATCHING_TEXT,
      queryEmbedding: QUERY_EMBEDDING,
      filterDocumentIds: [DOC_TIES],
      topK: 8,
    };

    const first = await hybridSearch(sql, params);

    // Entre as duas execuções, a ordem física das linhas muda. Sem tiebreaker
    // determinístico, o ranking (e portanto o rrf_score) acompanharia.
    await shufflePhysicalOrder();

    const second = await hybridSearch(sql, params);

    expect(first).toHaveLength(8);
    expect(signature(second)).toBe(signature(first));
  });

  it('em caso de empate, desempata por id crescente em todos os estágios', async () => {
    const rows = await hybridSearch(sql, {
      tenantId: TENANT_ID,
      allowedDepartmentIds: null,
      queryText: MATCHING_TEXT,
      queryEmbedding: QUERY_EMBEDDING,
      filterDocumentIds: [DOC_TIES],
      topK: 8,
    });

    expect(rows).toHaveLength(8);
    // Todos os 20 chunks são idênticos: os 8 devolvidos têm de ser os 8 menores
    // ids, em ordem crescente — nada de "quaisquer 8".
    const expected = await sql<Array<{ id: string; chunk_index: number }>>`
      SELECT id, chunk_index FROM chunks
      WHERE document_id = ${DOC_TIES}
      ORDER BY id ASC LIMIT 8`;

    expect(rows.map((r) => r.chunkIndex)).toEqual(expected.map((e) => e.chunk_index));

    // Com o empate resolvido por id, os dois rankings atribuem o MESMO rank a
    // cada chunk: rrf_score = 1/(60+r) + 1/(60+r) = 2/(60+r), r = 1..8.
    rows.forEach((row, i) => {
      expect(row.score).toBeCloseTo(2 / (60 + (i + 1)), 12);
    });
  });

  it('a busca sem filtro também é estável entre execuções', async () => {
    const params = {
      tenantId: TENANT_ID,
      allowedDepartmentIds: null,
      queryText: MATCHING_TEXT,
      queryEmbedding: QUERY_EMBEDDING,
      topK: 8,
    };

    const first = await hybridSearch(sql, params);
    await shufflePhysicalOrder();
    const second = await hybridSearch(sql, params);

    expect(first.length).toBeGreaterThan(0);
    expect(signature(second)).toBe(signature(first));
  });
});

describe('hybridSearch — filtro de documentos aplicado antes do corte de candidatos', () => {
  it('devolve até topK chunks do documento filtrado mesmo quando ele não ranqueia bem', async () => {
    const params = {
      tenantId: TENANT_ID,
      allowedDepartmentIds: null,
      queryText: MATCHING_TEXT,
      queryEmbedding: QUERY_EMBEDDING,
      filterDocumentIds: [DOC_TARGET],
      topK: 5,
    };

    // Sem filtro, os candidatos (topK*3 = 15) são tomados pelo documento
    // ruidoso: nenhum chunk do documento alvo chega ao RRF.
    const unfiltered = await hybridSearch(sql, { ...params, filterDocumentIds: undefined });
    expect(unfiltered.every((r) => r.documentId !== DOC_TARGET)).toBe(true);

    // Com filtro, o corte passa a ser feito já dentro do universo filtrado.
    const filtered = await hybridSearch(sql, params);

    expect(filtered).toHaveLength(5);
    expect(filtered.every((r) => r.documentId === DOC_TARGET)).toBe(true);
  });

  it('respeita o filtro com vários documentos e não vaza chunk de fora da lista', async () => {
    const rows = await hybridSearch(sql, {
      tenantId: TENANT_ID,
      allowedDepartmentIds: null,
      queryText: MATCHING_TEXT,
      queryEmbedding: QUERY_EMBEDDING,
      filterDocumentIds: [DOC_TARGET, DOC_TIES],
      topK: 10,
    });

    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.documentId === DOC_TARGET || r.documentId === DOC_TIES)).toBe(true);
  });

  it('filtro por documento inexistente devolve lista vazia (sem vazar candidatos)', async () => {
    const rows = await hybridSearch(sql, {
      tenantId: TENANT_ID,
      allowedDepartmentIds: null,
      queryText: MATCHING_TEXT,
      queryEmbedding: QUERY_EMBEDDING,
      filterDocumentIds: ['aa000000-0000-0000-0000-0000000000ff'],
      topK: 5,
    });

    expect(rows).toEqual([]);
  });
});
