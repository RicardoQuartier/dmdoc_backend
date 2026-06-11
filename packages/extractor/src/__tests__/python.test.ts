import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PythonExtractor } from '../python.js';
import { ExtractionError } from '../types.js';

const mockFetch = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();

function makeResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
  } as Response;
}

describe('PythonExtractor', () => {
  const extractor = new PythonExtractor({ url: 'http://extractor:8000/extract' });
  let filePath: string;
  let dir: string;

  beforeEach(async () => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    dir = await mkdtemp(join(tmpdir(), 'dmdoc-pytest-'));
    filePath = join(dir, 'doc.pdf');
    await writeFile(filePath, Buffer.from('%PDF-1.4 fake'));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it('mapeia a resposta do serviço para ExtractionResult', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, JSON.stringify({ text: '  olá mundo  ', pageCount: 3, ocrPages: [2] }))
    );
    const result = await extractor.extract(filePath, 'application/pdf');
    expect(result.fullText).toBe('olá mundo');
    expect(result.pageCount).toBe(3);
    expect(result.ocrPages).toEqual([2]);
    expect(result.engine).toBe('native');
    expect(result.engineVersion).toBe('python-extractor');
  });

  it('aplica defaults quando campos vêm ausentes/inválidos', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, JSON.stringify({ text: 'x' })));
    const result = await extractor.extract(filePath, 'application/pdf');
    expect(result.pageCount).toBe(1);
    expect(result.ocrPages).toEqual([]);
  });

  it('lança ExtractionError em HTTP != 2xx', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(500, 'boom'));
    await expect(extractor.extract(filePath, 'application/pdf')).rejects.toBeInstanceOf(
      ExtractionError
    );
  });

  it('lança ExtractionError quando o serviço retorna { error }', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(200, JSON.stringify({ text: '', pageCount: 1, ocrPages: [], error: 'unsupported mime' }))
    );
    await expect(extractor.extract(filePath, 'application/zip')).rejects.toThrow('unsupported mime');
  });

  it('lança ExtractionError em erro de rede', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(extractor.extract(filePath, 'application/pdf')).rejects.toBeInstanceOf(
      ExtractionError
    );
  });
});
