import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import {
  buildDocumentFilterPredicate,
  buildMetadataPredicate,
  createParamAllocator,
  hasStructuredDocumentFilters,
  tokenizeMetadataQuery,
} from './search.js';

/**
 * Testes do allocator de parâmetros posicionais e dos builders de predicado
 * usados pelo pipeline de busca (T-58).
 *
 * A montagem do SQL é pura e testada em memória, mas cada predicado também é
 * executado contra o PostgreSQL real: um predicado sintaticamente inválido
 * (`AND ()`) ou com contagem de bindings errada é erro duro do servidor
 * (`bind message supplies N parameters, but prepared statement requires M`),
 * e só o banco de verdade prova que isso não acontece.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test';

const sql: Sql = postgres(DATABASE_URL);

afterAll(async () => {
  await sql.end();
});

/** Conta quantos placeholders distintos ($1, $2, ...) aparecem no fragmento. */
function distinctPlaceholders(fragment: string): number {
  return new Set(fragment.match(/\$\d+/g) ?? []).size;
}

/** Maior índice de placeholder usado no fragmento (0 se não houver nenhum). */
function maxPlaceholder(fragment: string): number {
  const found = fragment.match(/\$\d+/g) ?? [];
  return found.reduce((max, p) => Math.max(max, Number(p.slice(1))), 0);
}

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const DEPT_ID = '33333333-3333-3333-3333-333333333333';
const TYPE_ID = '66666666-6666-6666-6666-666666666666';

describe('createParamAllocator', () => {
  it('numera a partir de $1 e acumula os bindings na ordem de alocação', () => {
    const alloc = createParamAllocator();

    expect(alloc.next).toBe(1);
    expect(alloc.add('a')).toBe('$1');
    expect(alloc.add(['b', 'c'])).toBe('$2');
    expect(alloc.add(42)).toBe('$3');
    expect(alloc.next).toBe(4);
    expect(alloc.bindings).toEqual(['a', ['b', 'c'], 42]);
  });

  it('nunca emite placeholder sem empurrar o binding correspondente', () => {
    const alloc = createParamAllocator();
    const placeholders = ['x', 'y', 'z'].map((v) => alloc.add(v));

    // Índice do último placeholder == número de bindings: sem buraco nem sobra.
    expect(maxPlaceholder(placeholders.join(' '))).toBe(alloc.bindings.length);
  });

  it('permite reutilizar o mesmo slot em vários fragmentos (uma única alocação)', () => {
    const alloc = createParamAllocator();
    const p = alloc.add('mesmo-valor');
    const fragment = `a = ${p}::text OR b = ${p}::text OR c = ${p}::text`;

    expect(distinctPlaceholders(fragment)).toBe(1);
    expect(alloc.bindings).toEqual(['mesmo-valor']);
    // Continua de $2: o valor reutilizado não deslocou a numeração seguinte.
    expect(alloc.add('outro')).toBe('$2');
  });
});

describe('tokenizeMetadataQuery', () => {
  it('mantém o mínimo de 2 caracteres (não quebra buscas por "NF")', () => {
    expect(tokenizeMetadataQuery('NF 99 a b contrato')).toEqual(['NF', '99', 'contrato']);
  });

  it('devolve lista vazia quando só há palavras de 1 caractere', () => {
    expect(tokenizeMetadataQuery('  a b  ')).toEqual([]);
  });
});

describe('buildMetadataPredicate', () => {
  it('sem palavras degenera para `false` e não aloca nenhum parâmetro', () => {
    const alloc = createParamAllocator();
    const predicate = buildMetadataPredicate([], alloc);

    expect(predicate).toBe('false');
    expect(alloc.bindings).toHaveLength(0);
    expect(alloc.next).toBe(1);
  });

  it('gasta um único slot por palavra, reutilizado nas quatro posições', () => {
    const alloc = createParamAllocator();
    const predicate = buildMetadataPredicate(['nota'], alloc);

    expect(alloc.bindings).toEqual(['nota']);
    expect(distinctPlaceholders(predicate)).toBe(1);
    expect((predicate.match(/\$1::text/g) ?? []).length).toBe(4);
  });

  it('combina palavras com OR e continua a numeração de quem veio antes', () => {
    const alloc = createParamAllocator();
    alloc.add('já-existia'); // $1 alocado por outro fragmento da query
    const predicate = buildMetadataPredicate(['nota', 'fiscal'], alloc);

    expect(predicate.startsWith('(')).toBe(true);
    expect(predicate).toContain(') OR (');
    expect(distinctPlaceholders(predicate)).toBe(2);
    expect(maxPlaceholder(predicate)).toBe(3);
    expect(alloc.bindings).toEqual(['já-existia', 'nota', 'fiscal']);
  });

  it('o predicado vazio é SQL válido no Postgres (nunca `AND ()`)', async () => {
    const alloc = createParamAllocator();
    const predicate = buildMetadataPredicate([], alloc);

    const rows = await sql.unsafe<Array<{ id: string }>>(
      `SELECT id FROM documents WHERE deleted = false AND status = 'READY' AND ${predicate} LIMIT 10`,
      alloc.bindings as Parameters<typeof sql.unsafe>[1],
    );
    expect(rows).toEqual([]);
  });

  it('o predicado com palavras roda no Postgres com a contagem exata de bindings', async () => {
    const alloc = createParamAllocator();
    const predicate = buildMetadataPredicate(tokenizeMetadataQuery('nota fiscal 1.234,56'), alloc);
    const whereClause = `deleted = false AND status = 'READY' AND ${predicate} AND tenant_id = ${alloc.add(TENANT_ID)}::uuid`;

    const rows = await sql.unsafe<Array<{ id: string }>>(
      `SELECT id FROM documents WHERE ${whereClause} LIMIT 10`,
      alloc.bindings as Parameters<typeof sql.unsafe>[1],
    );
    expect(Array.isArray(rows)).toBe(true);
  });
});

