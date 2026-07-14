import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import type { Logger } from 'pino';
import type { LLMProvider } from '@dmdoc/llm-provider';

/**
 * Testes da etapa de classificação automática de tipo (Fase 8) do pipeline do
 * worker. Focam nas três decisões da etapa:
 *
 * 1. Ambas as features de IA desligadas ⇒ etapa PULADA: não resolve catálogo,
 *    não chama o LLM, não persiste (typeSuggestion null, custo 0).
 * 2. Feature(s) ligada(s) ⇒ chama o service e devolve um TypeSuggestion com
 *    o custo propagado (mesmo quando o resultado é "nenhum tipo").
 * 3. Erro em qualquer passo ⇒ best-effort: loga warn e devolve sem sugestão,
 *    NUNCA relança (não pode derrubar o pipeline).
 *
 * As dependências pesadas (helpers de banco e service de LLM) são mockadas —
 * o alvo aqui é a orquestração/decisão da etapa, não a query nem o prompt.
 */

const {
  resolveAiFeatureFlagsMock,
  resolveDepartmentDocumentTypeCatalogMock,
  classifyDocumentTypeMock,
} = vi.hoisted(() => ({
  resolveAiFeatureFlagsMock: vi.fn(),
  resolveDepartmentDocumentTypeCatalogMock: vi.fn(),
  classifyDocumentTypeMock: vi.fn(),
}));

vi.mock('@dmdoc/db-pg', () => ({
  resolveAiFeatureFlags: resolveAiFeatureFlagsMock,
  resolveDepartmentDocumentTypeCatalog: resolveDepartmentDocumentTypeCatalogMock,
}));

vi.mock('@dmdoc/llm-provider', () => ({
  classifyDocumentType: classifyDocumentTypeMock,
}));

// Import DEPOIS dos mocks (vi.mock é hoisted, mas mantém a ordem explícita).
const { classifyDocument } = await import('../classify.js');

const TENANT_ID = '00000000-0000-0000-0000-00000000000a';
const DOCUMENT_ID = '00000000-0000-0000-0000-000000000001';
const DEPARTMENT_ID = '00000000-0000-0000-0000-0000000000d1';

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

// A etapa nunca chama o provider diretamente (só via service, que é mockado).
const llmProvider = {} as unknown as LLMProvider;
const sql = {} as unknown as Sql;
const chatModel = 'gpt-4o-mini';

function makeParams() {
  return {
    tenantId: TENANT_ID,
    documentId: DOCUMENT_ID,
    departmentId: DEPARTMENT_ID,
    fullText: 'Contrato de prestação de serviços entre as partes...',
  };
}

