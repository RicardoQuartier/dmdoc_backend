import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { Logger } from 'pino';
import type { DocumentProcessingJobData } from '@dmdoc/shared-types';
import type { ExtractResult } from '../extract.js';

/**
 * `persistProcessingResult` agora resolve as feature flags de IA (auto-
 * aplicação de tipo/título, pedido do Owner 2026-07-22) — mockamos
 * `resolveAiFeatureFlags` e mantemos o resto de `@dmdoc/db-pg`
 * (`DocumentEventsRepository`) real, via `importOriginal`. Default `{}`
 * (todas as flags de auto-aplicação `undefined`/falsy) preserva o
 * comportamento dos testes pré-existentes, que nunca esperam auto-aplicação —
 * os novos testes de auto-aplicação (final do arquivo) sobrescrevem o mock
 * pontualmente com `mockResolvedValueOnce`.
 */
const { resolveAiFeatureFlagsMock } = vi.hoisted(() => ({
  resolveAiFeatureFlagsMock: vi.fn().mockResolvedValue({}),
}));

vi.mock('@dmdoc/db-pg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dmdoc/db-pg')>();
  return { ...actual, resolveAiFeatureFlags: resolveAiFeatureFlagsMock };
});

const { persistProcessingResult } = await import('../persist.js');

/**
 * Testes do backfill de `page_count` em `document_events` na etapa final do
 * pipeline (persistProcessingResult, caminho de sucesso → READY).
 *
 * Regra de negócio (wiki "Histórico de eventos de upload e relatório de uso"):
 * o evento de upload nasce com `page_count: null` e é preenchido por backfill
 * quando o documento fica READY. O backfill é escopado por `tenantId` —
 * eventos de outra empresa com o mesmo `documentId` nunca são afetados.
 *
 * Não usamos PostgreSQL real: um stub mínimo do `Sql` intercepta as tagged
 * template literals do postgres.js. As demais operações (DELETE chunks,
 * INSERT chunks, INSERT document_content, UPDATE documents) são no-op.
 * O foco aqui é o backfill e seu escopo.
 */

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';
const DOCUMENT_ID = '00000000-0000-0000-0000-000000000001';

interface UploadEvent {
  id: string;
  tenantId: string;
  documentId: string;
  pageCount: number | null;
}

