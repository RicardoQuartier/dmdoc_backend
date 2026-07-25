import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { searchDocumentsPaged, type StructuredDocumentFilters } from './search.js';

/**
 * Smoke COMBINATÓRIO de bindings do `searchDocumentsPaged` (T-63, épico E-5).
 *
 * O que este arquivo protege: a query paginada é montada por concatenação de
 * fragmentos opcionais (tenant único × lista de tenants × nenhum, filtro de
 * departamento, filtros estruturados, predicado de metadados por palavra,
 * LIMIT/OFFSET) sobre um allocator de parâmetros posicionais. Cada combinação
 * produz uma query DIFERENTE, com uma contagem de bindings diferente. Basta um
 * fragmento alocar um `$N` sem empurrar o binding (ou vice-versa) para o
 * Postgres responder
 *
 *     bind message supplies N parameters, but prepared statement requires M
 *
 * — erro que NÃO aparece em teste unitário de montagem de string e que só se
 * manifesta na combinação exata que ninguém exercitou. Rodar o produto
 * cartesiano contra o banco real custa segundos e cobre todas elas.
 *
 * Dimensões (3 × 2 × 2 × 3 × 2 = 72 casos):
 *   escopo de tenant   → tenantId | tenantIds | nenhum
 *   departamento       → null (sem restrição) | lista
 *   filtro estruturado → ausente | presente (dept + tags + índices)
 *   palavras na query  → 0 | 1 | 3
 *   página             → 1 | 3
 *
 * A página 3 importa por si só: com poucos resultados o OFFSET ultrapassa o
 * total, a query principal volta vazia e `searchDocumentsPaged` dispara a
 * SEGUNDA query (contagem de fallback), que usa outro conjunto de bindings —
 * exatamente `bindings` MENOS o LIMIT/OFFSET. É o caminho mais fácil de
 * quebrar e o mais difícil de perceber.
 *
 * A asserção é deliberadamente fraca (não lança; devolve um `total` numérico
 * coerente): o COMPORTAMENTO da paginação é provado em
 * `apps/api/src/routes/search-pagination.test.ts`. Aqui só se prova que
 * nenhuma combinação é impossível de executar.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test';

const sql: Sql = postgres(DATABASE_URL);

const TENANT_ID = 'bb000000-0000-0000-0000-0000000000b1';
/** Segundo tenant da lista do MTA — existe, mas sem documento nenhum. */
const OTHER_TENANT_ID = 'bb000000-0000-0000-0000-0000000000b2';
const USER_ID = 'bb000000-0000-0000-0000-0000000000b3';
const DEPT_ID = 'bb000000-0000-0000-0000-0000000000b4';
const OTHER_DEPT_ID = 'bb000000-0000-0000-0000-0000000000b5';
const TYPE_ID = 'bb000000-0000-0000-0000-0000000000b6';
const DOC_CONTENT_ID = 'bb000000-0000-0000-0000-0000000000b7';
const DOC_META_ID = 'bb000000-0000-0000-0000-0000000000b8';

const EMBEDDING = `[${Array.from({ length: 1536 }, () => 0).join(',')}]`;

/**
 * Nome de campo de índice deliberadamente exclusivo deste arquivo.
 *
 * O filtro numérico vira `(index_values->>'campo')::numeric >= $n` avaliado
 * sobre TODA a tabela `documents` que sobrevive ao filtro de tenant — e um dos
 * casos do produto cartesiano roda SEM filtro de tenant. Se o nome colidisse
 * com um campo de texto semeado por outro arquivo de teste, o cast estouraria
 * (22P02) e o smoke acusaria um defeito que não existe. Chave inexistente
 * devolve NULL, que o cast aceita.
 */
const NUMERIC_FIELD = 'smoke_ordem_t63';

