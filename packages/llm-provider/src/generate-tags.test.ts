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

describe('GENERATE_TAGS_PROMPT (regressão: par rótulo:valor numa tag só — bug T-51)', () => {
  it('está na versão v3 (bump de rastreabilidade)', () => {
    expect(GENERATE_TAGS_PROMPT.version).toBe('generate-tags-v3');
  });

  it('instrui explicitamente o formato "Rótulo: valor" para informação composta', () => {
    const prompt = GENERATE_TAGS_PROMPT.systemPrompt;
    expect(prompt).toMatch(/rótulo.*valor/i);
    expect(prompt).toContain('NUNCA separe o rótulo e o valor em duas tags distintas');
  });

  it('traz o exemplo real do bug reportado (NFS-e: 22) e não o formato quebrado', () => {
    const prompt = GENERATE_TAGS_PROMPT.systemPrompt;
    expect(prompt).toContain('"NFS-e: 22"');
  });

  it('os exemplos de formato rótulo:valor do prompt respeitam MAX_TAG_LENGTH', () => {
    const prompt = GENERATE_TAGS_PROMPT.systemPrompt;
    const examples = [...prompt.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
    // Exemplos de tag (contém ": ") não podem estourar o teto por tag.
    const tagLikeExamples = examples.filter((e) => e.includes(': '));
    expect(tagLikeExamples.length).toBeGreaterThan(0);
    for (const example of tagLikeExamples) {
      expect(example.length).toBeLessThanOrEqual(MAX_TAG_LENGTH);
    }
  });
});

describe('GENERATE_TAGS_PROMPT (regressão v3: papel das partes como rótulo)', () => {
  it('proíbe repetir o rótulo genérico impresso no documento para partes diferentes', () => {
    const prompt = GENERATE_TAGS_PROMPT.systemPrompt;
    expect(prompt).toContain('DUAS OU MAIS partes');
    expect(prompt).toMatch(/NUNCA repita.*rótulo genérico/i);
  });

  it('instrui a usar o PAPEL da parte como rótulo, com exemplos multi-domínio', () => {
    const prompt = GENERATE_TAGS_PROMPT.systemPrompt;
    // NFS-e: emitente × tomador distinguidos (o bug original do usuário).
    expect(prompt).toContain('"CNPJ do Emitente: 26.575.462/0001-20"');
    expect(prompt).toContain('"CNPJ do Tomador: 02.389.406/0001-33"');
    // Método agnóstico ao tipo: exemplos de boleto e conta de consumo também.
    expect(prompt).toContain('"Pagador: COMERCIAL ALFA LTDA"');
    expect(prompt).toContain('"Titular: JOÃO DA SILVA"');
  });

  it('mostra o antipadrão do rótulo repetido como ERRADO', () => {
    expect(GENERATE_TAGS_PROMPT.systemPrompt).toContain('ERRADO');
  });

  it('teto por tag comporta papel + razão social longa (v3: 60 → 90)', () => {
    expect(MAX_TAG_LENGTH).toBe(90);
    expect('Emitente: METAVERSO DESENVOLVIMENTO DE SOFTWARE LTDA'.length).toBeLessThanOrEqual(
      MAX_TAG_LENGTH
    );
  });
});

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
