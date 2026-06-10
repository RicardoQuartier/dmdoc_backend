import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type ExtractionResult, type ExtractorProvider, ExtractionError } from './types.js';
import { extractDocxImageText } from './docx-images.js';

const execFileAsync = promisify(execFile);

// ─── versões (bumpar junto com upgrade de dependência) ────────────────────────
const NATIVE_ENGINE_VERSION = '1.0.0';

/**
 * Threshold em caracteres abaixo do qual um PDF é considerado escaneado
 * e será re-processado via OCR (tesseract.js).
 */
const PDF_SCANNED_THRESHOLD = 50;

// ─── helpers de import dinâmico ───────────────────────────────────────────────
// Importações dinâmicas evitam erros de inicialização quando as libs opcionais
// não estão instaladas no ambiente onde o pacote é apenas transitivo.

async function importPdfParse() {
  const mod = await import('pdf-parse');
  // pdf-parse exporta default em CJS/ESM interop
  return (mod.default ?? mod) as (buffer: Buffer) => Promise<{ text: string; numpages: number }>;
}

async function importMammoth() {
  const mod = await import('mammoth');
  return mod as {
    extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }>;
  };
}

async function importXlsx() {
  const mod = await import('xlsx');
  return (mod.default ?? mod) as {
    read: (buffer: Buffer, opts: { type: 'buffer' }) => { SheetNames: string[]; Sheets: Record<string, unknown> };
    utils: {
      sheet_to_csv: (sheet: unknown) => string;
    };
  };
}

async function importTesseract() {
  const mod = await import('tesseract.js');
  return mod as unknown as {
    createWorker: (lang: string) => Promise<{
      recognize: (image: Buffer) => Promise<{ data: { text: string } }>;
      terminate: () => Promise<void>;
    }>;
  };
}

// ─── extratores por MIME ──────────────────────────────────────────────────────

async function extractPdf(
  filePath: string
): Promise<Pick<ExtractionResult, 'fullText' | 'pageCount' | 'ocrPages'>> {
  const buffer = await readFile(filePath);
  const pdfParse = await importPdfParse();

  const parsed = await pdfParse(buffer);
  const nativeText = parsed.text ?? '';
  const pageCount = parsed.numpages ?? 1;

  if (nativeText.trim().length >= PDF_SCANNED_THRESHOLD) {
    return { fullText: nativeText.trim(), pageCount, ocrPages: [] };
  }

  // PDF escaneado → OCR via tesseract.js usando pdftoppm para extrair imagens
  // Se pdftoppm não estiver disponível, faz OCR direto no buffer como fallback
  const ocrPages: number[] = [];
  let ocrText = '';

  try {
    const tmpDir = join(tmpdir(), `dmdoc-ocr-${randomUUID()}`);
    const { mkdir, readdir, rm } = await import('node:fs/promises');
    await mkdir(tmpDir, { recursive: true });

    // Converte cada página do PDF em PNG
    try {
      await execFileAsync('pdftoppm', ['-png', '-r', '150', filePath, join(tmpDir, 'page')]);
    } catch {
      // pdftoppm não disponível — faz OCR no PDF inteiro como fallback
      const tesseract = await importTesseract();
      const worker = await tesseract.createWorker('por+eng');
      try {
        const result = await worker.recognize(buffer);
        ocrText = result.data.text;
        for (let i = 1; i <= pageCount; i++) ocrPages.push(i);
      } finally {
        await worker.terminate();
      }
      await rm(tmpDir, { recursive: true, force: true });
      return { fullText: ocrText.trim(), pageCount, ocrPages };
    }

    const files = (await readdir(tmpDir))
      .filter((f) => f.endsWith('.png') || f.endsWith('.ppm'))
      .sort(); // garante ordem numérica das páginas

    const tesseract = await importTesseract();
    const worker = await tesseract.createWorker('por+eng');
    const texts: string[] = [];

    try {
      for (let i = 0; i < files.length; i++) {
        const imgPath = join(tmpDir, files[i] as string);
        const imgBuffer = await readFile(imgPath);
        const result = await worker.recognize(imgBuffer);
        texts.push(result.data.text);
        ocrPages.push(i + 1);
      }
    } finally {
      await worker.terminate();
      await rm(tmpDir, { recursive: true, force: true });
    }

    ocrText = texts.join('\n\n');
  } catch (err) {
    throw new ExtractionError(
      `OCR failed for scanned PDF: ${String(err)}`,
      'application/pdf',
      'native',
      err
    );
  }

  return {
    fullText: ocrText.trim(),
    pageCount,
    ocrPages,
  };
}

