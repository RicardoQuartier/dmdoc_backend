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
  // Implementação real (lógica pura) — vale exercitar o merge de verdade.
  // COM SOBRESCRITA (decisão do Owner, 2026-07-22): espelha
  // `mergeSuggestedIndexValues` de `@dmdoc/llm-provider` — substitui um campo
  // já confirmado quando a sugestão desta rodada vier preenchida; só preserva
  // quando a sugestão vier vazia para aquele campo ou o valor coercionado for
  // idêntico ao já confirmado.
  mergeSuggestedIndexValues: (
    currentIndexValues: Record<string, string | number | null>,
    suggestedValues: Record<string, string>,
    indexFields: Array<{ name: string; field_type: string }>,
  ) => {
    const fieldTypeByName = new Map(indexFields.map((f) => [f.name, f.field_type]));
    const merged: Record<string, string | number | null> = { ...currentIndexValues };
    let appliedCount = 0;
    for (const [fieldName, rawValue] of Object.entries(suggestedValues)) {
      if (rawValue === '') continue;
      const fieldType = fieldTypeByName.get(fieldName);
      const newValue =
        fieldType === 'NUMBER' ? (Number.isFinite(Number(rawValue)) ? Number(rawValue) : rawValue) : rawValue;
      if (merged[fieldName] === newValue) continue;
      merged[fieldName] = newValue;
      appliedCount += 1;
    }
    return { merged, appliedCount };
  },
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

interface SqlStubOptions {
  /** Estado ATUAL do documento — só relevante para os testes de auto-aplicação. */
  doc?: { document_type_id: string | null; index_values: Record<string, string | number | null> };
}

/**
 * Stub de `Sql` (postgres.js tagged template) para a etapa: devolve o conteúdo
 * do documento e os campos de índice; UPDATEs são no-op mas contabilizados.
 * `documentsUpdates` guarda query estrutural + valores de cada `UPDATE
 * documents` — usado para inspecionar a auto-aplicação em `index_values`.
 */
function makeSqlStub(
  opts: SqlStubOptions = {},
): { sql: Sql; updates: string[]; documentsUpdates: Array<{ query: string; values: unknown[] }> } {
  const doc = opts.doc ?? null;
  const updates: string[] = [];
  const documentsUpdates: Array<{ query: string; values: unknown[] }> = [];
  const noop = Object.assign([], { count: 0 });

  function buildQuery(strings: TemplateStringsArray, values: unknown[]): string {
    let q = '';
    for (let i = 0; i < strings.length; i++) {
      q += strings[i] ?? '';
      if (i < values.length) q += String(values[i] ?? '');
    }
    return q.toLowerCase();
  }

  function buildStructuralQuery(strings: TemplateStringsArray): string {
    return strings.join('?').toLowerCase();
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
      if (query.includes('document_type_id') && query.includes('from documents')) {
        return Promise.resolve(doc === null ? [] : [doc]);
      }
      if (query.includes('update document_content')) {
        updates.push('document_content');
        return Promise.resolve(noop);
      }
      if (query.includes('update documents')) {
        updates.push('documents');
        documentsUpdates.push({ query: buildStructuralQuery(strings as TemplateStringsArray), values });
        return Promise.resolve(noop);
      }
      return Promise.resolve(noop);
    }
  );
  (sqlFn as unknown as Record<string, unknown>)['json'] = (val: unknown) => val;

  return { sql: sqlFn as unknown as Sql, updates, documentsUpdates };
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

