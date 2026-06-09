import { exec } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import FormData from 'form-data';
import sharp from 'sharp';
import Tesseract from 'tesseract.js';
import {
  type ExtractionResult,
  type ExtractorProvider,
  UnstructuredApiError,
  ExtractionError,
} from './types.js';

const execAsync = promisify(exec);

/** Elemento retornado pela API do Unstructured. */
interface UnstructuredElement {
  type: string;
  text: string;
  metadata: {
    page_number?: number;
    [key: string]: unknown;
  };
}

/**
 * Configuração injetada pelo chamador.
 * O `apiKey` é opcional pois o Unstructured self-hosted pode não exigir auth.
 */
export interface UnstructuredExtractorConfig {
  /** URL completa do endpoint, ex.: http://localhost:8000/general/v0/general */
  apiUrl: string;
  apiKey?: string;
}

const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const MIN_TEXT_LENGTH = 20;

/**
 * Retorna true se o texto tem conteúdo útil.
 * Critérios:
 * 1. Comprimento mínimo.
 * 2. Pelo menos 30% das "palavras" (sequências de letras) têm 4+ caracteres.
 *    Ruído de OCR produz letras isoladas e siglas curtas; texto real tem palavras longas.
 */
function isUsableText(text: string): boolean {
  if (text.length < MIN_TEXT_LENGTH) return false;
  const words = text.match(/\p{L}+/gu) ?? [];
  if (words.length === 0) return false;
  const longWords = words.filter((w) => w.length >= 4).length;
  return longWords / words.length >= 0.3;
}

/**
 * Extrator que delega ao serviço Unstructured rodando via HTTP.
 *
 * Pipeline de fallback para PDFs escaneados e imagens:
 * 1. `auto` — rápido, sem OCR forçado.
 * 2. `ocr_only` — Tesseract em toda a página (sem layout detection).
 * 3. `tesseract.js` direto — bbox detection + 4 rotações. Para PDF requer pdftoppm;
 *    para JPEG/PNG usa o arquivo diretamente.
 */
export class UnstructuredExtractor implements ExtractorProvider {
  private readonly config: UnstructuredExtractorConfig;

  constructor(config: UnstructuredExtractorConfig) {
    this.config = config;
  }

  async extract(filePath: string, mimeType: string): Promise<ExtractionResult> {
    if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
      throw new ExtractionError(
        `MIME type "${mimeType}" is not supported by UnstructuredExtractor`,
        mimeType,
        'unstructured'
      );
    }

    const startMs = Date.now();
    const fileBuffer = await readFile(filePath);

    const autoResult = await this.callApi(fileBuffer, filePath, mimeType, 'auto');
    if (isUsableText(autoResult.fullText)) {
      return { ...autoResult, durationMs: Date.now() - startMs };
    }

    // PDF escaneado: tenta ocr_only (Tesseract em página inteira, sem detectron2)
    const ocrResult = await this.callApi(fileBuffer, filePath, mimeType, 'ocr_only');
    if (isUsableText(ocrResult.fullText)) {
      return {
        ...ocrResult,
        ocrPages: Array.from({ length: ocrResult.pageCount }, (_, i) => i + 1),
        durationMs: Date.now() - startMs,
      };
    }

    // Último recurso: tesseract.js direto com bbox detection + 4 rotações.
    // Cobre PDFs escaneados invertidos e imagens JPEG/PNG enviadas diretamente.
    // Para PDF requer pdftoppm; para imagens usa o arquivo direto.
    const isImage = mimeType === 'image/jpeg' || mimeType === 'image/png';
    if (mimeType === 'application/pdf' || isImage) {
      let tsResult: ExtractionResult | null = null;
      try {
        tsResult = await this.ocrWithTesseractJs(filePath, mimeType);
      } catch (err) {
        process.stderr.write(`[dmdoc] ocrWithTesseractJs error: ${String(err)}\n`);
      }
      if (tsResult !== null && isUsableText(tsResult.fullText)) {
        return { ...tsResult, durationMs: Date.now() - startMs };
      }
    }