async function extractDocx(
  filePath: string
): Promise<Pick<ExtractionResult, 'fullText' | 'pageCount' | 'ocrPages'>> {
  const buffer = await readFile(filePath);
  const mammoth = await importMammoth();

  const textResult = await mammoth.extractRawText({ buffer });
  let fullText = textResult.value.trim();

  const imageText = await extractDocxImageText(filePath);
  const hasImages = imageText.length > 0;
  if (hasImages) {
    fullText = [fullText, imageText].filter(Boolean).join('\n\n');
  }

  return {
    fullText,
    pageCount: 1, // mammoth não expõe contagem de páginas
    ocrPages: hasImages ? [1] : [],
  };
}

async function extractXlsx(
  filePath: string
): Promise<Pick<ExtractionResult, 'fullText' | 'pageCount' | 'ocrPages'>> {
  const buffer = await readFile(filePath);
  const xlsx = await importXlsx();
  const workbook = xlsx.read(buffer, { type: 'buffer' });

  const csvParts: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (sheet == null) continue;
    const csv = xlsx.utils.sheet_to_csv(sheet);
    if (csv.trim().length > 0) {
      csvParts.push(`### ${sheetName}\n${csv}`);
    }
  }

  return {
    fullText: csvParts.join('\n\n').trim(),
    pageCount: workbook.SheetNames.length,
    ocrPages: [],
  };
}

async function extractImage(
  filePath: string,
  mimeType: string
): Promise<Pick<ExtractionResult, 'fullText' | 'pageCount' | 'ocrPages'>> {
  const buffer = await readFile(filePath);
  const tesseract = await importTesseract();
  const worker = await tesseract.createWorker('por+eng');
  try {
    const result = await worker.recognize(buffer);
    return {
      fullText: result.data.text.trim(),
      pageCount: 1,
      ocrPages: [1],
    };
  } catch (err) {
    throw new ExtractionError(
      `OCR failed for image: ${String(err)}`,
      mimeType,
      'native',
      err
    );
  } finally {
    await worker.terminate();
  }
}

async function extractPptx(
  filePath: string
): Promise<Pick<ExtractionResult, 'fullText' | 'pageCount' | 'ocrPages'>> {
  // Estratégia: libreoffice converte PPTX → PDF temporário, depois pdf-parse
  const tmpDir = join(tmpdir(), `dmdoc-pptx-${randomUUID()}`);
  const { mkdir, readdir, rm } = await import('node:fs/promises');
  await mkdir(tmpDir, { recursive: true });

  try {
    await execFileAsync('libreoffice', [
      '--headless',
      '--convert-to', 'pdf',
      '--outdir', tmpDir,
      filePath,
    ]);

    const files = await readdir(tmpDir);
    const pdfFile = files.find((f) => f.endsWith('.pdf'));
    if (!pdfFile) {
      throw new ExtractionError(
        'libreoffice did not produce a PDF output for PPTX',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'native'
      );
    }

    const pdfPath = join(tmpDir, pdfFile);
    const result = await extractPdf(pdfPath);
    return result;
  } catch (err) {
    if (err instanceof ExtractionError) throw err;
    throw new ExtractionError(
      `libreoffice conversion failed for PPTX: ${String(err)}`,
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'native',
      err
    );
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// ─── NativeExtractor ──────────────────────────────────────────────────────────

/**
 * Extrator sem dependências externas de serviço.
 *
 * Usado como fallback quando o Unstructured não está disponível, ou como
 * extrator padrão em produção quando se quer evitar serviços adicionais.
 *
 * Mapeamento MIME → biblioteca:
 * - application/pdf              → pdf-parse (+ tesseract.js se escaneado)
 * - image/jpeg, image/png        → tesseract.js
 * - .docx                        → mammoth
 * - .xlsx, .xls                  → xlsx
 * - .pptx                        → libreoffice CLI → PDF → pdf-parse
 */
export class NativeExtractor implements ExtractorProvider {
  async extract(filePath: string, mimeType: string): Promise<ExtractionResult> {
    const startMs = Date.now();

    let partial: Pick<ExtractionResult, 'fullText' | 'pageCount' | 'ocrPages'>;

    switch (mimeType) {
      case 'application/pdf':
        partial = await extractPdf(filePath);
        break;

      case 'image/jpeg':
      case 'image/png':
        partial = await extractImage(filePath, mimeType);
        break;

      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        partial = await extractDocx(filePath);
        break;

      case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      case 'application/vnd.ms-excel':
        partial = await extractXlsx(filePath);
        break;

      case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
        partial = await extractPptx(filePath);
        break;

      default:
        throw new ExtractionError(
          `MIME type "${mimeType}" is not supported by NativeExtractor`,
          mimeType,
          'native'
        );
    }

    return {
      ...partial,
      engine: 'native',
      engineVersion: NATIVE_ENGINE_VERSION,
      durationMs: Date.now() - startMs,
    };
  }
}