describe('suggestIndexesStep — auto-aplicação de índices (gate: aiIndexAutoApplyEnabled)', () => {
  it('aplica quando o tipo CONFIRMADO do documento é exatamente o tipo sugerido', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({ indexSuggestionEnabled: true, indexAutoApplyEnabled: true });
    suggestIndexValuesMock.mockResolvedValue(coreResult());
    const { sql, documentsUpdates } = makeSqlStub({ doc: { document_type_id: SUGGESTED_TYPE_ID, index_values: {} } });

    await suggestIndexesStep(
      { tenantId: TENANT_ID, documentId: DOCUMENT_ID, typeSuggestion: makeTypeSuggestion(), minConfidence: 0.5 },
      { sql, llmProvider: {} as never, logger: makeSilentLogger() },
    );

    const indexUpdate = documentsUpdates.find((u) => u.query.includes('index_values = ?'));
    expect(indexUpdate).toBeDefined();
    expect(indexUpdate!.values[0]).toEqual({ Cliente: 'ACME Ltda' });
  });

  it('SOBRESCREVE um campo de índice já confirmado quando o tipo confirmado é o sugerido e a sugestão vem preenchida', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({ indexSuggestionEnabled: true, indexAutoApplyEnabled: true });
    suggestIndexValuesMock.mockResolvedValue(coreResult());
    const { sql, documentsUpdates } = makeSqlStub({
      doc: { document_type_id: SUGGESTED_TYPE_ID, index_values: { Cliente: 'Valor antigo confirmado' } },
    });

    await suggestIndexesStep(
      { tenantId: TENANT_ID, documentId: DOCUMENT_ID, typeSuggestion: makeTypeSuggestion(), minConfidence: 0.5 },
      { sql, llmProvider: {} as never, logger: makeSilentLogger() },
    );

    const indexUpdate = documentsUpdates.find((u) => u.query.includes('index_values = ?'));
    expect(indexUpdate).toBeDefined();
    expect(indexUpdate!.values[0]).toEqual({ Cliente: 'ACME Ltda' });
  });

  it('PRESERVA um campo de índice específico já confirmado quando a sugestão desta rodada não o inclui', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({ indexSuggestionEnabled: true, indexAutoApplyEnabled: true });
    // Esta rodada só sugere "Cliente" — "Fornecedor" fica de fora.
    suggestIndexValuesMock.mockResolvedValue(coreResult());
    const { sql, documentsUpdates } = makeSqlStub({
      doc: {
        document_type_id: SUGGESTED_TYPE_ID,
        index_values: { Cliente: 'Valor antigo', Fornecedor: 'Fornecedor confirmado antes' },
      },
    });

    await suggestIndexesStep(
      { tenantId: TENANT_ID, documentId: DOCUMENT_ID, typeSuggestion: makeTypeSuggestion(), minConfidence: 0.5 },
      { sql, llmProvider: {} as never, logger: makeSilentLogger() },
    );

    const indexUpdate = documentsUpdates.find((u) => u.query.includes('index_values = ?'));
    expect(indexUpdate).toBeDefined();
    expect(indexUpdate!.values[0]).toEqual({ Cliente: 'ACME Ltda', Fornecedor: 'Fornecedor confirmado antes' });
  });

  it('NÃO aplica quando o tipo confirmado é outro (órfão) — índice de um tipo que não é o oficial', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({ indexSuggestionEnabled: true, indexAutoApplyEnabled: true });
    suggestIndexValuesMock.mockResolvedValue(coreResult());
    const { sql, documentsUpdates } = makeSqlStub({ doc: { document_type_id: 'outro-tipo', index_values: {} } });

    await suggestIndexesStep(
      { tenantId: TENANT_ID, documentId: DOCUMENT_ID, typeSuggestion: makeTypeSuggestion(), minConfidence: 0.5 },
      { sql, llmProvider: {} as never, logger: makeSilentLogger() },
    );

    expect(documentsUpdates.find((u) => u.query.includes('index_values = ?'))).toBeUndefined();
  });

  it('NÃO aplica quando o documento ainda não tem tipo confirmado', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({ indexSuggestionEnabled: true, indexAutoApplyEnabled: true });
    suggestIndexValuesMock.mockResolvedValue(coreResult());
    const { sql, documentsUpdates } = makeSqlStub({ doc: { document_type_id: null, index_values: {} } });

    await suggestIndexesStep(
      { tenantId: TENANT_ID, documentId: DOCUMENT_ID, typeSuggestion: makeTypeSuggestion(), minConfidence: 0.5 },
      { sql, llmProvider: {} as never, logger: makeSilentLogger() },
    );

    expect(documentsUpdates.find((u) => u.query.includes('index_values = ?'))).toBeUndefined();
  });

  it('NÃO aplica quando aiIndexAutoApplyEnabled está desligada', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({ indexSuggestionEnabled: true, indexAutoApplyEnabled: false });
    suggestIndexValuesMock.mockResolvedValue(coreResult());
    const { sql, documentsUpdates } = makeSqlStub({ doc: { document_type_id: SUGGESTED_TYPE_ID, index_values: {} } });

    await suggestIndexesStep(
      { tenantId: TENANT_ID, documentId: DOCUMENT_ID, typeSuggestion: makeTypeSuggestion(), minConfidence: 0.5 },
      { sql, llmProvider: {} as never, logger: makeSilentLogger() },
    );

    expect(documentsUpdates.find((u) => u.query.includes('index_values = ?'))).toBeUndefined();
  });
});
