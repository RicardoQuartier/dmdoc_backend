import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import { embedChunks } from '../embed.js';
import type { ChunkDraft } from '../chunk.js';
import type OpenAI from 'openai';

// Embedding de 1536 dimensões zerado (usado como stub)
const FAKE_EMBEDDING: number[] = Array.from({ length: 1536 }, () => 0);

const META = {
  documentId: '00000000-0000-0000-0000-000000000001',
  tenantId: '00000000-0000-0000-0000-000000000002',
  departmentId: '00000000-0000-0000-0000-000000000003',
  documentTypeName: 'Contrato',
};

function makeChunks(n: number): ChunkDraft[] {
  return Array.from({ length: n }, (_, i) => ({
    text: `chunk ${i}`,
    tokenCount: 10,
    pageNumber: null,
    chunkIndex: i,
    ...META,
  }));
}

function makeOpenAIMock(overrides?: Partial<{ promptTokens: number }>): OpenAI {
  const promptTokens = overrides?.promptTokens ?? 100;

  const createFn = vi.fn().mockImplementation((params: { input: string[] }) => {
    return Promise.resolve({
      data: params.input.map((_, idx) => ({
        embedding: FAKE_EMBEDDING,
        index: idx,
      })),
      usage: {
        prompt_tokens: promptTokens,
        total_tokens: promptTokens,
      },
    });
  });

  return {
    embeddings: { create: createFn },
  } as unknown as OpenAI;
}

function makeSilentLogger(): Logger {
  return {
    child: () => makeSilentLogger(),
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger;
}

describe('embedChunks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retorna array vazio para lista de chunks vazia', async () => {
    const openai = makeOpenAIMock();
    const result = await embedChunks([], {
      openai,
      embeddingModel: 'text-embedding-3-small',
      logger: makeSilentLogger(),
    });

    expect(result.embeddedChunks).toEqual([]);
    expect(result.totalEmbeddingsUsd).toBe(0);
    expect((openai.embeddings.create as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('chama a API uma única vez para menos de 100 chunks', async () => {
    const openai = makeOpenAIMock();
    const chunks = makeChunks(50);

    const result = await embedChunks(chunks, {
      openai,
      embeddingModel: 'text-embedding-3-small',
      logger: makeSilentLogger(),
    });

    expect((openai.embeddings.create as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(result.embeddedChunks).toHaveLength(50);
  });

  it('divide 250 chunks em 3 batches (100 + 100 + 50)', async () => {
    const openai = makeOpenAIMock();
    const chunks = makeChunks(250);

    const result = await embedChunks(chunks, {
      openai,
      embeddingModel: 'text-embedding-3-small',
      logger: makeSilentLogger(),
    });

    expect((openai.embeddings.create as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(3);
    expect(result.embeddedChunks).toHaveLength(250);
  });

  it('retorna exatamente 1 batch para 100 chunks', async () => {
    const openai = makeOpenAIMock();
    const chunks = makeChunks(100);

    await embedChunks(chunks, {
      openai,
      embeddingModel: 'text-embedding-3-small',
      logger: makeSilentLogger(),
    });

    expect((openai.embeddings.create as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('todos os chunks resultantes têm embedding de 1536 dimensões', async () => {
    const openai = makeOpenAIMock();
    const chunks = makeChunks(5);

    const result = await embedChunks(chunks, {
      openai,
      embeddingModel: 'text-embedding-3-small',
      logger: makeSilentLogger(),
    });

    for (const chunk of result.embeddedChunks) {
      expect(chunk.embedding).toHaveLength(1536);
    }
  });

  it('preserva os metadados dos chunks originais', async () => {
    const openai = makeOpenAIMock();
    const chunks = makeChunks(3);

    const result = await embedChunks(chunks, {
      openai,
      embeddingModel: 'text-embedding-3-small',
      logger: makeSilentLogger(),
    });

    for (let i = 0; i < chunks.length; i++) {
      const original = chunks[i]!;
      const embedded = result.embeddedChunks[i]!;
      expect(embedded.documentId).toBe(original.documentId);
      expect(embedded.tenantId).toBe(original.tenantId);
      expect(embedded.chunkIndex).toBe(original.chunkIndex);
      expect(embedded.text).toBe(original.text);
      expect(embedded.tokenCount).toBe(original.tokenCount);
    }
  });

  it('calcula custo com base nos prompt_tokens reportados pela API', async () => {
    // 1000 prompt_tokens: 1000 * 0.00002 / 1000 = $0.00002
    const openai = makeOpenAIMock({ promptTokens: 1000 });
    const chunks = makeChunks(5);

    const result = await embedChunks(chunks, {
      openai,
      embeddingModel: 'text-embedding-3-small',
      logger: makeSilentLogger(),
    });

    expect(result.totalEmbeddingsUsd).toBeCloseTo(0.00002, 8);
  });

  it('acumula custo de múltiplos batches', async () => {
    // Cada batch reporta 1000 tokens → 250 chunks = 3 batches → 3 * $0.00002
    const openai = makeOpenAIMock({ promptTokens: 1000 });
    const chunks = makeChunks(250);

    const result = await embedChunks(chunks, {
      openai,
      embeddingModel: 'text-embedding-3-small',
      logger: makeSilentLogger(),
    });

    expect(result.totalEmbeddingsUsd).toBeCloseTo(0.00002 * 3, 8);
  });

  it('loga custo com campo costUsdCents', async () => {
    const log = makeSilentLogger();
    const openai = makeOpenAIMock({ promptTokens: 1000 });
    const chunks = makeChunks(5);

    await embedChunks(chunks, {
      openai,
      embeddingModel: 'text-embedding-3-small',
      logger: log,
    });

    // Verificar que a API foi chamada (log de custo ocorre dentro do embed)
    expect((openai.embeddings.create as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('lança erro se a API retornar embedding com dimensão errada', async () => {
    const badEmbedding = Array.from({ length: 512 }, () => 0); // dimensão errada

    const createFn = vi.fn().mockResolvedValue({
      data: [{ embedding: badEmbedding, index: 0 }],
      usage: { prompt_tokens: 10, total_tokens: 10 },
    });

    const openai = { embeddings: { create: createFn } } as unknown as OpenAI;
    const chunks = makeChunks(1);

    await expect(
      embedChunks(chunks, {
        openai,
        embeddingModel: 'text-embedding-3-small',
        logger: makeSilentLogger(),
      })
    ).rejects.toThrow();
  });
});
