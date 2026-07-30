import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@dmdoc/db-pg';
import { buildApp } from '../app.js';
import { startTestDb, seedUser, testConfig, resetDomainTables, type TestDb } from '../test/helpers.js';

/**
 * Segunda barreira do enriquecimento (T-99, épico E-8).
 *
 * A camada de banco já não devolve chunk de documento excluído/não-`READY`
 * (`buildLiveDocumentPredicate` em `packages/db-pg/src/search.ts`). Mas busca e
 * enriquecimento são DUAS queries, em snapshots diferentes: um DELETE que
 * commita entre elas ainda produz um resultado cujo documento não existe mais no
 * momento do enriquecimento.
 *
 * Antes desta correção, esse item continuava na resposta apenas ANONIMIZADO —
 * `documentName`/`title` nulos, `tags`/`indexValues` vazios — com o `text`
 * intacto, que é o payload exibido na tela E injetado no prompt do LLM. Agora o
 * item é DESCARTADO.
 *
 * Como a corrida é reproduzida de forma determinística: a app de teste recebe um
 * `sql` embrulhado num Proxy que, imediatamente ANTES da query de enriquecimento
 * (a única que seleciona `d.original_filename`), executa uma mutação combinada
 * pelo teste (excluir o documento, tirá-lo de `READY`, movê-lo de empresa). A
 * busca em si é a real e roda com o documento vivo — é exatamente a janela de
 * corrida, não uma fabricação de resultado.
 */

const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();
const ADMIN_A_ID = crypto.randomUUID();
const DEPT_A_ID = crypto.randomUUID();
const TYPE_A_ID = crypto.randomUUID();

const DOC_DOOMED_ID = crypto.randomUUID();
const DOC_SURVIVOR_ID = crypto.randomUUID();

const PASSWORD = 'senha-muito-secreta-123';

/** Termo presente APENAS no texto dos chunks — nunca em nome/tags/índices. */
const NEEDLE = 'zarabatana';
/** Trecho do chunk do documento condenado; não pode sobrar na resposta. */
const DOOMED_TEXT = `segredo de ${NEEDLE} do documento excluido`;
const SURVIVOR_TEXT = `relatorio de ${NEEDLE} do documento vivo`;

const EMBEDDING = `[${Array.from({ length: 1536 }, () => 0).join(',')}]`;

let app: FastifyInstance;
let testDb: TestDb;
let token: string;

/**
 * Mutação a executar UMA vez, logo antes da query de enriquecimento.
 * O Proxy consome e zera — os demais testes do arquivo não são afetados.
 */
let pendingRace: (() => Promise<void>) | null = null;

/**
 * Embrulha o cliente postgres.js interceptando só a query de enriquecimento.
 *
 * Fragmentos criados por `sql\`...\`` para interpolação (ex.: o filtro de
 * tenant) passam por aqui também — por isso a detecção é pelo texto da query, e
 * tudo que não casa é delegado inalterado (devolver uma Promise no lugar de um
 * fragmento quebraria a query externa).
 */
function withRace(real: Sql): Sql {
  const target = real as unknown as (...args: unknown[]) => unknown;
  return new Proxy(target, {
    apply(_t, _thisArg, args: unknown[]) {
      const strings = args[0];
      const isEnrichment =
        Array.isArray(strings) &&
        typeof strings[0] === 'string' &&
        strings[0].includes('d.original_filename');

      if (!isEnrichment || pendingRace === null) {
        return target(...args);
      }

      const race = pendingRace;
      pendingRace = null;
      return (async () => {
        await race();
        return target(...args);
      })();
    },
    get(_t, prop) {
      const value = (real as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === 'function' ? value.bind(real) : value;
    },
  }) as unknown as Sql;
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = await buildApp({ config: testConfig(), db: withRace(testDb.db) });
});

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

beforeEach(async () => {
  pendingRace = null;
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

  await testDb.db`
    INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
    VALUES (${DEPT_A_ID}, ${TENANT_A}, NULL, 'Dept A', 0, '{}'::text[], false, NOW())
  `;

  await testDb.db`
    INSERT INTO document_types (id, tenant_id, name, is_global, deleted, created_at)
    VALUES (${TYPE_A_ID}, ${TENANT_A}, 'Nota Fiscal', false, false, NOW())
  `;

  await testDb.db`
    INSERT INTO documents (
      id, tenant_id, department_id, document_type_id,
      filename, original_filename, title, suggested_title,
      content_hash, size_bytes, mime_type, storage_key, status, tags, index_values,
      uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
    ) VALUES
      (
        ${DOC_DOOMED_ID}, ${TENANT_A}, ${DEPT_A_ID}, ${TYPE_A_ID},
        'condenado.pdf', 'condenado.pdf', 'Documento Condenado', NULL,
        ${'c'.repeat(64)}, 1024, 'application/pdf',
        ${`tenants/${TENANT_A}/${DOC_DOOMED_ID}.pdf`}, 'READY', '{}'::text[],
        ${testDb.db.json({})},
        ${ADMIN_A_ID}, NOW(), NOW(), 0, false
      ),
      (
        ${DOC_SURVIVOR_ID}, ${TENANT_A}, ${DEPT_A_ID}, ${TYPE_A_ID},
        'vivo.pdf', 'vivo.pdf', 'Documento Vivo', NULL,
        ${'v'.repeat(64)}, 1024, 'application/pdf',
        ${`tenants/${TENANT_A}/${DOC_SURVIVOR_ID}.pdf`}, 'READY', '{}'::text[],
        ${testDb.db.json({})},
        ${ADMIN_A_ID}, NOW(), NOW(), 0, false
      )
  `;

  await testDb.db`
    INSERT INTO chunks (document_id, tenant_id, department_id, document_type_name, page_number, chunk_index, text, embedding, token_count)
    VALUES
      (${DOC_DOOMED_ID}, ${TENANT_A}, ${DEPT_A_ID}, 'Nota Fiscal', 1, 0, ${DOOMED_TEXT}, ${EMBEDDING}::vector, 6),
      (${DOC_SURVIVOR_ID}, ${TENANT_A}, ${DEPT_A_ID}, 'Nota Fiscal', 1, 0, ${SURVIVOR_TEXT}, ${EMBEDDING}::vector, 6)
  `;

  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'admin-a@empresa.com', password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  token = res.json().accessToken as string;
});

