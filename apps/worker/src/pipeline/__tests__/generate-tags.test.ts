import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import type { Logger } from 'pino';

/**
 * Testes do GATILHO de geração de tags (Fase 9 / E-3): a etapa
 * `generateTagsStep` do pipeline do worker. Foco na DECISÃO de disparar (gate
 * pela flag `tagGenerationEnabled`), no invariante best-effort (falha de IA
 * nunca derruba o pipeline) e em nunca tocar `documents.tags`.
 *
 * As dependências pesadas (helper de flags e o núcleo de IA) são mockadas — o
 * alvo é a orquestração/decisão da etapa, não o prompt nem a query.
 */

const { resolveAiFeatureFlagsMock, generateTagsMock } = vi.hoisted(() => ({
  resolveAiFeatureFlagsMock: vi.fn(),
  generateTagsMock: vi.fn(),
}));

vi.mock('@dmdoc/db-pg', () => ({
  resolveAiFeatureFlags: resolveAiFeatureFlagsMock,
}));

vi.mock('@dmdoc/llm-provider', () => ({
  generateTags: generateTagsMock,
}));

const { generateTagsStep } = await import('../generate-tags.js');

const TENANT_ID = '00000000-0000-0000-0000-00000000000a';
const DOCUMENT_ID = '00000000-0000-0000-0000-000000000001';

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
 * Stub de `Sql`: devolve o conteúdo do documento; UPDATEs são no-op mas
 * contabilizados para verificar o que foi persistido.
 */
function makeSqlStub(
  content: { full_text: string; cost_breakdown: unknown } | null = {
    full_text: 'contrato de locação e boleto anexo',
    cost_breakdown: null,
  },
  currentDocumentTags: string[] = []
): { sql: Sql; updates: string[]; documentsTagsUpdates: string[][] } {
  const updates: string[] = [];
  const documentsTagsUpdates: string[][] = [];
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
        return Promise.resolve(content === null ? [] : [content]);
      }
      if (query.includes('select tags from documents')) {
        return Promise.resolve([{ tags: currentDocumentTags }]);
      }
      if (query.includes('update document_content')) {
        updates.push('document_content');
        return Promise.resolve(noop);
      }
      if (query.includes('update documents set tags')) {
        updates.push('documents');
        documentsTagsUpdates.push(values[0] as string[]);
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

  return { sql: sqlFn as unknown as Sql, updates, documentsTagsUpdates };
}

function coreResult(overrides: Record<string, unknown> = {}) {
  return {
    tags: ['Contrato', 'Boleto', 'ACME Ltda'],
    model: 'gpt-4o-mini',
    promptVersion: 'generate-tags-v1',
    rawResponse: { tags: ['Contrato', 'Boleto', 'ACME Ltda'] },
    costUsd: 0.0002,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateTagsStep — decisão do gatilho e best-effort (Fase 9 / E-3)', () => {
  it('dispara quando a feature está ligada e persiste suggested_tags + custo', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({
      classificationEnabled: true,
      titleSuggestionEnabled: true,
      indexSuggestionEnabled: true,
      tagGenerationEnabled: true,
    });
    generateTagsMock.mockResolvedValue(coreResult());
    const { sql, updates } = makeSqlStub();

    await generateTagsStep(
      { tenantId: TENANT_ID, documentId: DOCUMENT_ID },
      { sql, llmProvider: {} as never, logger: makeSilentLogger() }
    );

    expect(generateTagsMock).toHaveBeenCalledTimes(1);
    // Persiste a sugestão consultiva e incrementa o custo do documento.
    expect(updates).toContain('document_content');
    expect(updates).toContain('documents');
  });

  it('NÃO dispara quando a feature está desligada para a empresa', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({
      classificationEnabled: true,
      titleSuggestionEnabled: true,
      indexSuggestionEnabled: true,
      tagGenerationEnabled: false,
    });
    const { sql, updates } = makeSqlStub();

    await generateTagsStep(
      { tenantId: TENANT_ID, documentId: DOCUMENT_ID },
      { sql, llmProvider: {} as never, logger: makeSilentLogger() }
    );

    expect(generateTagsMock).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it('não persiste quando o núcleo não chamou o LLM (texto vazio, model === "")', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({
      classificationEnabled: true,
      titleSuggestionEnabled: true,
      indexSuggestionEnabled: true,
      tagGenerationEnabled: true,
    });
    generateTagsMock.mockResolvedValue(coreResult({ tags: [], model: '', costUsd: 0 }));
    const { sql, updates } = makeSqlStub();

    await generateTagsStep(
      { tenantId: TENANT_ID, documentId: DOCUMENT_ID },
      { sql, llmProvider: {} as never, logger: makeSilentLogger() }
    );

    expect(generateTagsMock).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([]);
  });

  it('é best-effort: erro do núcleo (LLM) não relança e não derruba o pipeline', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({
      classificationEnabled: true,
      titleSuggestionEnabled: true,
      indexSuggestionEnabled: true,
      tagGenerationEnabled: true,
    });
    generateTagsMock.mockRejectedValue(new Error('provedor de LLM fora do ar'));
    const { sql } = makeSqlStub();

    await expect(
      generateTagsStep(
        { tenantId: TENANT_ID, documentId: DOCUMENT_ID },
        { sql, llmProvider: {} as never, logger: makeSilentLogger() }
      )
    ).resolves.toBeUndefined();
  });

  it('é best-effort: erro ao resolver flags não relança', async () => {
    resolveAiFeatureFlagsMock.mockRejectedValue(new Error('tenant não encontrado'));
    const { sql } = makeSqlStub();

    await expect(
      generateTagsStep(
        { tenantId: TENANT_ID, documentId: DOCUMENT_ID },
        { sql, llmProvider: {} as never, logger: makeSilentLogger() }
      )
    ).resolves.toBeUndefined();
    expect(generateTagsMock).not.toHaveBeenCalled();
  });
});