async function cleanup(): Promise<void> {
  await sql`DELETE FROM chunks WHERE tenant_id IN (${TENANT_ID}, ${OTHER_TENANT_ID})`;
  await sql`DELETE FROM documents WHERE tenant_id IN (${TENANT_ID}, ${OTHER_TENANT_ID})`;
  await sql`DELETE FROM document_type_index_fields WHERE document_type_id = ${TYPE_ID}`;
  await sql`DELETE FROM document_types WHERE tenant_id IN (${TENANT_ID}, ${OTHER_TENANT_ID})`;
  await sql`DELETE FROM departments WHERE tenant_id IN (${TENANT_ID}, ${OTHER_TENANT_ID})`;
  await sql`DELETE FROM users WHERE tenant_id IN (${TENANT_ID}, ${OTHER_TENANT_ID})`;
  await sql`DELETE FROM tenants WHERE id IN (${TENANT_ID}, ${OTHER_TENANT_ID})`;
}

beforeAll(async () => {
  await cleanup();

  await sql`INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active)
    VALUES (${TENANT_ID}, 'Bindings Fixture', ${1_000_000}, ${10}, true),
           (${OTHER_TENANT_ID}, 'Bindings Fixture 2', ${1_000_000}, ${10}, true)`;

  await sql`INSERT INTO users (id, tenant_id, email, password_hash, name, role)
    VALUES (${USER_ID}, ${TENANT_ID}, 'bindings@fixture.test', 'hash', 'Fixture', 'USER')`;

  await sql`INSERT INTO departments (id, tenant_id, name, level)
    VALUES (${DEPT_ID}, ${TENANT_ID}, 'Fiscal', 0),
           (${OTHER_DEPT_ID}, ${TENANT_ID}, 'Juridico', 0)`;

  await sql`INSERT INTO document_types (id, tenant_id, name, is_global)
    VALUES (${TYPE_ID}, ${TENANT_ID}, 'Nota Fiscal', false)`;

  // Documento que casa pelo CONTEÚDO.
  await sql`INSERT INTO documents (
      id, tenant_id, department_id, document_type_id, filename, original_filename,
      content_hash, size_bytes, mime_type, s3_key, status, tags, index_values, uploaded_by_id
    ) VALUES (
      ${DOC_CONTENT_ID}, ${TENANT_ID}, ${DEPT_ID}, ${TYPE_ID}, 'conteudo.pdf', 'conteudo.pdf',
      ${'c'.repeat(64)}, ${100}, 'application/pdf', ${`tenants/${TENANT_ID}/conteudo.pdf`},
      'READY', ${sql.array(['fixture'])}::text[],
      ${sql.json({ [NUMERIC_FIELD]: 10, ref: 'abc' })}, ${USER_ID}
    )`;

  await sql`INSERT INTO chunks (
      document_id, tenant_id, department_id, chunk_index, text, embedding, token_count
    ) VALUES (
      ${DOC_CONTENT_ID}, ${TENANT_ID}, ${DEPT_ID}, 0,
      'nota fiscal de servico com zorblax no corpo do texto', ${EMBEDDING}::vector, ${10}
    )`;

  // Documento que casa só por METADADO (tag + filename + index value).
  await sql`INSERT INTO documents (
      id, tenant_id, department_id, document_type_id, filename, original_filename,
      content_hash, size_bytes, mime_type, s3_key, status, tags, index_values, uploaded_by_id
    ) VALUES (
      ${DOC_META_ID}, ${TENANT_ID}, ${OTHER_DEPT_ID}, ${TYPE_ID}, 'zorblax-meta.pdf', 'zorblax-meta.pdf',
      ${'d'.repeat(64)}, ${100}, 'application/pdf', ${`tenants/${TENANT_ID}/meta.pdf`},
      'READY', ${sql.array(['fixture', 'contrato'])}::text[],
      ${sql.json({ [NUMERIC_FIELD]: 20, ref: 'abc' })}, ${USER_ID}
    )`;

  await sql`INSERT INTO chunks (
      document_id, tenant_id, department_id, chunk_index, text, embedding, token_count
    ) VALUES (
      ${DOC_META_ID}, ${TENANT_ID}, ${OTHER_DEPT_ID}, 0,
      'texto sem qualquer palavra relevante para a busca', ${EMBEDDING}::vector, ${10}
    )`;
});

afterAll(async () => {
  await cleanup();
  await sql.end();
});

// ---------------------------------------------------------------------------
// Produto cartesiano
// ---------------------------------------------------------------------------