describe('hasStructuredDocumentFilters', () => {
  it('reconhece ausência de filtros', () => {
    expect(hasStructuredDocumentFilters(undefined)).toBe(false);
    expect(hasStructuredDocumentFilters({})).toBe(false);
    expect(hasStructuredDocumentFilters({ tags: [] })).toBe(false);
    expect(hasStructuredDocumentFilters({ indexFilters: {} })).toBe(false);
  });

  it('reconhece presença de filtros', () => {
    expect(hasStructuredDocumentFilters({ departmentIds: [] })).toBe(true);
    expect(hasStructuredDocumentFilters({ tags: ['fiscal'] })).toBe(true);
    expect(hasStructuredDocumentFilters({ indexFilters: { valor: { gte: 1 } } })).toBe(true);
  });
});

describe('buildDocumentFilterPredicate', () => {
  it('marca como insatisfazível quando nenhum departamento pedido é permitido', () => {
    const alloc = createParamAllocator();
    const predicate = buildDocumentFilterPredicate(
      {
        tenantId: TENANT_ID,
        allowedDepartmentIds: ['99999999-9999-9999-9999-999999999999'],
        filters: { departmentIds: [DEPT_ID] },
      },
      alloc,
    );

    expect(predicate.unsatisfiable).toBe(true);
    expect(predicate.sql).toBe('false');
  });

  it('preserva os casts de tipo em cada fragmento', () => {
    const alloc = createParamAllocator();
    const predicate = buildDocumentFilterPredicate(
      {
        tenantIds: [TENANT_ID],
        allowedDepartmentIds: [DEPT_ID],
        filters: {
          documentTypeIds: [TYPE_ID],
          tags: ['fiscal'],
          indexFilters: {
            valor: { gte: 10, lte: 20 },
            emissao: { gte: '2026-01-01' },
            cliente: { eq: 'ACME' },
          },
        },
      },
      alloc,
    );

    expect(predicate.unsatisfiable).toBe(false);
    expect(predicate.sql).toContain('d.tenant_id = ANY($1::uuid[])');
    expect(predicate.sql).toContain('::uuid[])');
    expect(predicate.sql).toContain('::text[]');
    expect(predicate.sql).toContain('::numeric >=');
    expect(predicate.sql).toContain('::numeric <=');
    expect(predicate.sql).toContain('::timestamptz >=');
    // Todo placeholder emitido tem binding correspondente.
    expect(maxPlaceholder(predicate.sql)).toBe(alloc.bindings.length);
  });

  it('trata valor `YYYY-MM-DD` como data e número como numeric', () => {
    const dateAlloc = createParamAllocator();
    const dateP = buildDocumentFilterPredicate(
      {
        allowedDepartmentIds: null,
        filters: { indexFilters: { emissao: { lte: '2026-12-31T23:59:59Z' } } },
      },
      dateAlloc,
    );
    expect(dateP.sql).toContain('::timestamptz <=');

    const numAlloc = createParamAllocator();
    const numP = buildDocumentFilterPredicate(
      { allowedDepartmentIds: null, filters: { indexFilters: { valor: { lte: 99 } } } },
      numAlloc,
    );
    expect(numP.sql).toContain('::numeric <=');
  });

  it('continua a numeração de um allocator já em uso', () => {
    const alloc = createParamAllocator();
    alloc.add('anterior'); // $1
    const predicate = buildDocumentFilterPredicate(
      { tenantId: TENANT_ID, allowedDepartmentIds: [DEPT_ID] },
      alloc,
    );

    expect(predicate.sql).toContain('d.tenant_id = $2');
    expect(predicate.sql).toContain('d.department_id = ANY($3::uuid[])');
    expect(alloc.bindings).toEqual(['anterior', TENANT_ID, [DEPT_ID]]);
  });

  it('o predicado completo roda no Postgres com a contagem exata de bindings', async () => {
    const alloc = createParamAllocator();
    const predicate = buildDocumentFilterPredicate(
      {
        tenantId: TENANT_ID,
        allowedDepartmentIds: [DEPT_ID],
        filters: {
          departmentIds: [DEPT_ID],
          documentTypeIds: [TYPE_ID],
          tags: ['fiscal'],
          indexFilters: {
            cliente: { eq: 'ACME' },
            valor: { gte: 10, lte: 5000 },
            emissao: { gte: '2026-01-01', lte: '2026-12-31' },
          },
        },
      },
      alloc,
    );

    const rows = await sql.unsafe<Array<{ id: string }>>(
      `SELECT d.id FROM documents d WHERE ${predicate.sql}`,
      alloc.bindings as Parameters<typeof sql.unsafe>[1],
    );
    expect(rows).toEqual([]);
  });
});