describe('generateTagsStep — aplicação automática (5ª feature de IA, aiTagAutoApplyEnabled)', () => {
  it('com a flag ligada, mescla as tags sugeridas em documents.tags (dedupe case-insensitive)', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({
      classificationEnabled: true,
      titleSuggestionEnabled: true,
      indexSuggestionEnabled: true,
      tagGenerationEnabled: true,
      tagAutoApplyEnabled: true,
    });
    generateTagsMock.mockResolvedValue(coreResult({ tags: ['Contrato', 'boleto', 'Nova Tag'] }));
    const { sql, documentsTagsUpdates } = makeSqlStub(undefined, ['Boleto', 'Manual']);

    await generateTagsStep(
      { tenantId: TENANT_ID, documentId: DOCUMENT_ID },
      { sql, llmProvider: {} as never, logger: makeSilentLogger() }
    );

    expect(documentsTagsUpdates).toHaveLength(1);
    // "boleto" já existe como "Boleto" (dedupe case-insensitive) — não duplica.
    // "Manual" (já confirmada) nunca é removida.
    expect(documentsTagsUpdates[0]).toEqual(['Boleto', 'Manual', 'Contrato', 'Nova Tag']);
  });

  it('com a flag desligada, NÃO toca documents.tags — permanece consultivo', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({
      classificationEnabled: true,
      titleSuggestionEnabled: true,
      indexSuggestionEnabled: true,
      tagGenerationEnabled: true,
      tagAutoApplyEnabled: false,
    });
    generateTagsMock.mockResolvedValue(coreResult());
    const { documentsTagsUpdates, sql } = makeSqlStub(undefined, ['Manual']);

    await generateTagsStep(
      { tenantId: TENANT_ID, documentId: DOCUMENT_ID },
      { sql, llmProvider: {} as never, logger: makeSilentLogger() }
    );

    expect(documentsTagsUpdates).toHaveLength(0);
  });

  it('quando todas as tags sugeridas já estão confirmadas, não faz UPDATE desnecessário', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({
      classificationEnabled: true,
      titleSuggestionEnabled: true,
      indexSuggestionEnabled: true,
      tagGenerationEnabled: true,
      tagAutoApplyEnabled: true,
    });
    generateTagsMock.mockResolvedValue(coreResult({ tags: ['Contrato', 'Boleto', 'ACME Ltda'] }));
    const { documentsTagsUpdates, sql } = makeSqlStub(undefined, ['Contrato', 'Boleto', 'ACME Ltda']);

    await generateTagsStep(
      { tenantId: TENANT_ID, documentId: DOCUMENT_ID },
      { sql, llmProvider: {} as never, logger: makeSilentLogger() }
    );

    expect(documentsTagsUpdates).toHaveLength(0);
  });
});