interface TenantScope {
  label: string;
  params: { tenantId?: string; tenantIds?: string[] };
}

const TENANT_SCOPES: TenantScope[] = [
  { label: 'tenantId', params: { tenantId: TENANT_ID } },
  { label: 'tenantIds', params: { tenantIds: [TENANT_ID, OTHER_TENANT_ID] } },
  { label: 'sem tenant', params: {} },
];

const DEPARTMENT_SCOPES: Array<{ label: string; value: string[] | null }> = [
  { label: 'dept null', value: null },
  { label: 'dept lista', value: [DEPT_ID, OTHER_DEPT_ID] },
];

/**
 * O filtro estruturado "presente" aciona TODOS os ramos do builder de uma vez:
 * departamento, tipo de documento, tags e três condições de índice (eq / gte /
 * lte). É a combinação com o maior número de bindings.
 */
const STRUCTURED_FILTERS: Array<{ label: string; value: StructuredDocumentFilters | undefined }> = [
  { label: 'sem filtro', value: undefined },
  {
    label: 'com filtro',
    value: {
      departmentIds: [DEPT_ID, OTHER_DEPT_ID],
      documentTypeIds: [TYPE_ID],
      tags: ['fixture'],
      indexFilters: {
        ref: { eq: 'abc' },
        [NUMERIC_FIELD]: { gte: 1, lte: 999 },
      },
    },
  },
];

const QUERIES: Array<{ label: string; value: string }> = [
  { label: '0 palavras', value: '' },
  { label: '1 palavra', value: 'zorblax' },
  { label: '3 palavras', value: 'zorblax nota fiscal' },
];

const PAGES = [1, 3];

describe('searchDocumentsPaged — smoke combinatório de bindings (T-63)', () => {
  for (const tenant of TENANT_SCOPES) {
    for (const dept of DEPARTMENT_SCOPES) {
      for (const filter of STRUCTURED_FILTERS) {
        for (const query of QUERIES) {
          for (const page of PAGES) {
            const name = `${tenant.label} × ${dept.label} × ${filter.label} × ${query.label} × page ${page}`;

            it(`executa sem erro de bind: ${name}`, async () => {
              const result = await searchDocumentsPaged(sql, {
                ...tenant.params,
                allowedDepartmentIds: dept.value,
                ...(filter.value !== undefined ? { structuredFilter: filter.value } : {}),
                queryText: query.value,
                page,
                pageSize: 5,
              });

              expect(typeof result.total).toBe('number');
              expect(Number.isInteger(result.total)).toBe(true);
              expect(result.total).toBeGreaterThanOrEqual(0);
              expect(result.items.length).toBeLessThanOrEqual(5);
              expect(result.items.length).toBeLessThanOrEqual(result.total);
              // Uma linha por documento, sempre.
              expect(new Set(result.items.map((i) => i.documentId)).size).toBe(
                result.items.length,
              );
            });
          }
        }
      }
    }
  }

  it('filtro insatisfazível (departamento pedido fora do permitido) devolve vazio sem ir ao banco', async () => {
    const result = await searchDocumentsPaged(sql, {
      tenantId: TENANT_ID,
      allowedDepartmentIds: [DEPT_ID],
      structuredFilter: { departmentIds: [OTHER_DEPT_ID] },
      queryText: 'zorblax',
      page: 1,
      pageSize: 5,
    });

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('página além do fim preserva o total (segunda query, com bindings sem LIMIT/OFFSET)', async () => {
    const base = {
      tenantId: TENANT_ID,
      allowedDepartmentIds: null,
      queryText: 'zorblax',
      pageSize: 5,
    } as const;

    const first = await searchDocumentsPaged(sql, { ...base, page: 1 });
    expect(first.total).toBeGreaterThan(0);

    const beyond = await searchDocumentsPaged(sql, { ...base, page: 50 });
    expect(beyond.items).toEqual([]);
    // O caminho de fallback reusa `bindings` MENOS LIMIT/OFFSET: se a contagem
    // estivesse errada, este seria o teste que quebra.
    expect(beyond.total).toBe(first.total);
  });
});
