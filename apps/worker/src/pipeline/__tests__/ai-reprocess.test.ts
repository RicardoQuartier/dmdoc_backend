import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import type { Logger } from 'pino';

/**
 * Testes do orquestrador de reprocessamento de IA em massa por documento
 * (épico E-4 / T-24): `runAiReprocessDocument`. Foco na DECISÃO de rodar cada
 * etapa (gating por `steps` pedidos AND feature flags do tenant), na
 * pré-condição (documento sem texto ⇒ erro tipado → o processor conta `failed`)
 * e no invariante best-effort (falha de uma etapa não derruba as outras).
 *
 * Os núcleos pesados (classificação, sugestão de índices, geração de tags e o
 * helper de flags) são mockados — o alvo é a orquestração, não o prompt/query.
 */

const { resolveAiFeatureFlagsMock, classifyDocumentMock, generateTagsStepMock, suggestIndexValuesMock } =
  vi.hoisted(() => ({
    resolveAiFeatureFlagsMock: vi.fn(),
    classifyDocumentMock: vi.fn(),
    generateTagsStepMock: vi.fn(),
    suggestIndexValuesMock: vi.fn(),
  }));

vi.mock('@dmdoc/db-pg', () => ({
  resolveAiFeatureFlags: resolveAiFeatureFlagsMock,
}));

vi.mock('@dmdoc/llm-provider', () => ({
  suggestIndexValues: suggestIndexValuesMock,
  SUGGEST_INDEXES_PROMPT: { version: 'suggest-indexes-v1' },
}));

vi.mock('../classify.js', () => ({
  classifyDocument: classifyDocumentMock,
}));

vi.mock('../generate-tags.js', () => ({
  generateTagsStep: generateTagsStepMock,
}));

const { runAiReprocessDocument, AiReprocessPreconditionError } = await import('../ai-reprocess.js');

const TENANT_ID = '00000000-0000-0000-0000-00000000000a';
const DOCUMENT_ID = '00000000-0000-0000-0000-000000000001';
const TYPE_ID = '00000000-0000-0000-0000-0000000000ff';

const ALL_ON = {
  classificationEnabled: true,
  titleSuggestionEnabled: true,
  indexSuggestionEnabled: true,
  tagGenerationEnabled: true,
};

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
  doc?: { department_id: string; document_type_id: string | null; status: string } | null;
  fullText?: string | null;
}

/**
 * Stub de `Sql`: responde às SELECTs de pré-condição/custo e contabiliza os
 * UPDATEs por tabela para verificar o que foi persistido.
 */
