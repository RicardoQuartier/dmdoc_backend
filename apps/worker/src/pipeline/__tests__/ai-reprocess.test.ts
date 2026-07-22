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
  // Implementação real (não mockada) — é lógica pura, vale testar de verdade
  // o comportamento de merge/coerção através da orquestração.
  coerceIndexValueForField: (fieldType: string, raw: string) => {
    if (fieldType === 'NUMBER') {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    return raw;
  },
  mergeSuggestedIndexValues: (
    currentIndexValues: Record<string, string | number | null>,
    suggestedValues: Record<string, string>,
    indexFields: Array<{ name: string; field_type: string }>,
  ) => {
    const fieldTypeByName = new Map(indexFields.map((f) => [f.name, f.field_type]));
    const merged: Record<string, string | number | null> = { ...currentIndexValues };
    let appliedCount = 0;
    for (const [fieldName, rawValue] of Object.entries(suggestedValues)) {
      const existing = merged[fieldName];
      const isEmpty = existing === undefined || existing === null || existing === '';
      if (!isEmpty || rawValue === '') continue;
      const fieldType = fieldTypeByName.get(fieldName);
      merged[fieldName] =
        fieldType === 'NUMBER' ? (Number.isFinite(Number(rawValue)) ? Number(rawValue) : rawValue) : rawValue;
      appliedCount += 1;
    }
    return { merged, appliedCount };
  },
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
  tagAutoApplyEnabled: true,
  classificationAutoApplyEnabled: true,
  titleAutoApplyEnabled: true,
  indexAutoApplyEnabled: true,
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
  doc?:
    | {
        department_id: string;
        document_type_id: string | null;
        status: string;
        title?: string | null;
        index_values?: Record<string, string | number | null>;
      }
    | null;
  fullText?: string | null;
  indexFields?: Array<{ id: string; name: string; field_type: 'TEXT' | 'DATE' | 'NUMBER' }>;
}

/**
 * Stub de `Sql`: responde às SELECTs de pré-condição/custo e contabiliza os
 * UPDATEs por tabela para verificar o que foi persistido. `documentsUpdates`
 * guarda os valores interpolados de cada `UPDATE documents` (na ordem dos
 * placeholders) para inspecionar auto-aplicação (`document_type_id`, `title`,
 * `index_values`).
 */
function makeSqlStub(
  opts: SqlStubOptions = {},
): { sql: Sql; updates: string[]; documentsUpdates: Array<{ query: string; values: unknown[] }> } {
  // `let` (não `const`): mutado quando um UPDATE de auto-aplicação toca
  // `document_type_id`/`title`/`index_values`, para simular um banco real —
  // necessário para testar o encadeamento title→indexes num mesmo lote
  // (ver teste "reconsulta o tipo fresco").
  let doc =
    opts.doc === undefined
      ? { department_id: 'dep', document_type_id: TYPE_ID, status: 'READY', title: null, index_values: {} }
      : opts.doc === null
        ? null
        : { title: null, index_values: {}, ...opts.doc };
  const fullText = opts.fullText === undefined ? 'texto extraído do documento' : opts.fullText;
  const indexFields = opts.indexFields ?? [];
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

  // Junta só os pedaços literais do template (sem interpolar valores) — usado
  // para checar QUAIS colunas um UPDATE toca, independente do valor passado.
  function buildStructuralQuery(strings: TemplateStringsArray): string {
    return strings.join('?').toLowerCase();
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
        return Promise.resolve(indexFields.map((f, i) => ({ ...f, required: false, ai_extraction_hint: null, sort_order: i, show_on_search: false, deleted: false })));
      }
      if (query.includes('update document_content')) {
        updates.push('document_content');
        return Promise.resolve(noop);
      }
      if (query.includes('update documents')) {
        updates.push('documents');
        const structuralQuery = buildStructuralQuery(strings as TemplateStringsArray);
        documentsUpdates.push({ query: structuralQuery, values });
        // Simula persistência real: reflete a auto-aplicação no `doc` em
        // memória, para que uma SELECT subsequente (ex.: o gate de `indexes`
        // reconsultando o tipo após a etapa `title` auto-aplicar) veja o
        // estado atualizado, não o snapshot inicial.
        if (doc !== null) {
          if (structuralQuery.includes('set document_type_id = ?')) {
            doc = { ...doc, document_type_id: values[0] as string };
          }
          if (structuralQuery.includes('index_values = ?')) {
            doc = { ...doc, index_values: values[0] as Record<string, string | number | null> };
          }
        }
        return Promise.resolve(noop);
      }
      return Promise.resolve(noop);
    }
  );
  (sqlFn as unknown as Record<string, unknown>)['json'] = (val: unknown) => val;

  return { sql: sqlFn as unknown as Sql, updates, documentsUpdates };
}