function makeDeps() {
  return { sql, llmProvider, chatModel, logger: makeSilentLogger() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('classifyDocument — decisão da etapa de classificação (Fase 8)', () => {
  it('pula a etapa inteira quando ambas as features de IA estão desligadas', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({
      classificationEnabled: false,
      titleSuggestionEnabled: false,
      indexSuggestionEnabled: false,
    });

    const outcome = await classifyDocument(makeParams(), makeDeps());

    expect(outcome).toEqual({
      typeSuggestion: null,
      suggestedTitle: null,
      classificationUsd: 0,
    });
    // Não resolve catálogo nem chama o LLM quando pulada.
    expect(resolveDepartmentDocumentTypeCatalogMock).not.toHaveBeenCalled();
    expect(classifyDocumentTypeMock).not.toHaveBeenCalled();
  });

  it('classifica e devolve TypeSuggestion com custo quando a feature está ligada', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({
      classificationEnabled: true,
      titleSuggestionEnabled: false,
      indexSuggestionEnabled: false,
    });
    resolveDepartmentDocumentTypeCatalogMock.mockResolvedValue([
      { id: 'type-1', name: 'Contrato', description: null },
    ]);
    classifyDocumentTypeMock.mockResolvedValue({
      documentTypeId: 'type-1',
      documentTypeName: 'Contrato',
      confidence: 0.92,
      suggestedTitle: null,
      model: 'gpt-4o-mini',
      promptVersion: 'classify-document-type-v1',
      usage: { promptTokens: 500, completionTokens: 20, totalTokens: 520, costUsd: 0.001 },
      rawResponse: { documentTypeName: 'Contrato', confidence: 0.92 },
    });

    const outcome = await classifyDocument(makeParams(), makeDeps());

    expect(outcome.classificationUsd).toBe(0.001);
    expect(outcome.typeSuggestion).not.toBeNull();
    expect(outcome.typeSuggestion?.documentTypeId).toBe('type-1');
    expect(outcome.typeSuggestion?.confidence).toBe(0.92);
    expect(outcome.typeSuggestion?.model).toBe('gpt-4o-mini');
    expect(outcome.typeSuggestion?.promptVersion).toBe('classify-document-type-v1');
    expect(outcome.typeSuggestion?.suggestedAt).toBeInstanceOf(Date);
    // O catálogo é escopado ao departamento do documento.
    expect(resolveDepartmentDocumentTypeCatalogMock).toHaveBeenCalledWith(
      sql,
      TENANT_ID,
      DEPARTMENT_ID
    );
  });

  it('propaga o suggestedTitle do service para o outcome (Fase 8.1)', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({
      classificationEnabled: true,
      titleSuggestionEnabled: true,
      indexSuggestionEnabled: false,
    });
    resolveDepartmentDocumentTypeCatalogMock.mockResolvedValue([
      { id: 'type-1', name: 'Contrato', description: null },
    ]);
    // O service já aplica a máscara de flags — aqui devolve um título.
    classifyDocumentTypeMock.mockResolvedValue({
      documentTypeId: 'type-1',
      documentTypeName: 'Contrato',
      confidence: 0.9,
      suggestedTitle: 'Contrato de Prestação de Serviços — Empresa X',
      model: 'gpt-4o-mini',
      promptVersion: 'classify-document-type-v1',
      usage: { promptTokens: 500, completionTokens: 20, totalTokens: 520, costUsd: 0.001 },
      rawResponse: {},
    });

    const outcome = await classifyDocument(makeParams(), makeDeps());

    // O outcome carrega o título sugerido tal como o service o devolveu.
    expect(outcome.suggestedTitle).toBe('Contrato de Prestação de Serviços — Empresa X');
    // Tipo e título viajam juntos no mesmo outcome.
    expect(outcome.typeSuggestion?.documentTypeId).toBe('type-1');
  });

  it('propaga suggestedTitle null quando a feature de título está desligada', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({
      classificationEnabled: true,
      titleSuggestionEnabled: false,
      indexSuggestionEnabled: false,
    });
    resolveDepartmentDocumentTypeCatalogMock.mockResolvedValue([
      { id: 'type-1', name: 'Contrato', description: null },
    ]);
    // Com titleSuggestionEnabled=false o service já mascara o título para null.
    classifyDocumentTypeMock.mockResolvedValue({
      documentTypeId: 'type-1',
      documentTypeName: 'Contrato',
      confidence: 0.9,
      suggestedTitle: null,
      model: 'gpt-4o-mini',
      promptVersion: 'classify-document-type-v1',
      usage: { promptTokens: 500, completionTokens: 20, totalTokens: 520, costUsd: 0.001 },
      rawResponse: {},
    });

    const outcome = await classifyDocument(makeParams(), makeDeps());

    expect(outcome.suggestedTitle).toBeNull();
    // Tipo continua sugerido — só o título foi mascarado.
    expect(outcome.typeSuggestion?.documentTypeId).toBe('type-1');
  });

  it('persiste "nenhum tipo" (id null, confiança baixa) quando o LLM não identifica tipo', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({
      classificationEnabled: true,
      titleSuggestionEnabled: true,
      indexSuggestionEnabled: false,
    });
    resolveDepartmentDocumentTypeCatalogMock.mockResolvedValue([
      { id: 'type-1', name: 'Contrato', description: null },
    ]);
    classifyDocumentTypeMock.mockResolvedValue({
      documentTypeId: null,
      documentTypeName: null,
      confidence: 0,
      suggestedTitle: null,
      model: 'gpt-4o-mini',
      promptVersion: 'classify-document-type-v1',
      usage: { promptTokens: 480, completionTokens: 8, totalTokens: 488, costUsd: 0.0008 },
      rawResponse: { documentTypeName: null, confidence: 0 },
    });

    const outcome = await classifyDocument(makeParams(), makeDeps());

    // Rodou e não achou tipo ⇒ ainda persiste a sugestão (Cenário 2), não null.
    expect(outcome.typeSuggestion).not.toBeNull();
    expect(outcome.typeSuggestion?.documentTypeId).toBeNull();
    expect(outcome.typeSuggestion?.confidence).toBe(0);
    expect(outcome.suggestedTitle).toBeNull();
    expect(outcome.classificationUsd).toBe(0.0008);
  });

  it('usa o modelo configurado como fallback quando o service não reporta model', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({
      classificationEnabled: true,
      titleSuggestionEnabled: false,
      indexSuggestionEnabled: false,
    });
    // Catálogo vazio: o service não chama o LLM e retorna model ''.
    resolveDepartmentDocumentTypeCatalogMock.mockResolvedValue([]);
    classifyDocumentTypeMock.mockResolvedValue({
      documentTypeId: null,
      documentTypeName: null,
      confidence: 0,
      suggestedTitle: null,
      model: '',
      promptVersion: 'classify-document-type-v1',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 },
      rawResponse: {},
    });

    const outcome = await classifyDocument(makeParams(), makeDeps());

    expect(outcome.typeSuggestion?.model).toBe(chatModel);
    expect(outcome.classificationUsd).toBe(0);
  });

  it('é best-effort: erro no service não relança e devolve sem sugestão', async () => {
    resolveAiFeatureFlagsMock.mockResolvedValue({
      classificationEnabled: true,
      titleSuggestionEnabled: false,
      indexSuggestionEnabled: false,
    });
    resolveDepartmentDocumentTypeCatalogMock.mockResolvedValue([
      { id: 'type-1', name: 'Contrato', description: null },
    ]);
    classifyDocumentTypeMock.mockRejectedValue(new Error('falha inesperada'));

    const outcome = await classifyDocument(makeParams(), makeDeps());

    expect(outcome).toEqual({
      typeSuggestion: null,
      suggestedTitle: null,
      classificationUsd: 0,
    });
  });

  it('é best-effort: erro ao resolver flags não relança e devolve sem sugestão', async () => {
    resolveAiFeatureFlagsMock.mockRejectedValue(new Error('tenant não encontrado'));

    const outcome = await classifyDocument(makeParams(), makeDeps());

    expect(outcome).toEqual({
      typeSuggestion: null,
      suggestedTitle: null,
      classificationUsd: 0,
    });
    expect(classifyDocumentTypeMock).not.toHaveBeenCalled();
  });
});