    // Retorna o melhor resultado disponível (pode ser texto curto/inútil)
    return {
      ...ocrResult,
      ocrPages: Array.from({ length: ocrResult.pageCount }, (_, i) => i + 1),
      durationMs: Date.now() - startMs,
    };
  }

  /**
   * Roda tesseract.js com bbox detection + 4 rotações.
   * Para PDF: converte para PNG via pdftoppm (requer poppler-utils no PATH).
   * Para imagens (JPEG/PNG): usa o arquivo diretamente.
   */
  private async ocrWithTesseractJs(
    filePath: string,
    mimeType: string
  ): Promise<ExtractionResult | null> {
    const isImage = mimeType === 'image/jpeg' || mimeType === 'image/png';

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'dmdoc-tess-'));
    try {
      let files: string[];

      if (isImage) {
        // Imagem enviada diretamente — usa como única "página"
        files = [filePath];
        process.stderr.write(`[dmdoc] tesseract.js: imagem direta ${filePath}\n`);
      } else {
        // PDF: converte para PNGs via pdftoppm
        try {
          await execAsync('which pdftoppm');
        } catch {
          process.stderr.write('[dmdoc] pdftoppm não encontrado, pulando fallback tesseract.js\n');
          return null;
        }
        const prefix = path.join(tmpDir, 'page');
        process.stderr.write(`[dmdoc] pdftoppm: convertendo ${filePath}\n`);
        await execAsync(`pdftoppm -r 300 -png "${filePath}" "${prefix}"`);
        files = (await readdir(tmpDir))
          .filter((f) => f.endsWith('.png'))
          .sort()
          .map((f) => path.join(tmpDir, f));
      }

      process.stderr.write(`[dmdoc] tesseract.js: ${files.length} página(s) para OCR\n`);
      if (files.length === 0) return null;

      // Pré-processa cada página: gera 4 variantes de rotação.
      // Para PDFs (convertidos via pdftoppm): usa bbox de pixels escuros para recortar
      // o conteúdo antes de rodar o tesseract — evita o problema de "Estimating resolution"
      // quando o documento ocupa só uma pequena área da página.
      // Para imagens diretas (JPEG/PNG): usa a imagem completa — ela já é o documento.
      const preparedDir = path.join(tmpDir, 'prepared');
      await mkdir(preparedDir);

      const preparedFiles: string[] = [];
      for (const imgFile of files) {
        const base = path.basename(imgFile, path.extname(imgFile));

        const origMeta = await sharp(imgFile).metadata();
        const origW = origMeta.width ?? 2544;
        const origH = origMeta.height as number ?? 3508;

        let region: { left: number; top: number; width: number; height: number };

        // Detecta bbox de conteúdo via pixels escuros (< 100) em thumbnail.
        // Funciona para PDFs (conteúdo pequeno em página grande) e para imagens
        // onde o texto concentrado numa região dá OCR melhor do que a imagem toda.
        const SW = 127, SH = Math.round((origH / origW) * SW);
        const { data: grayBuf, info: si } = await sharp(imgFile)
          .resize(SW, SH, { fit: 'fill' })
          .grayscale()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const gray = new Uint8Array(grayBuf.buffer, grayBuf.byteOffset, grayBuf.byteLength);

        let minX = si.width, maxX = 0, minY = si.height, maxY = 0;
        for (let y = 0; y < si.height; y++) {
          for (let x = 0; x < si.width; x++) {
            if (gray[y * si.width + x]! < 100) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }

        const scaleX = origW / SW, scaleY = origH / SH;
        const PAD = 20;
        const left = Math.max(0, Math.round((minX - PAD) * scaleX));
        const top = Math.max(0, Math.round((minY - PAD) * scaleY));
        const cropW = Math.min(origW - left, Math.round((maxX - minX + PAD * 2) * scaleX));
        const cropH = Math.min(origH - top, Math.round((maxY - minY + PAD * 2) * scaleY));

        region =
          maxX > minX && maxY > minY
            ? { left, top, width: cropW, height: cropH }
            : { left: 0, top: 0, width: origW, height: origH };

        for (const angle of [0, 90, 180, 270] as const) {
          const outPath = path.join(preparedDir, `${base}_r${angle}.png`);
          await sharp(imgFile).extract(region).rotate(angle).png().toFile(outPath);
          preparedFiles.push(outPath);
        }
      }

      const worker = await Tesseract.createWorker('por');
      const texts: string[] = [];

      // Para cada página original, testa as 4 variantes e mantém a melhor.
      // Critério: maior ratio de palavras longas (qualidade), desempate por comprimento.
      for (let p = 0; p < files.length; p++) {
        const variants = preparedFiles.slice(p * 4, p * 4 + 4);
        let best = '';
        let bestRatio = 0;
        for (const imgFile of variants) {
          const r = await worker.recognize(imgFile);
          const t = r.data.text.trim();
          const words = t.match(/\p{L}+/gu) ?? [];
          const ratio = words.length > 0 ? words.filter((w) => w.length >= 4).length / words.length : 0;
          if (isUsableText(t) && (ratio > bestRatio || (ratio === bestRatio && t.length > best.length))) {
            best = t;
            bestRatio = ratio;
          }
        }
        if (best.length > 0) texts.push(best);
      }

      await worker.terminate();

      const fullText = texts.join('\n\n');
      return {
        fullText,
        pageCount: files.length,
        ocrPages: Array.from({ length: files.length }, (_, i) => i + 1),
        engine: 'unstructured',
        engineVersion: '0.0.0',
        durationMs: 0,
      };
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async callApi(
    fileBuffer: Buffer,
    filePath: string,
    mimeType: string,
    strategy: 'auto' | 'hi_res' | 'ocr_only'
  ): Promise<ExtractionResult> {
    const form = new FormData();
    form.append('files', fileBuffer, {
      filename: path.basename(filePath),
      contentType: mimeType,
    });
    form.append('include_page_breaks', 'true');
    form.append('strategy', strategy);
    if (strategy === 'hi_res' || strategy === 'ocr_only') {
      form.append('ocr_languages', 'por');
    }

    const formBuffer = form.getBuffer();
    const headers: Record<string, string> = { ...form.getHeaders() };
    if (this.config.apiKey) {
      headers['unstructured-api-key'] = this.config.apiKey;
    }

    let response: Response;
    try {
      response = await fetch(this.config.apiUrl, {
        method: 'POST',
        headers,
        body: formBuffer,
      });
    } catch (err) {
      throw new ExtractionError(
        `Network error calling Unstructured API: ${String(err)}`,
        mimeType,
        'unstructured',
        err
      );
    }

    const responseText = await response.text();

    if (!response.ok) {
      throw new UnstructuredApiError(response.status, responseText);
    }

    let elements: UnstructuredElement[];
    try {
      elements = JSON.parse(responseText) as UnstructuredElement[];
    } catch (err) {
      throw new ExtractionError(
        'Failed to parse Unstructured API response as JSON',
        mimeType,
        'unstructured',
        err
      );
    }

    const flat: UnstructuredElement[] = Array.isArray(elements[0])
      ? (elements as unknown as UnstructuredElement[][]).flat()
      : elements;

    const fullText = flat
      .filter((el) => typeof el.text === 'string' && el.text.trim().length > 0)
      .map((el) => el.text.trim())
      .join('\n\n');

    let maxPage = 0;
    for (const el of flat) {
      const pn = el.metadata.page_number;
      if (typeof pn === 'number' && pn > maxPage) maxPage = pn;
    }
    const pageCount = maxPage > 0 ? maxPage : 1;

    return {
      fullText,
      pageCount,
      ocrPages: [],
      engine: 'unstructured',
      engineVersion: '0.0.0',
      durationMs: 0,
    };
  }
}