function makeDeps(sql: Sql, overrides: { typeAutoApplyMinConfidence?: number } = {}) {
  return {
    sql,
    llmProvider: {} as never,
    chatModel: 'gpt-4o-mini',
    logger: makeSilentLogger(),
    typeAutoApplyMinConfidence: overrides.typeAutoApplyMinConfidence ?? 0.5,
  };
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

describe('runAiReprocessDocument — auto-aplicação de tipo/título (gate por flag)', () => {
  it('auto-aplica document_type_id quando classificationAutoApplyEnabled está ligada', async () => {
    const { sql, documentsUpdates } = makeSqlStub();
    await runAiReprocessDocument({ tenantId: TENANT_ID, documentId: DOCUMENT_ID, steps: ['title'] }, makeDeps(sql));

    const typeUpdate = documentsUpdates.find((u) => u.query.includes('document_type_id = ?'));
    expect(typeUpdate).toBeDefined();
    expect(typeUpdate!.values[0]).toBe(TYPE_ID);
  });

  it('NÃO auto-aplica document_type_id quando classificationAutoApplyEnabled está desligada', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({ ...ALL_ON, classificationAutoApplyEnabled: false });
    const { sql, documentsUpdates } = makeSqlStub();
    await runAiReprocessDocument({ tenantId: TENANT_ID, documentId: DOCUMENT_ID, steps: ['title'] }, makeDeps(sql));

    expect(documentsUpdates.find((u) => u.query.includes('document_type_id = ?'))).toBeUndefined();
  });

  it('NÃO auto-aplica document_type_id quando a confiança está abaixo do limiar', async () => {
    classifyDocumentMock.mockResolvedValue({ ...classifyOk(), typeSuggestion: { ...classifyOk().typeSuggestion, confidence: 0.2 } });
    const { sql, documentsUpdates } = makeSqlStub();
    await runAiReprocessDocument(
      { tenantId: TENANT_ID, documentId: DOCUMENT_ID, steps: ['title'] },
      makeDeps(sql, { typeAutoApplyMinConfidence: 0.5 }),
    );

    expect(documentsUpdates.find((u) => u.query.includes('document_type_id = ?'))).toBeUndefined();
  });

  it('auto-aplica title (via COALESCE) quando titleAutoApplyEnabled está ligada', async () => {
    const { sql, documentsUpdates } = makeSqlStub();
    await runAiReprocessDocument({ tenantId: TENANT_ID, documentId: DOCUMENT_ID, steps: ['title'] }, makeDeps(sql));

    const titleUpdate = documentsUpdates.find((u) => u.query.includes('coalesce(title'));
    expect(titleUpdate).toBeDefined();
    // suggested_title, cost_usd_cents(+delta), title-a-aplicar, id, tenant_id
    expect(titleUpdate!.values[2]).toBe('Contrato de Locação');
  });

  it('NÃO auto-aplica title quando titleAutoApplyEnabled está desligada (mas suggested_title continua sendo gravado)', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({ ...ALL_ON, titleAutoApplyEnabled: false });
    const { sql, documentsUpdates } = makeSqlStub();
    await runAiReprocessDocument({ tenantId: TENANT_ID, documentId: DOCUMENT_ID, steps: ['title'] }, makeDeps(sql));

    const titleUpdate = documentsUpdates.find((u) => u.query.includes('coalesce(title'));
    expect(titleUpdate).toBeDefined();
    expect(titleUpdate!.values[2]).toBeNull();
    expect(titleUpdate!.values[0]).toBe('Contrato de Locação'); // suggested_title sempre gravado
  });
});

