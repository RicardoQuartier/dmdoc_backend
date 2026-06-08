import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeExtractor } from '../native.js';
import { ExtractionError } from '../types.js';

// ─── fixtures ─────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'dmdoc-native-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

async function writeTmp(name: string, content: Buffer | string): Promise<string> {
  const filePath = join(tmpDir, name);
  await writeFile(filePath, content);
  return filePath;
}

// ─── mocks de libs de extração ────────────────────────────────────────────────
// Usamos vi.mock para interceptar os imports dinâmicos sem precisar de
// instalar as libs reais (que dependem de binários nativos / wasm).

vi.mock('pdf-parse', () => ({
  // O texto retornado deve ter mais de 50 chars para não cair no caminho de OCR.
  default: async (_buffer: Buffer) => ({
    text: 'Hello World from the DMDoc Native PDF extractor — this is a native text extraction test.',
    numpages: 3,
  }),
}));

vi.mock('mammoth', () => ({
  extractRawText: async (_opts: { buffer: Buffer }) => ({
    value: 'Hello from DOCX file',
  }),
}));

vi.mock('xlsx', () => ({
  default: {
    read: (_buf: Buffer, _opts: unknown) => ({
      SheetNames: ['Sheet1', 'Sheet2'],
      Sheets: {
        Sheet1: {},
        Sheet2: {},
      },
    }),
    utils: {
      sheet_to_csv: (_sheet: unknown) => 'col1,col2\nval1,val2',
    },
  },
}));

// ─── testes ───────────────────────────────────────────────────────────────────

describe('NativeExtractor', () => {
  const extractor = new NativeExtractor();

  describe('PDF com texto nativo', () => {
    it('retorna fullText e pageCount do pdf-parse', async () => {
      const filePath = await writeTmp('sample.pdf', '%PDF-1.4 content');

      const result = await extractor.extract(filePath, 'application/pdf');

      expect(result.engine).toBe('native');
      expect(result.fullText).toBe(
        'Hello World from the DMDoc Native PDF extractor — this is a native text extraction test.'
      );
      expect(result.pageCount).toBe(3);
      expect(result.ocrPages).toEqual([]);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('DOCX', () => {
    it('extrai texto via mammoth', async () => {
      const filePath = await writeTmp('sample.docx', 'fake docx bytes');

      const result = await extractor.extract(
        filePath,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );

      expect(result.engine).toBe('native');
      expect(result.fullText).toBe('Hello from DOCX file');
      expect(result.pageCount).toBe(1);
    });
  });

  describe('XLSX', () => {
    it('converte todas as sheets para CSV separadas por título', async () => {
      const filePath = await writeTmp('sample.xlsx', 'fake xlsx bytes');

      const result = await extractor.extract(
        filePath,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      expect(result.engine).toBe('native');
      expect(result.fullText).toContain('### Sheet1');
      expect(result.fullText).toContain('### Sheet2');
      expect(result.fullText).toContain('col1,col2');
      expect(result.pageCount).toBe(2);
    });
  });

  describe('MIME não suportado', () => {
    it('lança ExtractionError com o MIME correto', async () => {
      const filePath = await writeTmp('file.txt', 'text content');

      const err = await extractor.extract(filePath, 'text/plain').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ExtractionError);
      expect((err as ExtractionError).mimeType).toBe('text/plain');
      expect((err as ExtractionError).engine).toBe('native');
    });
  });

  describe('engineVersion', () => {
    it('retorna engineVersion como string não vazia', async () => {
      const filePath = await writeTmp('sample.pdf', '%PDF-1.4');

      const result = await extractor.extract(filePath, 'application/pdf');

      expect(result.engineVersion).toBeTruthy();
      expect(typeof result.engineVersion).toBe('string');
    });
  });
});
