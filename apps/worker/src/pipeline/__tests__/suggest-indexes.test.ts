import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import type { Logger } from 'pino';
import type { TypeSuggestion } from '@dmdoc/shared-types';

/**
 * Testes do GATILHO 1 (Fase 7): a etapa `suggestIndexesStep` do pipeline do
 * worker. Foco na DECISÃO de disparar ou não a sugestão automática de índices,
 * e no invariante best-effort (falha de IA nunca derruba o pipeline).
 *
 * Dispara SOMENTE quando:
 *  - há tipo SUGERIDO (`typeSuggestion.documentTypeId != null`);
 *  - `confidence >= minConfidence` (limiar 0.5);
 *  - `indexSuggestionEnabled` (plataforma AND empresa) ligado.
 *
 * As dependências pesadas (helper de flags e o núcleo de IA) são mockadas — o
 * alvo é a orquestração/decisão da etapa, não o prompt nem a query.
 */

const { resolveAiFeatureFlagsMock, suggestIndexValuesMock } = vi.hoisted(() => ({
  resolveAiFeatureFlagsMock: vi.fn(),
  suggestIndexValuesMock: vi.fn(),
}));

vi.mock('@dmdoc/db-pg', () => ({
  resolveAiFeatureFlags: resolveAiFeatureFlagsMock,
}));

vi.mock('@dmdoc/llm-provider', () => ({
  suggestIndexValues: suggestIndexValuesMock,
  SUGGEST_INDEXES_PROMPT: { version: 'suggest-indexes-v1' },
}));

const { suggestIndexesStep } = await import('../suggest-indexes.js');

const TENANT_ID = '00000000-0000-0000-0000-00000000000a';
const DOCUMENT_ID = '00000000-0000-0000-0000-000000000001';
const SUGGESTED_TYPE_ID = '00000000-0000-0000-0000-0000000000c1';

function makeSilentLogger(): Logger {
  const logger = {
    child: () => logger,
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  };
  return logger as unknown as Logger;
}

/**
 * Stub de `Sql` (postgres.js tagged template) para a etapa: devolve o conteúdo
 * do documento e os campos de índice; UPDATEs são no-op mas contabilizados.
 */
function makeSqlStub(): { sql: Sql; updates: string[] } {
  const updates: string[] = [];
  const noop = Object.assign([], { count: 0 });

  function buildQuery(strings: TemplateStringsArray, values: unknown[]): string {
    let q = '';
    for (let i = 0; i < strings.length; i++) {
      q += strings[i] ?? '';
      if (i < values.length) q += String(values[i] ?? '');
    }
    return q.toLowerCase();
  }

  const sqlFn = vi.fn().mockImplementation(
    (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      if (typeof strings === 'string') return { __pgIdentifier: strings };
      const query = buildQuery(strings as TemplateStringsArray, values);

      if (query.includes('from document_content')) {
        return Promise.resolve([{ full_text: 'texto completo do documento', cost_breakdown: null }]);
      }
      if (query.includes('from document_type_index_fields')) {
        return Promise.resolve([
          {
            id: 'f1',
            name: 'Cliente',
            field_type: 'TEXT',
            required: false,
            ai_extraction_hint: null,
            sort_order: 0,
            show_on_search: true,
            deleted: false,
          },
        ]);
      }
      if (query.includes('update document_content')) {
        updates.push('document_content');
        return Promise.resolve(noop);
      }
      if (query.includes('update documents')) {
        updates.push('documents');
        return Promise.resolve(noop);
      }
      return Promise.resolve(noop);
    }
  );
  (sqlFn as unknown as Record<string, unknown>)['json'] = (val: unknown) => val;

  return { sql: sqlFn as unknown as Sql, updates };
}

function makeTypeSuggestion(overrides: Partial<TypeSuggestion> = {}): TypeSuggestion {
  return {
    documentTypeId: SUGGESTED_TYPE_ID,
    documentTypeName: 'Contrato',
    confidence: 0.9,
    model: 'gpt-4o-mini',
    promptVersion: 'classify-document-type-v3',
    suggestedAt: new Date(),
    rawResponse: {},
    ...overrides,
  };
}

