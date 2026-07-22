import { describe, expect, it, vi } from 'vitest';
import {
  generateTags,
  normalizeTags,
  GENERATE_TAGS_PROMPT,
  MAX_GENERATED_TAGS,
  MAX_TAG_LENGTH,
} from './generate-tags.js';
import type { ChatParams, ChatResult, LLMProvider, TokenUsage } from './types.js';

const USAGE: TokenUsage = {
  promptTokens: 200,
  completionTokens: 40,
  totalTokens: 240,
  costUsd: 0.0002,
};

/** Logger no-op que satisfaz a interface mínima esperada pelo núcleo. */
function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/**
 * Cria um LLMProvider mock cujo `chat` devolve, em sequência, os `contents`
 * fornecidos. `chatStream` não é usado por este núcleo.
 */
function mockProvider(
  contents: string[],
  model = 'gpt-4o-mini'
): { provider: LLMProvider; chat: ReturnType<typeof vi.fn> } {
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

describe('normalizeTags', () => {
  it('faz trim e remove vazias', () => {
    expect(normalizeTags(['  Contrato  ', '', '   ', 'Boleto'])).toEqual(['Contrato', 'Boleto']);
  });

  it('remove duplicatas case-insensitive, preservando a primeira grafia', () => {
    expect(normalizeTags(['Contrato', 'contrato', 'CONTRATO', 'Boleto'])).toEqual([
      'Contrato',
      'Boleto',
    ]);
  });

  it('descarta tags acima do limite de tamanho por tag', () => {
    const longTag = 'x'.repeat(MAX_TAG_LENGTH + 1);
    const okTag = 'y'.repeat(MAX_TAG_LENGTH);
    expect(normalizeTags([longTag, okTag])).toEqual([okTag]);
  });

  it('aplica o teto de 30 tags', () => {
    const many = Array.from({ length: 50 }, (_, i) => `tag-${i}`);
    const result = normalizeTags(many);
    expect(result).toHaveLength(MAX_GENERATED_TAGS);
    expect(result[0]).toBe('tag-0');
    expect(result.at(-1)).toBe(`tag-${MAX_GENERATED_TAGS - 1}`);
  });
});

describe('generateTags', () => {
  it('retorna tags normalizadas, promptVersion, model e custo da chamada', async () => {
    const { provider, chat } = mockProvider([
      JSON.stringify({ tags: ['Contrato', 'contrato', '  Boleto  ', ''] }),
    ]);

    const result = await generateTags(
      provider,
      { fullText: 'Contrato de locação e boleto anexo.' },
      makeLogger()
    );

    expect(result.tags).toEqual(['Contrato', 'Boleto']);
    expect(result.promptVersion).toBe(GENERATE_TAGS_PROMPT.version);
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.costUsd).toBeCloseTo(USAGE.costUsd, 10);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('não chama o LLM quando o texto está vazio (custo 0)', async () => {
    const { provider, chat } = mockProvider([]);

    const result = await generateTags(provider, { fullText: '   ' }, makeLogger());

    expect(result.tags).toEqual([]);
    expect(result.costUsd).toBe(0);
    expect(result.model).toBe('');
    expect(chat).not.toHaveBeenCalled();
  });

  it('faz retry em JSON inválido e acumula o custo das duas tentativas', async () => {
    const { provider, chat } = mockProvider([
      'isto não é json',
      JSON.stringify({ tags: ['Nota Fiscal'] }),
    ]);

    const result = await generateTags(provider, { fullText: 'Nota fiscal 123.' }, makeLogger());

    expect(result.tags).toEqual(['Nota Fiscal']);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.costUsd).toBeCloseTo(USAGE.costUsd * 2, 10);
  });

  it('lança quando nenhuma tentativa produz JSON válido (custo acumulado nas tentativas)', async () => {
    const { provider, chat } = mockProvider(['lixo', 'mais lixo']);

    await expect(
      generateTags(provider, { fullText: 'Documento qualquer.' }, makeLogger())
    ).rejects.toThrow(/inválida para geração de tags/);
    expect(chat).toHaveBeenCalledTimes(2);
  });
});
