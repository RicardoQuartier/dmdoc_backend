import { describe, expect, it, vi } from 'vitest';
import {
  classifyDocumentType,
  type ClassifyDocumentTypeInput,
  type DocumentTypeCatalogItem,
} from './classify-document-type.js';
import type { ChatParams, ChatResult, LLMProvider, TokenUsage } from './types.js';

const USAGE: TokenUsage = {
  promptTokens: 100,
  completionTokens: 20,
  totalTokens: 120,
  costUsd: 0.0001,
};

const CATALOG: DocumentTypeCatalogItem[] = [
  { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'Contrato', description: 'Acordos e contratos' },
  { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', name: 'Nota Fiscal', description: 'Documentos fiscais' },
];

const FLAGS_ON = { classificationEnabled: true, titleSuggestionEnabled: true };

/** Logger no-op que satisfaz a interface mínima esperada pelo service. */
function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/**
 * Cria um LLMProvider mock cujo `chat` devolve, em sequência, os `contents`
 * fornecidos. `chatStream` não é usado por este service.
 */
function mockProvider(contents: string[], model = 'gpt-4o-mini'): {
  provider: LLMProvider;
  chat: ReturnType<typeof vi.fn>;
} {
  const chat = vi.fn<[ChatParams], Promise<ChatResult>>();
  for (const content of contents) {
    chat.mockResolvedValueOnce({ content, usage: USAGE, model });
  }
  const provider: LLMProvider = {
    chat,
    // eslint-disable-next-line require-yield
    chatStream: async function* () {
      throw new Error('chatStream não deve ser chamado');
    },
  };
  return { provider, chat };
}

function inputWith(
  overrides: Partial<ClassifyDocumentTypeInput> = {}
): ClassifyDocumentTypeInput {
  return {
    text: 'Texto do documento de exemplo para classificação.',
    catalog: CATALOG,
    flags: FLAGS_ON,
    ...overrides,
  };
}

describe('classifyDocumentType', () => {
  it('(a) nome exato bate → resolve id e preserva confiança/título', async () => {
    const { provider, chat } = mockProvider([
      JSON.stringify({ documentTypeName: 'Contrato', confidence: 0.92, suggestedTitle: 'Contrato de locação' }),
    ]);

    const result = await classifyDocumentType(provider, inputWith(), makeLogger());

    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.documentTypeId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(result.documentTypeName).toBe('Contrato');
    expect(result.confidence).toBe(0.92);
    expect(result.suggestedTitle).toBe('Contrato de locação');
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.promptVersion).toBe('classify-document-type-v1');
    expect(result.usage.totalTokens).toBe(120);
  });

  it('(a2) match é case-insensitive e normaliza para o nome canônico do catálogo', async () => {
    const { provider } = mockProvider([
      JSON.stringify({ documentTypeName: '  nota FISCAL ', confidence: 0.7, suggestedTitle: null }),
    ]);

    const result = await classifyDocumentType(provider, inputWith(), makeLogger());

    expect(result.documentTypeId).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    expect(result.documentTypeName).toBe('Nota Fiscal');
  });

  it('(b) nome que não existe no catálogo → documentTypeId null (nenhum tipo)', async () => {
    const { provider } = mockProvider([
      JSON.stringify({ documentTypeName: 'Boleto', confidence: 0.88, suggestedTitle: 'Boleto de cobrança' }),
    ]);

    const result = await classifyDocumentType(provider, inputWith(), makeLogger());

    expect(result.documentTypeId).toBeNull();
    expect(result.documentTypeName).toBeNull();
    expect(result.confidence).toBe(0);
    // título é independente do tipo — preservado
    expect(result.suggestedTitle).toBe('Boleto de cobrança');
  });

  it('(c) LLM retorna documentTypeName null → nenhum tipo', async () => {
    const { provider } = mockProvider([
      JSON.stringify({ documentTypeName: null, confidence: 0.05, suggestedTitle: 'Documento avulso' }),
    ]);

    const result = await classifyDocumentType(provider, inputWith(), makeLogger());

    expect(result.documentTypeId).toBeNull();
    expect(result.documentTypeName).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.suggestedTitle).toBe('Documento avulso');
  });

  it('(d) resposta inválida → 1 retry → fallback nenhum tipo, sem lançar', async () => {
    const logger = makeLogger();
    const { provider, chat } = mockProvider([
      'isto não é json',
      JSON.stringify({ documentTypeName: 'Contrato' }), // falta confidence
    ]);

    const result = await classifyDocumentType(provider, inputWith(), logger);

    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.documentTypeId).toBeNull();
    expect(result.documentTypeName).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.suggestedTitle).toBeNull();
    // custo das duas tentativas é somado
    expect(result.usage.totalTokens).toBe(240);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('(d2) provider lança em ambas as tentativas → fallback sem propagar erro', async () => {
    const chat = vi.fn<[ChatParams], Promise<ChatResult>>().mockRejectedValue(new Error('API 500'));
    const provider: LLMProvider = {
      chat,
      // eslint-disable-next-line require-yield
      chatStream: async function* () {
        throw new Error('não usado');
      },
    };

    const result = await classifyDocumentType(provider, inputWith(), makeLogger());

    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.documentTypeId).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it('(e1) classificationEnabled=false zera o tipo mas mantém o título', async () => {
    const { provider } = mockProvider([
      JSON.stringify({ documentTypeName: 'Contrato', confidence: 0.95, suggestedTitle: 'Contrato XYZ' }),
    ]);

    const result = await classifyDocumentType(
      provider,
      inputWith({ flags: { classificationEnabled: false, titleSuggestionEnabled: true } }),
      makeLogger()
    );

    expect(result.documentTypeId).toBeNull();
    expect(result.documentTypeName).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.suggestedTitle).toBe('Contrato XYZ');
  });

  it('(e2) titleSuggestionEnabled=false zera o título mas mantém o tipo', async () => {
    const { provider } = mockProvider([
      JSON.stringify({ documentTypeName: 'Contrato', confidence: 0.95, suggestedTitle: 'Contrato XYZ' }),
    ]);

    const result = await classifyDocumentType(
      provider,
      inputWith({ flags: { classificationEnabled: true, titleSuggestionEnabled: false } }),
      makeLogger()
    );

    expect(result.documentTypeId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(result.confidence).toBe(0.95);
    expect(result.suggestedTitle).toBeNull();
  });

  it('(f) catálogo vazio → não chama o LLM e retorna nenhum tipo', async () => {
    const { provider, chat } = mockProvider([]);

    const result = await classifyDocumentType(
      provider,
      inputWith({ catalog: [] }),
      makeLogger()
    );

    expect(chat).not.toHaveBeenCalled();
    expect(result.documentTypeId).toBeNull();
    expect(result.documentTypeName).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.usage.totalTokens).toBe(0);
  });

  it('tolera resposta embrulhada em cercas markdown ```json', async () => {
    const { provider } = mockProvider([
      '```json\n{"documentTypeName":"Contrato","confidence":0.8,"suggestedTitle":"T"}\n```',
    ]);

    const result = await classifyDocumentType(provider, inputWith(), makeLogger());

    expect(result.documentTypeId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(result.suggestedTitle).toBe('T');
  });

  it('fatia o texto ao orçamento (~12k chars) antes de enviar ao LLM', async () => {
    const { provider, chat } = mockProvider([
      JSON.stringify({ documentTypeName: null, confidence: 0, suggestedTitle: null }),
    ]);
    const longText = 'a'.repeat(50_000);

    await classifyDocumentType(provider, inputWith({ text: longText }), makeLogger());

    const params = chat.mock.calls[0]?.[0] as ChatParams;
    const userMessage = params.messages.find((m) => m.role === 'user')?.content ?? '';
    // 12.000 chars do texto + o cabeçalho do catálogo; nunca os 50k originais
    expect(userMessage).not.toContain('a'.repeat(12_001));
    expect(userMessage).toContain('a'.repeat(12_000));
    expect(params.temperature).toBe(0);
  });
});
