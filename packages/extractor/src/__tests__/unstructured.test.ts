import { writeFile, unlink, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnstructuredExtractor } from '../unstructured.js';
import { UnstructuredApiError, ExtractionError } from '../types.js';

// ─── mock de fetch global ─────────────────────────────────────────────────────

const mockFetch = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

const ELEMENTS = [
  { type: 'Title', text: 'Hello World', metadata: { page_number: 1 } },
  { type: 'NarrativeText', text: 'Some content here.', metadata: { page_number: 1 } },
  { type: 'NarrativeText', text: 'More text on page two.', metadata: { page_number: 2 } },
];

// ─── fixtures ─────────────────────────────────────────────────────────────────

let tmpDir: string;
let pdfPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'dmdoc-test-'));
  pdfPath = join(tmpDir, 'sample.pdf');
  await writeFile(pdfPath, '%PDF-1.4 minimal');
});

afterEach(async () => {
  await unlink(pdfPath).catch(() => undefined);
});

// ─── testes ───────────────────────────────────────────────────────────────────

describe('UnstructuredExtractor', () => {
  const extractor = new UnstructuredExtractor({
    apiUrl: 'http://localhost:8000/general/v0/general',
  });

  it('mapeia elementos para ExtractionResult corretamente', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, JSON.stringify(ELEMENTS)));

    const result = await extractor.extract(pdfPath, 'application/pdf');

    expect(result.engine).toBe('unstructured');
    expect(result.fullText).toBe('Hello World\n\nSome content here.\n\nMore text on page two.');
    expect(result.pageCount).toBe(2);
    expect(result.ocrPages).toEqual([]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('lança UnstructuredApiError quando a API retorna 422', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(422, 'Unprocessable Entity'));

    await expect(extractor.extract(pdfPath, 'application/pdf')).rejects.toBeInstanceOf(
      UnstructuredApiError
    );
  });

  it('lança UnstructuredApiError com o status HTTP correto', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(500, 'Internal Server Error'));

    const err = await extractor.extract(pdfPath, 'application/pdf').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnstructuredApiError);
    expect((err as UnstructuredApiError).status).toBe(500);
  });

  it('lança ExtractionError para MIME não suportado', async () => {
    await expect(
      extractor.extract(pdfPath, 'text/plain')
    ).rejects.toBeInstanceOf(ExtractionError);
  });

  it('lança ExtractionError em erro de rede (fetch rejeita)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(extractor.extract(pdfPath, 'application/pdf')).rejects.toBeInstanceOf(
      ExtractionError
    );
  });

  it('inclui apiKey no header quando configurado', async () => {
    const extractorWithKey = new UnstructuredExtractor({
      apiUrl: 'http://localhost:8000/general/v0/general',
      apiKey: 'secret-key-123',
    });

    mockFetch.mockResolvedValueOnce(makeResponse(200, JSON.stringify(ELEMENTS)));
    await extractorWithKey.extract(pdfPath, 'application/pdf');

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers['unstructured-api-key']).toBe('secret-key-123');
  });

  it('pageCount default 1 quando nenhum element tem page_number', async () => {
    const elements = [{ type: 'Text', text: 'No page metadata.', metadata: {} }];
    mockFetch.mockResolvedValueOnce(makeResponse(200, JSON.stringify(elements)));

    const result = await extractor.extract(pdfPath, 'application/pdf');
    expect(result.pageCount).toBe(1);
  });

  it('ignora elementos com texto vazio', async () => {
    const elements = [
      { type: 'Text', text: '  ', metadata: { page_number: 1 } },
      { type: 'Text', text: 'Real text.', metadata: { page_number: 1 } },
    ];
    mockFetch.mockResolvedValueOnce(makeResponse(200, JSON.stringify(elements)));

    const result = await extractor.extract(pdfPath, 'application/pdf');
    expect(result.fullText).toBe('Real text.');
  });
});
