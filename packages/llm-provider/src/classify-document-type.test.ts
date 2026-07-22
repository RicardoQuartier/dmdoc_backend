import { describe, expect, it, vi } from 'vitest';
import {
  classifyDocumentType,
  CLASSIFY_DOCUMENT_TYPE_PROMPT,
  MAX_RECOGNITION_KEYWORDS_PER_TYPE,
  MAX_RECOGNITION_RULES_CHARS,
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
  it('(a) número válido → resolve o tipo certo e preserva confiança/título', async () => {
    const { provider, chat } = mockProvider([
      JSON.stringify({ documentTypeNumber: 1, confidence: 0.92, suggestedTitle: 'Contrato de locação' }),
    ]);

    const result = await classifyDocumentType(provider, inputWith(), makeLogger());

    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.documentTypeId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(result.documentTypeName).toBe('Contrato');
    expect(result.confidence).toBe(0.92);
    expect(result.suggestedTitle).toBe('Contrato de locação');
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.promptVersion).toBe('classify-document-type-v3');
    expect(result.usage.totalTokens).toBe(120);
  });

  it('(a2) número do segundo tipo → resolve pelo índice, normalizando o nome canônico', async () => {
    const { provider } = mockProvider([
      JSON.stringify({ documentTypeNumber: 2, confidence: 0.7, suggestedTitle: null }),
    ]);

    const result = await classifyDocumentType(provider, inputWith(), makeLogger());

    expect(result.documentTypeId).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    expect(result.documentTypeName).toBe('Nota Fiscal');
  });

  it('(a3) T-10: número resolve mesmo quando o nome do tipo tem qualificador/sufixo', async () => {
    // Catálogo cujo tipo tem sufixo — o cenário exato do bug T-10. O modelo
    // devolve só o NÚMERO, então não importa que ele encurtaria o nome.
    const catalog: DocumentTypeCatalogItem[] = [
      { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', name: 'Boleto (QA E-1)', description: 'Cobrança bancária' },
      { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', name: 'Fatura (QA E-1)', description: 'Demonstrativo' },
    ];
    const { provider } = mockProvider([
      JSON.stringify({ documentTypeNumber: 1, confidence: 0.9, suggestedTitle: 'Modelo de Boleto' }),
    ]);

    const result = await classifyDocumentType(provider, inputWith({ catalog }), makeLogger());

    expect(result.documentTypeId).toBe('cccccccc-cccc-cccc-cccc-cccccccccccc');
    expect(result.documentTypeName).toBe('Boleto (QA E-1)');
    expect(result.confidence).toBe(0.9);
  });

  it('(a4) FALLBACK: modelo devolve só nome EXATO (sem número) → ainda resolve', async () => {
    const { provider } = mockProvider([
      JSON.stringify({ documentTypeName: '  nota FISCAL ', confidence: 0.7, suggestedTitle: null }),
    ]);

    const result = await classifyDocumentType(provider, inputWith(), makeLogger());

    expect(result.documentTypeId).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    expect(result.documentTypeName).toBe('Nota Fiscal');
  });

  it('(b) número fora da faixa → documentTypeId null (nenhum tipo)', async () => {
    const { provider } = mockProvider([
      JSON.stringify({ documentTypeNumber: 9, confidence: 0.88, suggestedTitle: 'Boleto de cobrança' }),
    ]);

    const result = await classifyDocumentType(provider, inputWith(), makeLogger());

    expect(result.documentTypeId).toBeNull();
    expect(result.documentTypeName).toBeNull();
    expect(result.confidence).toBe(0);
    // título é independente do tipo — preservado
    expect(result.suggestedTitle).toBe('Boleto de cobrança');
  });

  it('(b2) número válido tem precedência sobre nome divergente no fallback', async () => {
    // Número 1 (Contrato) vence, mesmo o nome apontando para outro tipo.
    const { provider } = mockProvider([
      JSON.stringify({ documentTypeNumber: 1, documentTypeName: 'Nota Fiscal', confidence: 0.8, suggestedTitle: null }),
    ]);

    const result = await classifyDocumentType(provider, inputWith(), makeLogger());

    expect(result.documentTypeId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(result.documentTypeName).toBe('Contrato');
  });

  it('(b3) número zero/inválido cai no fallback de nome exato quando presente', async () => {
    const { provider } = mockProvider([
      JSON.stringify({ documentTypeNumber: 0, documentTypeName: 'Contrato', confidence: 0.6, suggestedTitle: null }),
    ]);

    const result = await classifyDocumentType(provider, inputWith(), makeLogger());

    expect(result.documentTypeId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(result.documentTypeName).toBe('Contrato');
  });

  it('(c) LLM retorna documentTypeNumber null → nenhum tipo', async () => {
    const { provider } = mockProvider([
      JSON.stringify({ documentTypeNumber: null, confidence: 0.05, suggestedTitle: 'Documento avulso' }),
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
      JSON.stringify({ documentTypeNumber: 1 }), // falta confidence
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
      JSON.stringify({ documentTypeNumber: 1, confidence: 0.95, suggestedTitle: 'Contrato XYZ' }),
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
      JSON.stringify({ documentTypeNumber: 1, confidence: 0.95, suggestedTitle: 'Contrato XYZ' }),
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

  it('(f1) catálogo vazio + título DESLIGADO → não chama o LLM e retorna nenhum tipo', async () => {
    const { provider, chat } = mockProvider([]);

    const result = await classifyDocumentType(
      provider,
      inputWith({
        catalog: [],
        flags: { classificationEnabled: true, titleSuggestionEnabled: false },
      }),
      makeLogger()
    );

    expect(chat).not.toHaveBeenCalled();
    expect(result.documentTypeId).toBeNull();
    expect(result.documentTypeName).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.suggestedTitle).toBeNull();
    expect(result.usage.totalTokens).toBe(0);
  });

  it('(f2) catálogo vazio + título LIGADO → chama o LLM e retorna título (tipo null)', async () => {
    const { provider, chat } = mockProvider([
      JSON.stringify({
        documentTypeNumber: null,
        confidence: 0,
        suggestedTitle: 'Contrato de Prestação de Serviços de Consultoria',
      }),
    ]);

    const result = await classifyDocumentType(
      provider,
      inputWith({ catalog: [], flags: FLAGS_ON }),
      makeLogger()
    );

    // Título independe do catálogo de tipos: a IA é chamada mesmo com catálogo vazio.
    expect(chat).toHaveBeenCalledTimes(1);
    // O prompt sinaliza explicitamente a ausência de tipos.
    const params = chat.mock.calls[0]?.[0] as ChatParams;
    const userMessage = params.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(userMessage).toContain('nenhum tipo disponível');
    // Nenhum tipo pode ser resolvido de um catálogo vazio.
    expect(result.documentTypeId).toBeNull();
    expect(result.documentTypeName).toBeNull();
    expect(result.confidence).toBe(0);
    // ...mas o título sugerido é preservado.
    expect(result.suggestedTitle).toBe('Contrato de Prestação de Serviços de Consultoria');
    expect(result.usage.totalTokens).toBe(120);
  });

  it('tolera resposta embrulhada em cercas markdown ```json', async () => {
    const { provider } = mockProvider([
      '```json\n{"documentTypeNumber":1,"confidence":0.8,"suggestedTitle":"T"}\n```',
    ]);

    const result = await classifyDocumentType(provider, inputWith(), makeLogger());

    expect(result.documentTypeId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(result.suggestedTitle).toBe('T');
  });

  it('promptVersion é classify-document-type-v3 (rastreabilidade do prompt)', () => {
    expect(CLASSIFY_DOCUMENT_TYPE_PROMPT.version).toBe('classify-document-type-v3');
  });

  it('fatia o texto ao orçamento (~12k chars) antes de enviar ao LLM', async () => {
    const { provider, chat } = mockProvider([
      JSON.stringify({ documentTypeNumber: null, confidence: 0, suggestedTitle: null }),
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

describe('buildUserMessage (v3 — catálogo NUMERADO + Sinais/Regras por tipo)', () => {
  const build = CLASSIFY_DOCUMENT_TYPE_PROMPT.buildUserMessage;

  it('numera o catálogo 1-based na ordem recebida', () => {
    const msg = build('texto', [
      { name: 'Contrato', description: 'Acordos e contratos' },
      { name: 'Recibo', description: null },
      { name: 'Boleto (QA E-1)', description: 'Cobrança' },
    ]);

    // Cada tipo prefixado pelo seu número; é esse número que o modelo retorna.
    expect(msg).toContain('1. Contrato: Acordos e contratos');
    expect(msg).toContain('2. Recibo');
    expect(msg).toContain('3. Boleto (QA E-1): Cobrança');
  });

  it('tipo SEM sinais/regras renderiza só a linha base numerada, sem linhas extras', () => {
    const msg = build('texto', [
      { name: 'Contrato', description: 'Acordos e contratos' },
      { name: 'Recibo', description: null },
    ]);

    expect(msg).toContain('1. Contrato: Acordos e contratos');
    expect(msg).toContain('2. Recibo');
    expect(msg).not.toContain('Sinais:');
    expect(msg).not.toContain('Regras:');
  });

  it('renderiza a linha Sinais SÓ quando há palavras-chave', () => {
    const msg = build('texto', [
      {
        name: 'Boleto',
        description: 'Documento de cobrança bancária',
        recognitionKeywords: ['linha digitável', 'código de barras', 'cedente'],
      },
    ]);

    expect(msg).toContain('1. Boleto: Documento de cobrança bancária');
    expect(msg).toContain('  Sinais: linha digitável, código de barras, cedente');
    expect(msg).not.toContain('Regras:');
  });

  it('renderiza a linha Regras SÓ quando há regras (inclusive negativas)', () => {
    const msg = build('texto', [
      {
        name: 'Fatura',
        description: null,
        recognitionRules: 'NÃO classifique como Boleto se não houver linha digitável.',
      },
    ]);

    expect(msg).toContain('1. Fatura');
    expect(msg).toContain('  Regras: NÃO classifique como Boleto se não houver linha digitável.');
    expect(msg).not.toContain('Sinais:');
  });

  it('trunca as palavras-chave no teto MAX_RECOGNITION_KEYWORDS_PER_TYPE', () => {
    const many = Array.from({ length: MAX_RECOGNITION_KEYWORDS_PER_TYPE + 10 }, (_, i) => `kw${i}`);
    const msg = build('texto', [
      { name: 'Tipo', description: null, recognitionKeywords: many },
    ]);

    const sinaisLine = msg.split('\n').find((l) => l.includes('Sinais:')) ?? '';
    const rendered = sinaisLine.replace('  Sinais: ', '').split(', ');
    expect(rendered).toHaveLength(MAX_RECOGNITION_KEYWORDS_PER_TYPE);
    // As primeiras N entram; as excedentes ficam de fora.
    expect(rendered[0]).toBe('kw0');
    expect(rendered).not.toContain(`kw${MAX_RECOGNITION_KEYWORDS_PER_TYPE}`);
  });

  it('ignora palavras-chave vazias/em branco antes de aplicar o teto', () => {
    const msg = build('texto', [
      { name: 'Tipo', description: null, recognitionKeywords: ['  ', 'válida', '', '  outra '] },
    ]);
    expect(msg).toContain('  Sinais: válida, outra');
  });

  it('trunca as regras no teto MAX_RECOGNITION_RULES_CHARS com reticências', () => {
    const longRules = 'x'.repeat(MAX_RECOGNITION_RULES_CHARS + 200);
    const msg = build('texto', [
      { name: 'Tipo', description: null, recognitionRules: longRules },
    ]);

    const regrasLine = msg.split('\n').find((l) => l.includes('Regras:')) ?? '';
    const rendered = regrasLine.replace('  Regras: ', '');
    // Conteúdo cortado no teto + reticência (1 char extra), nunca o comprimento original.
    expect(rendered).toBe(`${'x'.repeat(MAX_RECOGNITION_RULES_CHARS)}…`);
    expect(rendered.length).toBeLessThan(longRules.length);
  });

  it('catálogo vazio mantém a mensagem de "nenhum tipo disponível"', () => {
    const msg = build('texto', []);
    expect(msg).toContain('nenhum tipo disponível');
  });
});