describe('runAiReprocessDocument — auto-aplicação de índices (gate por flag)', () => {
  const INDEX_FIELDS = [{ id: 'f1', name: 'vencimento', field_type: 'DATE' as const }];

  it('mescla os valores sugeridos em index_values quando indexAutoApplyEnabled está ligada', async () => {
    const { sql, documentsUpdates } = makeSqlStub({ indexFields: INDEX_FIELDS });
    await runAiReprocessDocument({ tenantId: TENANT_ID, documentId: DOCUMENT_ID, steps: ['indexes'] }, makeDeps(sql));

    const indexUpdate = documentsUpdates.find((u) => u.query.includes('index_values = ?'));
    expect(indexUpdate).toBeDefined();
    expect(indexUpdate!.values[0]).toEqual({ vencimento: '2026-12-31' });
  });

  it('NÃO mescla índices quando indexAutoApplyEnabled está desligada', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({ ...ALL_ON, indexAutoApplyEnabled: false });
    const { sql, documentsUpdates } = makeSqlStub({ indexFields: INDEX_FIELDS });
    await runAiReprocessDocument({ tenantId: TENANT_ID, documentId: DOCUMENT_ID, steps: ['indexes'] }, makeDeps(sql));

    expect(documentsUpdates.find((u) => u.query.includes('index_values = ?'))).toBeUndefined();
  });

  it('não sobrescreve um campo de índice já confirmado — só preenche o que está vazio', async () => {
    const { sql, documentsUpdates } = makeSqlStub({
      doc: { department_id: 'dep', document_type_id: TYPE_ID, status: 'READY', index_values: { vencimento: '2020-01-01' } },
      indexFields: INDEX_FIELDS,
    });
    await runAiReprocessDocument({ tenantId: TENANT_ID, documentId: DOCUMENT_ID, steps: ['indexes'] }, makeDeps(sql));

    // Já preenchido ⇒ merge não altera nada ⇒ nenhum UPDATE de index_values disparado.
    expect(documentsUpdates.find((u) => u.query.includes('index_values = ?'))).toBeUndefined();
  });

  it('reconsulta o tipo fresco: título e índices no MESMO lote aplicam índices mesmo quando o tipo era null antes e foi auto-aplicado pela etapa title', async () => {
    // Documento SEM tipo confirmado antes do lote — cenário real: upload com
    // aiClassificationAutoApplyEnabled desligada, depois ligada e reprocessado
    // em lote pedindo title+indexes juntos.
    const { sql, documentsUpdates } = makeSqlStub({
      doc: { department_id: 'dep', document_type_id: null, status: 'READY', index_values: {} },
      indexFields: INDEX_FIELDS,
    });

    const out = await runAiReprocessDocument(
      { tenantId: TENANT_ID, documentId: DOCUMENT_ID, steps: ['title', 'indexes'] },
      makeDeps(sql),
    );

    // A etapa title rodou e auto-aplicou o tipo (classifyOk() sugere TYPE_ID).
    const typeUpdate = documentsUpdates.find((u) => u.query.includes('document_type_id = ?'));
    expect(typeUpdate).toBeDefined();
    expect(typeUpdate!.values[0]).toBe(TYPE_ID);

    // A etapa indexes NÃO deveria pular por "sem tipo confirmado" — o tipo
    // recém-aplicado pela etapa title já deve valer para o gate de indexes.
    expect(out.stepsSkipped).not.toContain('indexes');
    expect(out.stepsRun).toContain('indexes');
    const indexUpdate = documentsUpdates.find((u) => u.query.includes('index_values = ?'));
    expect(indexUpdate).toBeDefined();
    expect(indexUpdate!.values[0]).toEqual({ vencimento: '2026-12-31' });
  });
});