function coreResult() {
  return {
    values: { Cliente: 'ACME Ltda' },
    fields: [{ name: 'Cliente', value: 'ACME Ltda', confidence: 0.9 }],
    model: 'gpt-4o-mini',
    promptVersion: 'suggest-indexes-v1',
    rawResponse: { fields: [{ name: 'Cliente', value: 'ACME Ltda', confidence: 0.9 }] },
    costUsd: 0.0002,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('suggestIndexesStep — decisão do gatilho automático (Fase 7)', () => {
  it('dispara quando confiança >= 0.5 e feature ligada, persistindo a sugestão', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({
      classificationEnabled: true,
      titleSuggestionEnabled: false,
      indexSuggestionEnabled: true,
    });
    suggestIndexValuesMock.mockResolvedValue(coreResult());
    const { sql, updates } = makeSqlStub();

    await suggestIndexesStep(
      {
        tenantId: TENANT_ID,
        documentId: DOCUMENT_ID,
        typeSuggestion: makeTypeSuggestion({ confidence: 0.5 }),
        minConfidence: 0.5,
      },
      { sql, llmProvider: {} as never, logger: makeSilentLogger() }
    );

    expect(suggestIndexValuesMock).toHaveBeenCalledTimes(1);
    // Usa o TIPO SUGERIDO ao ler os campos de índice (via sql), e persiste.
    expect(updates).toContain('document_content');
    expect(updates).toContain('documents');
  });

  it('NÃO dispara quando a feature está desligada para a empresa', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({
      classificationEnabled: true,
      titleSuggestionEnabled: false,
      indexSuggestionEnabled: false,
    });
    const { sql, updates } = makeSqlStub();

    await suggestIndexesStep(
      {
        tenantId: TENANT_ID,
        documentId: DOCUMENT_ID,
        typeSuggestion: makeTypeSuggestion(),
        minConfidence: 0.5,
      },
      { sql, llmProvider: {} as never, logger: makeSilentLogger() }
    );

    expect(suggestIndexValuesMock).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it('NÃO dispara (nem checa flag) quando a classificação não sugeriu tipo', async () => {
    const { sql } = makeSqlStub();

    await suggestIndexesStep(
      {
        tenantId: TENANT_ID,
        documentId: DOCUMENT_ID,
        typeSuggestion: makeTypeSuggestion({ documentTypeId: null, confidence: 0 }),
        minConfidence: 0.5,
      },
      { sql, llmProvider: {} as never, logger: makeSilentLogger() }
    );

    expect(resolveAiFeatureFlagsMock).not.toHaveBeenCalled();
    expect(suggestIndexValuesMock).not.toHaveBeenCalled();
  });

  it('NÃO dispara quando typeSuggestion é null', async () => {
    const { sql } = makeSqlStub();

    await suggestIndexesStep(
      { tenantId: TENANT_ID, documentId: DOCUMENT_ID, typeSuggestion: null, minConfidence: 0.5 },
      { sql, llmProvider: {} as never, logger: makeSilentLogger() }
    );

    expect(resolveAiFeatureFlagsMock).not.toHaveBeenCalled();
    expect(suggestIndexValuesMock).not.toHaveBeenCalled();
  });

  it('NÃO dispara quando a confiança está abaixo do limiar', async () => {
    const { sql } = makeSqlStub();

    await suggestIndexesStep(
      {
        tenantId: TENANT_ID,
        documentId: DOCUMENT_ID,
        typeSuggestion: makeTypeSuggestion({ confidence: 0.49 }),
        minConfidence: 0.5,
      },
      { sql, llmProvider: {} as never, logger: makeSilentLogger() }
    );

    expect(resolveAiFeatureFlagsMock).not.toHaveBeenCalled();
    expect(suggestIndexValuesMock).not.toHaveBeenCalled();
  });

  it('é best-effort: erro do núcleo (LLM) não relança e não derruba o pipeline', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({
      classificationEnabled: true,
      titleSuggestionEnabled: false,
      indexSuggestionEnabled: true,
    });
    suggestIndexValuesMock.mockRejectedValue(new Error('provedor de LLM fora do ar'));
    const { sql } = makeSqlStub();

    // Não deve lançar.
    await expect(
      suggestIndexesStep(
        {
          tenantId: TENANT_ID,
          documentId: DOCUMENT_ID,
          typeSuggestion: makeTypeSuggestion(),
          minConfidence: 0.5,
        },
        { sql, llmProvider: {} as never, logger: makeSilentLogger() }
      )
    ).resolves.toBeUndefined();
  });

  it('é best-effort: erro ao resolver flags não relança', async () => {
    resolveAiFeatureFlagsMock.mockRejectedValue(new Error('tenant não encontrado'));
    const { sql } = makeSqlStub();

    await expect(
      suggestIndexesStep(
        {
          tenantId: TENANT_ID,
          documentId: DOCUMENT_ID,
          typeSuggestion: makeTypeSuggestion(),
          minConfidence: 0.5,
        },
        { sql, llmProvider: {} as never, logger: makeSilentLogger() }
      )
    ).resolves.toBeUndefined();
    expect(suggestIndexValuesMock).not.toHaveBeenCalled();
  });
});