function makeSqlStub(opts: SqlStubOptions = {}): { sql: Sql; updates: string[] } {
  const doc = opts.doc === undefined ? { department_id: 'dep', document_type_id: TYPE_ID, status: 'READY' } : opts.doc;
  const fullText = opts.fullText === undefined ? 'texto extraído do documento' : opts.fullText;
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

      if (query.includes('from documents') && query.includes('select')) {
        return Promise.resolve(doc === null ? [] : [doc]);
      }
      if (query.includes('full_text') && query.includes('from document_content')) {
        return Promise.resolve(fullText === null && doc !== null ? [{ full_text: null }] : fullText === null ? [] : [{ full_text: fullText }]);
      }
      if (query.includes('cost_breakdown') && query.includes('from document_content')) {
        return Promise.resolve([{ cost_breakdown: null }]);
      }
      if (query.includes('from document_type_index_fields')) {
        return Promise.resolve([]);
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

function makeDeps(sql: Sql) {
  return { sql, llmProvider: {} as never, chatModel: 'gpt-4o-mini', logger: makeSilentLogger() };
}

function classifyOk() {
  return {
    typeSuggestion: {
      documentTypeId: TYPE_ID,
      documentTypeName: 'Contrato',
      confidence: 0.9,
      model: 'gpt-4o-mini',
      promptVersion: 'classify-document-type-v3',
      suggestedAt: new Date(),
      rawResponse: {},
    },
    suggestedTitle: 'Contrato de Locação',
    classificationUsd: 0.0003,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveAiFeatureFlagsMock.mockResolvedValue(ALL_ON);
  classifyDocumentMock.mockResolvedValue(classifyOk());
  generateTagsStepMock.mockResolvedValue(undefined);
  suggestIndexValuesMock.mockResolvedValue({
    values: { vencimento: '2026-12-31' },
    model: 'gpt-4o-mini',
    promptVersion: 'suggest-indexes-v1',
    rawResponse: {},
    fields: [],
    costUsd: 0.0002,
  });
});

describe('runAiReprocessDocument — gating por steps + flags', () => {
  it('roda só as etapas pedidas (title) e não as demais', async () => {
    const { sql } = makeSqlStub();
    const out = await runAiReprocessDocument({ tenantId: TENANT_ID, documentId: DOCUMENT_ID, steps: ['title'] }, makeDeps(sql));

    expect(classifyDocumentMock).toHaveBeenCalledTimes(1);
    expect(suggestIndexValuesMock).not.toHaveBeenCalled();
    expect(generateTagsStepMock).not.toHaveBeenCalled();
    expect(out.stepsRun).toEqual(['title']);
  });

  it('roda as três etapas quando pedidas e todas ligadas', async () => {
    const { sql } = makeSqlStub();
    const out = await runAiReprocessDocument(
      { tenantId: TENANT_ID, documentId: DOCUMENT_ID, steps: ['title', 'indexes', 'tags'] },
      makeDeps(sql),
    );
    expect(classifyDocumentMock).toHaveBeenCalledTimes(1);
    expect(suggestIndexValuesMock).toHaveBeenCalledTimes(1);
    expect(generateTagsStepMock).toHaveBeenCalledTimes(1);
    expect(out.stepsRun).toEqual(['title', 'indexes', 'tags']);
  });

  it('pula etapa desligada para a empresa (indexes off) sem rodar o núcleo', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({ ...ALL_ON, indexSuggestionEnabled: false });
    const { sql } = makeSqlStub();
    const out = await runAiReprocessDocument(
      { tenantId: TENANT_ID, documentId: DOCUMENT_ID, steps: ['indexes', 'tags'] },
      makeDeps(sql),
    );
    expect(suggestIndexValuesMock).not.toHaveBeenCalled();
    expect(generateTagsStepMock).toHaveBeenCalledTimes(1);
    expect(out.stepsSkipped).toContain('indexes');
    expect(out.stepsRun).toEqual(['tags']);
  });

  it('pula indexes quando o documento não tem tipo CONFIRMADO', async () => {
    const { sql } = makeSqlStub({ doc: { department_id: 'dep', document_type_id: null, status: 'READY' } });
    const out = await runAiReprocessDocument(
      { tenantId: TENANT_ID, documentId: DOCUMENT_ID, steps: ['indexes'] },
      makeDeps(sql),
    );
    expect(suggestIndexValuesMock).not.toHaveBeenCalled();
    expect(out.stepsSkipped).toContain('indexes');
    expect(out.stepsRun).toEqual([]);
  });

  it('pula title quando classificação E título estão desligados', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({ ...ALL_ON, classificationEnabled: false, titleSuggestionEnabled: false });
    const { sql } = makeSqlStub();
    const out = await runAiReprocessDocument({ tenantId: TENANT_ID, documentId: DOCUMENT_ID, steps: ['title'] }, makeDeps(sql));
    expect(classifyDocumentMock).not.toHaveBeenCalled();
    expect(out.stepsSkipped).toContain('title');
  });
});

describe('runAiReprocessDocument — pré-condição (→ failed no lote)', () => {
  it('lança AiReprocessPreconditionError quando o documento não existe', async () => {
    const { sql } = makeSqlStub({ doc: null });
    await expect(
      runAiReprocessDocument({ tenantId: TENANT_ID, documentId: DOCUMENT_ID, steps: ['title'] }, makeDeps(sql)),
    ).rejects.toBeInstanceOf(AiReprocessPreconditionError);
  });

  it('lança AiReprocessPreconditionError quando não há texto extraído', async () => {
    const { sql } = makeSqlStub({ fullText: null });
    await expect(
      runAiReprocessDocument({ tenantId: TENANT_ID, documentId: DOCUMENT_ID, steps: ['title'] }, makeDeps(sql)),
    ).rejects.toBeInstanceOf(AiReprocessPreconditionError);
  });
});

describe('runAiReprocessDocument — best-effort por etapa', () => {
  it('falha do núcleo de índices NÃO derruba as outras etapas nem o documento', async () => {
    suggestIndexValuesMock.mockRejectedValue(new Error('LLM fora do ar'));
    const { sql } = makeSqlStub();
    const out = await runAiReprocessDocument(
      { tenantId: TENANT_ID, documentId: DOCUMENT_ID, steps: ['indexes', 'tags'] },
      makeDeps(sql),
    );
    // Índices falhou best-effort (ainda conta como "run"), tags rodou normalmente.
    expect(generateTagsStepMock).toHaveBeenCalledTimes(1);
    expect(out.stepsRun).toEqual(['indexes', 'tags']);
  });
});