interface RespChunk {
  documentId: string;
  documentName: string | null;
  title: string | null;
  text: string;
  tags: string[];
}

interface RespBody {
  chunks: RespChunk[];
  total: number;
  pageCount: number;
  page: number;
  pageSize: number;
}

async function search(payload: Record<string, unknown>): Promise<{ body: RespBody; raw: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/search',
    headers: { authorization: `Bearer ${token}` },
    payload: { query: NEEDLE, searchMode: 'lexical', ...payload },
  });
  expect(res.statusCode).toBe(200);
  return { body: res.json() as RespBody, raw: res.body };
}

describe('POST /search — enriquecimento descarta resultado sem documento vivo (T-99)', () => {
  it('sem corrida: os dois documentos voltam enriquecidos (baseline)', async () => {
    const { body } = await search({ generateAnswer: false });

    expect(body.chunks.map((c) => c.documentId).sort()).toEqual(
      [DOC_DOOMED_ID, DOC_SURVIVOR_ID].sort(),
    );
    expect(body.chunks.every((c) => c.documentName !== null)).toBe(true);
    expect(body.total).toBe(2);
  });

  it('documento excluído ENTRE a busca e o enriquecimento: item ausente, não anonimizado', async () => {
    pendingRace = async () => {
      await testDb.db`UPDATE documents SET deleted = true WHERE id = ${DOC_DOOMED_ID}`;
    };

    const { body, raw } = await search({ generateAnswer: false });

    // O item saiu da lista — não é um cartão anônimo com o texto intacto.
    expect(body.chunks.map((c) => c.documentId)).toEqual([DOC_SURVIVOR_ID]);
    expect(body.chunks.some((c) => c.documentName === null)).toBe(false);

    // O texto do documento excluído não aparece em lugar nenhum da resposta.
    expect(raw).not.toContain(DOOMED_TEXT);
    expect(raw).not.toContain('Documento Condenado');

    // O documento vivo continua íntegro.
    expect(body.chunks[0]!.text).toBe(SURVIVOR_TEXT);
    expect(body.chunks[0]!.documentName).toBe('vivo.pdf');

    // A página fica CURTA de propósito: `total`/`pageCount` vêm da query de
    // busca (snapshot anterior ao DELETE) e não são reescritos.
    expect(body.total).toBe(2);
    expect(body.chunks.length).toBeLessThan(body.total);
  });

  it('documento que sai de READY entre a busca e o enriquecimento também cai', async () => {
    // O predicado do enriquecimento precisa casar com o do db-pg
    // (`deleted = false AND status = 'READY'`). Só `deleted = false` deixaria
    // este item passar com metadados e furaria a barreira.
    pendingRace = async () => {
      await testDb.db`UPDATE documents SET status = 'PROCESSING' WHERE id = ${DOC_DOOMED_ID}`;
    };

    const { body, raw } = await search({ generateAnswer: false });

    expect(body.chunks.map((c) => c.documentId)).toEqual([DOC_SURVIVOR_ID]);
    expect(raw).not.toContain(DOOMED_TEXT);
  });

  it('documento movido para outra empresa entre a busca e o enriquecimento também cai', async () => {
    pendingRace = async () => {
      await testDb.db`UPDATE documents SET tenant_id = ${TENANT_B} WHERE id = ${DOC_DOOMED_ID}`;
    };

    const { body, raw } = await search({ generateAnswer: false });

    expect(body.chunks.map((c) => c.documentId)).toEqual([DOC_SURVIVOR_ID]);
    expect(raw).not.toContain(DOOMED_TEXT);
  });

  it('RAG (generateAnswer): texto de documento excluído na corrida não vira contexto do LLM', async () => {
    // Caminho por CHUNK (`generateAnswer: true` não passa pelo paginado).
    // Excluindo AMBOS os documentos na corrida, `chunks` fica vazio e a rota
    // responde JSON sem sequer chamar o LLM — prova de que nenhum texto órfão
    // chegou ao prompt.
    pendingRace = async () => {
      await testDb.db`UPDATE documents SET deleted = true WHERE tenant_id = ${TENANT_A}`;
    };

    const { body, raw } = await search({ generateAnswer: true });

    expect(body.chunks).toEqual([]);
    expect(raw).not.toContain(DOOMED_TEXT);
    expect(raw).not.toContain(SURVIVOR_TEXT);
  });
});