function makeSilentLogger(): Logger {
  return {
    child: () => makeSilentLogger(),
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger;
}

function makeJob(tenantId: string): DocumentProcessingJobData {
  return {
    tenantId,
    documentId: DOCUMENT_ID,
    s3Key: `tenants/${tenantId}/documents/${DOCUMENT_ID}/file.pdf`,
    mimeType: 'application/pdf',
  };
}

function makeExtractResult(pageCount: number): ExtractResult {
  return {
    fullText: 'conteúdo extraído',
    pageCount,
    ocrPages: [],
    engine: 'native',
    engineVersion: '1.0.0',
    durationMs: 10,
    fromCache: false,
  };
}

/**
 * Constrói um `Sql` stub compatível com postgres.js tagged templates.
 *
 * postgres.js chama o template tag com (strings: TemplateStringsArray, ...values).
 * O stub reconstrói a query concatenando as strings com os valores interpolados
 * para detectar o tipo de operação, depois aplica o comportamento correspondente.
 *
 * Também suporta `sql(tableName)` (chamada como função para identificador) e
 * `sql.json(value)` retornando o valor direto.
 */
function makeSqlStub(events: UploadEvent[]): Sql {
  // Resultado no-op
  const noopResult = Object.assign([], { count: 0 });

  /**
   * Reconstrói a query colapsando os valores nos placeholders para detecção.
   * Não é SQL seguro — apenas para comparação de conteúdo no stub.
   */
  function buildQuery(strings: TemplateStringsArray, values: unknown[]): string {
    let q = '';
    for (let i = 0; i < strings.length; i++) {
      q += strings[i] ?? '';
      if (i < values.length) {
        const v = values[i];
        // Se o valor é um identificador retornado por sql(name), extrair o nome
        if (v && typeof v === 'object' && '__pgIdentifier' in (v as object)) {
          q += (v as { __pgIdentifier: string }).__pgIdentifier;
        } else {
          q += String(v ?? '');
        }
      }
    }
    return q.toLowerCase();
  }

  // A função principal (tagged template)
  const sqlFn = vi.fn().mockImplementation(
    (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      // Chamada como sql(tableName) para identificador — retorna marcador especial
      if (typeof strings === 'string') {
        return { __pgIdentifier: strings };
      }

      // Chamada como sql(rowsArray) para bulk insert — retorna marcador
      if (Array.isArray(strings) && !('raw' in strings)) {
        return { __pgBulkRows: strings };
      }

      const query = buildQuery(strings as TemplateStringsArray, values);

      if (query.includes('delete from chunks')) {
        return Promise.resolve(Object.assign([], { count: 0 }));
      }
      if (query.includes('insert into chunks')) {
        return Promise.resolve(noopResult);
      }
      if (query.includes('insert into document_content')) {
        return Promise.resolve(noopResult);
      }
      if (query.includes('update documents')) {
        return Promise.resolve(noopResult);
      }
      if (query.includes('update') && query.includes('document_events')) {
        // backfillPageCount emite:
        // UPDATE ${sql('document_events')} SET page_count=${pageCount}
        // WHERE document_id=${documentId} AND tenant_id=${tenantId}
        //
        // Os values interpolados na ordem são:
        //   values[0] = sql('document_events') → identificador (objeto)
        //   values[1] = pageCount
        //   values[2] = documentId
        //   values[3] = tenantId
        const [, pageCount, docId, tenantId] = values as [unknown, number, string, string];
        let count = 0;
        for (const ev of events) {
          if (ev.tenantId === tenantId && ev.documentId === docId) {
            ev.pageCount = pageCount;
            count++;
          }
        }
        return Promise.resolve(Object.assign([], { count }));
      }

      return Promise.resolve(noopResult);
    }
  );

  // sql.json(value) — encapsula para JSONB
  (sqlFn as unknown as Record<string, unknown>)['json'] = (val: unknown) => val;

  return sqlFn as unknown as Sql;
}

describe('persistProcessingResult — backfill de pageCount em document_events', () => {
  it('preenche pageCount em todos os eventos do documentId no tenant', async () => {
    const events: UploadEvent[] = [
      { id: 'e1', tenantId: TENANT_A, documentId: DOCUMENT_ID, pageCount: null },
      { id: 'e2', tenantId: TENANT_A, documentId: DOCUMENT_ID, pageCount: null },
    ];
    const sql = makeSqlStub(events);

    await persistProcessingResult(
      {
        job: makeJob(TENANT_A),
        extractResult: makeExtractResult(7),
        embeddedChunks: [],
        totalEmbeddingsUsd: 0,
        typeSuggestion: null,
        suggestedTitle: null,
        classificationUsd: 0,
        pipelineStartedAt: new Date(),
        typeAutoApplyMinConfidence: 0.5,
      },
      { sql, logger: makeSilentLogger() }
    );

    expect(events.every((e) => e.pageCount === 7)).toBe(true);
  });

  it('não afeta eventos de outro tenant com o mesmo documentId', async () => {
    const events: UploadEvent[] = [
      { id: 'a1', tenantId: TENANT_A, documentId: DOCUMENT_ID, pageCount: null },
      { id: 'b1', tenantId: TENANT_B, documentId: DOCUMENT_ID, pageCount: null },
    ];
    const sql = makeSqlStub(events);

    await persistProcessingResult(
      {
        job: makeJob(TENANT_A),
        extractResult: makeExtractResult(12),
        embeddedChunks: [],
        totalEmbeddingsUsd: 0,
        typeSuggestion: null,
        suggestedTitle: null,
        classificationUsd: 0,
        pipelineStartedAt: new Date(),
        typeAutoApplyMinConfidence: 0.5,
      },
      { sql, logger: makeSilentLogger() }
    );

    const tenantAEvent = events.find((e) => e.id === 'a1');
    const tenantBEvent = events.find((e) => e.id === 'b1');
    expect(tenantAEvent?.pageCount).toBe(12);
    expect(tenantBEvent?.pageCount).toBeNull();
  });

  it('é idempotente: reexecutar com o mesmo pageCount mantém o resultado', async () => {
    const events: UploadEvent[] = [
      { id: 'e1', tenantId: TENANT_A, documentId: DOCUMENT_ID, pageCount: null },
    ];
    const sql = makeSqlStub(events);

    const run = (): Promise<void> =>
      persistProcessingResult(
        {
          job: makeJob(TENANT_A),
          extractResult: makeExtractResult(5),
          embeddedChunks: [],
          totalEmbeddingsUsd: 0,
          typeSuggestion: null,
          suggestedTitle: null,
          classificationUsd: 0,
          pipelineStartedAt: new Date(),
          typeAutoApplyMinConfidence: 0.5,
        },
        { sql, logger: makeSilentLogger() }
      );

    await run();
    await run();

    expect(events[0]?.pageCount).toBe(5);
  });
});

/**
 * Testes da INVARIANTE mais importante da Fase 8.1 (wiki "Título de exibição
 * sugerido por IA"):
 *
 * O worker grava APENAS `documents.suggested_title` — a coluna `title` (o
 * título CONFIRMADO pelo usuário) NUNCA é tocada no pipeline. Reprocessar
 * sobrescreve a sugestão (inclusive para `null`), mas jamais altera o título
 * confirmado.
 *
 * Modelamos uma linha da tabela `documents` (com `title` e `suggested_title`)
 * num stub que aplica o UPDATE do persist e captura a query emitida, para
 * verificar tanto o efeito nos dados quanto que a coluna `title` não aparece
 * no SET.
 */
interface DocumentRow {
  id: string;
  tenantId: string;
  title: string | null;
  suggestedTitle: string | null;
}

function makeDocumentsSqlStub(
  doc: DocumentRow,
  captured: { updateDocumentsQuery: string | null }
): Sql {
  const noopResult = Object.assign([], { count: 0 });

  function buildQuery(strings: TemplateStringsArray, values: unknown[]): string {
    let q = '';
    for (let i = 0; i < strings.length; i++) {
      q += strings[i] ?? '';
      if (i < values.length) {
        const v = values[i];
        if (v && typeof v === 'object' && '__pgIdentifier' in (v as object)) {
          q += (v as { __pgIdentifier: string }).__pgIdentifier;
        } else {
          q += String(v ?? '');
        }
      }
    }
    return q.toLowerCase();
  }

  const sqlFn = vi.fn().mockImplementation(
    (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      if (typeof strings === 'string') {
        return { __pgIdentifier: strings };
      }
      if (Array.isArray(strings) && !('raw' in strings)) {
        return { __pgBulkRows: strings };
      }

      const query = buildQuery(strings as TemplateStringsArray, values);

      if (query.includes('update documents')) {
        // Captura a query (com placeholders colapsados) para inspeção do SET.
        captured.updateDocumentsQuery = query;
        // Ordem dos valores interpolados no UPDATE:
        //   values[0] = costUsdCents
        //   values[1] = suggestedTitle
        //   values[2] = documentId
        //   values[3] = tenantId
        const [, suggestedTitle, docId, tenantId] = values as [
          unknown,
          string | null,
          string,
          string,
        ];
        if (doc.id === docId && doc.tenantId === tenantId) {
          // INVARIANTE: só a sugestão é escrita; `title` permanece intacto.
          doc.suggestedTitle = suggestedTitle;
        }
        return Promise.resolve(noopResult);
      }

      return Promise.resolve(noopResult);
    }
  );

  (sqlFn as unknown as Record<string, unknown>)['json'] = (val: unknown) => val;

  return sqlFn as unknown as Sql;
}

describe('persistProcessingResult — invariante: só grava suggested_title, nunca title', () => {
  it('sobrescreve suggested_title e preserva o title confirmado pelo usuário', async () => {
    const doc: DocumentRow = {
      id: DOCUMENT_ID,
      tenantId: TENANT_A,
      // Título já confirmado manualmente pelo usuário.
      title: 'Título confirmado pelo usuário',
      // Sugestão anterior de um processamento passado.
      suggestedTitle: 'Sugestão antiga',
    };
    const captured = { updateDocumentsQuery: null as string | null };
    const sql = makeDocumentsSqlStub(doc, captured);

    await persistProcessingResult(
      {
        job: makeJob(TENANT_A),
        extractResult: makeExtractResult(3),
        embeddedChunks: [],
        totalEmbeddingsUsd: 0,
        typeSuggestion: null,
        suggestedTitle: 'Nova sugestão de título gerada pela IA',
        classificationUsd: 0,
        pipelineStartedAt: new Date(),
        typeAutoApplyMinConfidence: 0.5,
      },
      { sql, logger: makeSilentLogger() }
    );

    // suggested_title foi sobrescrito com a nova sugestão.
    expect(doc.suggestedTitle).toBe('Nova sugestão de título gerada pela IA');
    // title confirmado permanece INTACTO — worker nunca o toca.
    expect(doc.title).toBe('Título confirmado pelo usuário');
    // A query de UPDATE escreve suggested_title, mas não a coluna `title`.
    expect(captured.updateDocumentsQuery).toContain('suggested_title');
    // Não há atribuição da coluna `title` no SET (o `_` antes de "title" em
    // "suggested_title" garante que este regex não casa com a sugestão).
    expect(captured.updateDocumentsQuery).not.toMatch(/[^_]title\s*=/);
  });

  it('grava suggested_title null (sem sugestão) sem alterar o title confirmado', async () => {
    const doc: DocumentRow = {
      id: DOCUMENT_ID,
      tenantId: TENANT_A,
      title: 'Título confirmado pelo usuário',
      suggestedTitle: 'Sugestão antiga a ser limpa',
    };
    const captured = { updateDocumentsQuery: null as string | null };
    const sql = makeDocumentsSqlStub(doc, captured);

    await persistProcessingResult(
      {
        job: makeJob(TENANT_A),
        extractResult: makeExtractResult(3),
        embeddedChunks: [],
        totalEmbeddingsUsd: 0,
        typeSuggestion: null,
        // Feature off / fallback / título não inferido ⇒ null sobrescreve.
        suggestedTitle: null,
        classificationUsd: 0,
        pipelineStartedAt: new Date(),
        typeAutoApplyMinConfidence: 0.5,
      },
      { sql, logger: makeSilentLogger() }
    );

    // Idempotência coerente com type_suggestion: null limpa a sugestão anterior.
    expect(doc.suggestedTitle).toBeNull();
    // O título confirmado continua preservado.
    expect(doc.title).toBe('Título confirmado pelo usuário');
  });
});

/**
 * Testes da auto-aplicação de tipo/título (pedido do Owner, 2026-07-22) —
 * cobre tanto o upload (documento novo, campos sempre NULL) quanto o
 * reprocessamento individual via `POST /documents/:id/reprocess` (mesmo
 * pipeline, documento pode já ter tipo/título confirmados).
 */
function makeAutoApplySqlStub(): { sql: Sql; documentsUpdates: Array<{ query: string; values: unknown[] }> } {
  const noopResult = Object.assign([], { count: 0 });
  const documentsUpdates: Array<{ query: string; values: unknown[] }> = [];

  function buildStructuralQuery(strings: TemplateStringsArray): string {
    return strings.join('?').toLowerCase();
  }

  const sqlFn = vi.fn().mockImplementation(
    (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      if (typeof strings === 'string') return { __pgIdentifier: strings };
      if (Array.isArray(strings) && !('raw' in strings)) return { __pgBulkRows: strings };

      const structural = buildStructuralQuery(strings as TemplateStringsArray);
      if (structural.includes('update documents')) {
        documentsUpdates.push({ query: structural, values });
      }
      return Promise.resolve(noopResult);
    }
  );
  (sqlFn as unknown as Record<string, unknown>)['json'] = (val: unknown) => val;

  return { sql: sqlFn as unknown as Sql, documentsUpdates };
}

function makeTypeSuggestion(overrides: { documentTypeId?: string | null; confidence?: number } = {}) {
  return {
    documentTypeId: overrides.documentTypeId ?? 'type-1',
    documentTypeName: 'Contrato',
    confidence: overrides.confidence ?? 0.9,
    model: 'gpt-4o-mini',
    promptVersion: 'classify-document-type-v3',
    suggestedAt: new Date(),
    rawResponse: {},
  };
}

describe('persistProcessingResult — auto-aplicação de tipo/título (gate por flag, COM SOBRESCRITA)', () => {
  it('auto-aplica document_type_id quando classificationAutoApplyEnabled está ligada e a confiança é suficiente', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValueOnce({ classificationAutoApplyEnabled: true });
    const { sql, documentsUpdates } = makeAutoApplySqlStub();

    await persistProcessingResult(
      {
        job: makeJob(TENANT_A),
        extractResult: makeExtractResult(1),
        embeddedChunks: [],
        totalEmbeddingsUsd: 0,
        typeSuggestion: makeTypeSuggestion(),
        suggestedTitle: null,
        classificationUsd: 0,
        pipelineStartedAt: new Date(),
        typeAutoApplyMinConfidence: 0.5,
      },
      { sql, logger: makeSilentLogger() }
    );

    const typeUpdate = documentsUpdates.find((u) => u.query.includes('document_type_id = ?'));
    expect(typeUpdate).toBeDefined();
    expect(typeUpdate!.values[0]).toBe('type-1');
    // SOBRESCRITA (decisão do Owner, 2026-07-22): sem WHERE ... IS NULL — o
    // UPDATE substitui incondicionalmente (dado o gate de confiança já ter
    // passado), mesmo que o documento já tivesse um tipo confirmado antes
    // (ex.: reprocessamento individual reusa este mesmo pipeline).
    expect(typeUpdate!.query).not.toContain('is null');
  });

  it('NÃO auto-aplica document_type_id quando classificationAutoApplyEnabled está desligada', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValueOnce({ classificationAutoApplyEnabled: false });
    const { sql, documentsUpdates } = makeAutoApplySqlStub();

    await persistProcessingResult(
      {
        job: makeJob(TENANT_A),
        extractResult: makeExtractResult(1),
        embeddedChunks: [],
        totalEmbeddingsUsd: 0,
        typeSuggestion: makeTypeSuggestion(),
        suggestedTitle: null,
        classificationUsd: 0,
        pipelineStartedAt: new Date(),
        typeAutoApplyMinConfidence: 0.5,
      },
      { sql, logger: makeSilentLogger() }
    );

    expect(documentsUpdates.find((u) => u.query.includes('document_type_id = ?'))).toBeUndefined();
  });

  it('NÃO auto-aplica document_type_id quando a confiança está abaixo do limiar', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValueOnce({ classificationAutoApplyEnabled: true });
    const { sql, documentsUpdates } = makeAutoApplySqlStub();

    await persistProcessingResult(
      {
        job: makeJob(TENANT_A),
        extractResult: makeExtractResult(1),
        embeddedChunks: [],
        totalEmbeddingsUsd: 0,
        typeSuggestion: makeTypeSuggestion({ confidence: 0.2 }),
        suggestedTitle: null,
        classificationUsd: 0,
        pipelineStartedAt: new Date(),
        typeAutoApplyMinConfidence: 0.5,
      },
      { sql, logger: makeSilentLogger() }
    );

    expect(documentsUpdates.find((u) => u.query.includes('document_type_id = ?'))).toBeUndefined();
  });

  it('preserva document_type_id quando a classificação não sugere tipo (documentTypeId null), mesmo com a flag ligada', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValueOnce({ classificationAutoApplyEnabled: true });
    const { sql, documentsUpdates } = makeAutoApplySqlStub();

    await persistProcessingResult(
      {
        job: makeJob(TENANT_A),
        extractResult: makeExtractResult(1),
        embeddedChunks: [],
        totalEmbeddingsUsd: 0,
        typeSuggestion: { ...makeTypeSuggestion(), documentTypeId: null },
        suggestedTitle: null,
        classificationUsd: 0,
        pipelineStartedAt: new Date(),
        typeAutoApplyMinConfidence: 0.5,
      },
      { sql, logger: makeSilentLogger() }
    );

    expect(documentsUpdates.find((u) => u.query.includes('document_type_id = ?'))).toBeUndefined();
  });

  it('SOBRESCREVE title (sem COALESCE) quando titleAutoApplyEnabled está ligada e a sugestão vem preenchida', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValueOnce({ titleAutoApplyEnabled: true });
    const { sql, documentsUpdates } = makeAutoApplySqlStub();

    await persistProcessingResult(
      {
        job: makeJob(TENANT_A),
        extractResult: makeExtractResult(1),
        embeddedChunks: [],
        totalEmbeddingsUsd: 0,
        typeSuggestion: null,
        suggestedTitle: 'Título sugerido pela IA',
        classificationUsd: 0,
        pipelineStartedAt: new Date(),
        typeAutoApplyMinConfidence: 0.5,
      },
      { sql, logger: makeSilentLogger() }
    );

    const titleUpdate = documentsUpdates.find((u) => u.query.includes('set title = ?'));
    expect(titleUpdate).toBeDefined();
    expect(titleUpdate!.values[0]).toBe('Título sugerido pela IA');
    // SOBRESCRITA (decisão do Owner, 2026-07-22): nem COALESCE nem WHERE title
    // IS NULL — substitui incondicionalmente um título já confirmado.
    expect(titleUpdate!.query).not.toContain('coalesce');
    expect(titleUpdate!.query).not.toContain('is null');
  });

  it('NÃO auto-aplica title quando titleAutoApplyEnabled está desligada', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValueOnce({ titleAutoApplyEnabled: false });
    const { sql, documentsUpdates } = makeAutoApplySqlStub();

    await persistProcessingResult(
      {
        job: makeJob(TENANT_A),
        extractResult: makeExtractResult(1),
        embeddedChunks: [],
        totalEmbeddingsUsd: 0,
        typeSuggestion: null,
        suggestedTitle: 'Título sugerido pela IA',
        classificationUsd: 0,
        pipelineStartedAt: new Date(),
        typeAutoApplyMinConfidence: 0.5,
      },
      { sql, logger: makeSilentLogger() }
    );

    expect(documentsUpdates.find((u) => u.query.includes('set title = ?'))).toBeUndefined();
  });

  it('preserva title quando a sugestão desta rodada vier nula, mesmo com titleAutoApplyEnabled ligada', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValueOnce({ titleAutoApplyEnabled: true });
    const { sql, documentsUpdates } = makeAutoApplySqlStub();

    await persistProcessingResult(
      {
        job: makeJob(TENANT_A),
        extractResult: makeExtractResult(1),
        embeddedChunks: [],
        totalEmbeddingsUsd: 0,
        typeSuggestion: null,
        suggestedTitle: null,
        classificationUsd: 0,
        pipelineStartedAt: new Date(),
        typeAutoApplyMinConfidence: 0.5,
      },
      { sql, logger: makeSilentLogger() }
    );

    expect(documentsUpdates.find((u) => u.query.includes('set title = ?'))).toBeUndefined();
  });
});
