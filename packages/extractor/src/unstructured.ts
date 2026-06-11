import { exec } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import FormData from 'form-data';
import sharp from 'sharp';
import {
  type ExtractionResult,
  type ExtractorProvider,
  UnstructuredApiError,
  ExtractionError,
} from './types.js';
import { extractDocxImageText } from './docx-images.js';

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
 * Configuração do microserviço de OCR (EasyOCR) usado como motor de alta qualidade
 * para scans/imagens onde o Unstructured falha (documentos de identidade, certificados).
 *
 * Diferente de LLMs multimodais (gpt-4o), um motor de OCR dedicado NÃO recusa
 * documentos de identidade por política de PII e não alucina texto.
 */
export interface OcrServiceConfig {
  /** URL completa do endpoint, ex.: http://ocr:8000/ocr */
  url: string;
}

/** Resposta do microserviço de OCR. */
interface OcrServiceResponse {
  text: string;
  lineCount: number;
  avgConfidence: number;
}

/**
 * Configuração injetada pelo chamador.
 * O `apiKey` é opcional pois o Unstructured self-hosted pode não exigir auth.
 */
export interface UnstructuredExtractorConfig {
  /** URL completa do endpoint, ex.: http://localhost:8000/general/v0/general */
  apiUrl: string;
  apiKey?: string;
  /**
   * Microserviço de OCR para scans/imagens. Quando ausente, o extractor não tem
   * motor de alta qualidade — retorna o melhor resultado do Unstructured mesmo pobre.
   */
  ocrService?: OcrServiceConfig;
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

/** Resolução máxima enviada ao OCR (maior lado, em px). */
const OCR_MAX_DIMENSION = 2048;

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

/** Limiar de grayscale abaixo do qual um pixel conta como conteúdo (não-branco). */
const CONTENT_THRESHOLD = 220;
/** Largura do thumbnail usado na detecção de bbox. */
const CONTENT_THUMB_WIDTH = 200;
/** Mínimo de pixels não-brancos no thumbnail para confiar na detecção. */
const CONTENT_MIN_PIXELS = 50;

/**
 * Detecta a bounding box do conteúdo (região não-branca) de uma imagem.
 * Retorna null quando não há conteúdo suficiente ou quando o conteúdo já ocupa
 * praticamente toda a página (recorte seria inútil).
 */
async function detectContentRegion(
  imgFile: string
): Promise<{ left: number; top: number; width: number; height: number } | null> {
  const meta = await sharp(imgFile).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (W === 0 || H === 0) return null;

  const SW = CONTENT_THUMB_WIDTH;
  const SH = Math.max(1, Math.round((H / W) * SW));
  const { data, info } = await sharp(imgFile)
    .resize(SW, SH, { fit: 'fill' })
    .grayscale()
    .median(5) // remove pontos/sujeira isolados no branco
    .raw()
    .toBuffer({ resolveWithObject: true });

  let minX = info.width, maxX = -1, minY = info.height, maxY = -1, count = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[y * info.width + x]! < CONTENT_THRESHOLD) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (count < CONTENT_MIN_PIXELS || maxX <= minX || maxY <= minY) return null;

  const sx = W / info.width;
  const sy = H / info.height;
  const PAD = 4; // px do thumbnail
  const left = Math.max(0, Math.round((minX - PAD) * sx));
  const top = Math.max(0, Math.round((minY - PAD) * sy));
  const width = Math.min(W - left, Math.round((maxX - minX + PAD * 2) * sx));
  const height = Math.min(H - top, Math.round((maxY - minY + PAD * 2) * sy));

  if (width <= 0 || height <= 0) return null;
  // Conteúdo já preenche >95% da página — recorte não compensa.
  if (width * height >= W * H * 0.95) return null;

  return { left, top, width, height };
}

/**
 * Prepara uma imagem para o OCR: remove a borda branca (folha A4 em volta do
 * documento) e reescala para no máximo {@link OCR_MAX_DIMENSION}px no maior lado.
 *
 * Remover o branco é essencial para scans onde o documento ocupa parte da página
 * (card de RG num A4): sem isso, após o downscale o conteúdo fica minúsculo. A
 * detecção é por bbox de pixels não-brancos com filtro de mediana (elimina sujeira
 * isolada que travaria um trim simples). Se a detecção falhar ou o conteúdo já
 * preencher a página, envia a imagem inteira.
 */
async function prepareImageForOcr(imgFile: string): Promise<Buffer> {
  const region = await detectContentRegion(imgFile);
  const base = region ? sharp(imgFile).extract(region) : sharp(imgFile);
  return base
    .resize(OCR_MAX_DIMENSION, OCR_MAX_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/**
 * Extrator que delega ao serviço Unstructured rodando via HTTP.
 *
 * Pipeline para PDFs escaneados e imagens:
 * 1. `auto` — rápido, sem OCR forçado (cobre PDFs nativos digitais).
 * 2. `ocr_only` — Tesseract do Unstructured em toda a página (PDFs escaneados limpos).
 * 3. Microserviço de OCR (EasyOCR) — motor de alta qualidade para scans difíceis:
 *    documentos de identidade com fundo de segurança, foto embutida e rotação. Não
 *    recusa IDs (como LLMs fazem) e testa múltiplas rotações.
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

    const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const autoResult = await this.callApi(fileBuffer, filePath, mimeType, 'auto');

    // Para DOCX, complementa o texto da API com OCR das imagens embutidas (word/media/).
    // O Unstructured/auto não extrai imagens de DOCX — mammoth + tesseract.js cobrem o gap.
    if (mimeType === DOCX_MIME) {
      const imageText = await extractDocxImageText(filePath);
      if (imageText.length > 0) {
        const merged = [autoResult.fullText, imageText].filter(Boolean).join('\n\n');
        return {
          ...autoResult,
          fullText: merged,
          ocrPages: [1],
          durationMs: Date.now() - startMs,
        };
      }
      return { ...autoResult, durationMs: Date.now() - startMs };
    }

    if (isUsableText(autoResult.fullText)) {
      return { ...autoResult, durationMs: Date.now() - startMs };
    }

    // PDF escaneado limpo: tenta ocr_only (Tesseract em página inteira, sem detectron2)
    const ocrResult = await this.callApi(fileBuffer, filePath, mimeType, 'ocr_only');
    if (isUsableText(ocrResult.fullText)) {
      return {
        ...ocrResult,
        ocrPages: Array.from({ length: ocrResult.pageCount }, (_, i) => i + 1),
        durationMs: Date.now() - startMs,
      };
    }

    // Motor de alta qualidade: microserviço de OCR para scans/imagens difíceis.
    // Cobre documentos de identidade (RG, CNH), certificados, fotos de documentos —
    // casos onde o OCR clássico falha por fundo de segurança, layout misto ou rotação.
    const isImage = mimeType === 'image/jpeg' || mimeType === 'image/png';
    if (this.config.ocrService && (mimeType === 'application/pdf' || isImage)) {
      try {
        const svcResult = await this.ocrWithService(filePath, mimeType);
        if (svcResult !== null && isUsableText(svcResult.fullText)) {
          return { ...svcResult, durationMs: Date.now() - startMs };
        }
      } catch (err) {
        process.stderr.write(`[dmdoc] OCR service error: ${String(err)}\n`);
      }
    }

    // Retorna o melhor resultado disponível (pode ser texto curto/inútil)
    const best = ocrResult.fullText.length >= autoResult.fullText.length ? ocrResult : autoResult;
    return {
      ...best,
      ocrPages: Array.from({ length: best.pageCount }, (_, i) => i + 1),
      durationMs: Date.now() - startMs,
    };
  }

  /**
   * OCR via microserviço HTTP (EasyOCR).
   *
   * Para PDF: converte cada página em PNG via pdftoppm (requer poppler-utils) e envia
   * uma requisição por página. Para imagens (JPEG/PNG): envia o arquivo diretamente.
   * Cada imagem passa por {@link prepareImageForOcr} (remove branco + reescala).
   *
   * Retorna null se o serviço não estiver configurado ou se nenhuma página produzir texto.
   */
  private async ocrWithService(
    filePath: string,
    mimeType: string
  ): Promise<ExtractionResult | null> {
    const svc = this.config.ocrService;
    if (!svc) return null;

    const isImage = mimeType === 'image/jpeg' || mimeType === 'image/png';
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'dmdoc-ocr-'));
    try {
      let imageFiles: string[];

      if (isImage) {
        imageFiles = [filePath];
      } else {
        try {
          await execAsync('which pdftoppm');
        } catch {
          process.stderr.write('[dmdoc] pdftoppm não encontrado, pulando OCR service\n');
          return null;
        }
        const prefix = path.join(tmpDir, 'page');
        await execAsync(`pdftoppm -r 150 -png "${filePath}" "${prefix}"`);
        imageFiles = (await readdir(tmpDir))
          .filter((f) => f.endsWith('.png'))
          .sort()
          .map((f) => path.join(tmpDir, f));
      }

      if (imageFiles.length === 0) return null;
      process.stderr.write(`[dmdoc] OCR service: ${imageFiles.length} página(s)\n`);

      const texts: string[] = [];
      for (const imgFile of imageFiles) {
        const prepared = await prepareImageForOcr(imgFile);
        const form = new FormData();
        form.append('file', prepared, { filename: 'page.jpg', contentType: 'image/jpeg' });

        const response = await fetch(svc.url, {
          method: 'POST',
          headers: form.getHeaders(),
          body: form.getBuffer(),
        });
        if (!response.ok) {
          process.stderr.write(`[dmdoc] OCR service HTTP ${response.status}\n`);
          continue;
        }
        const json = (await response.json()) as OcrServiceResponse;
        const text = (json.text ?? '').trim();
        process.stderr.write(
          `[dmdoc] OCR service: lines=${json.lineCount ?? 0} conf=${(json.avgConfidence ?? 0).toFixed(2)} len=${text.length}\n`
        );
        if (text.length > 0) texts.push(text);
      }

      if (texts.length === 0) return null;

      return {
        fullText: texts.join('\n\n'),
        pageCount: imageFiles.length,
        ocrPages: Array.from({ length: imageFiles.length }, (_, i) => i + 1),
        engine: 'unstructured',
        engineVersion: 'easyocr',
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
    strategy: 'auto' | 'ocr_only'
  ): Promise<ExtractionResult> {
    const form = new FormData();
    form.append('files', fileBuffer, {
      filename: path.basename(filePath),
      contentType: mimeType,
    });
    form.append('include_page_breaks', 'true');
    form.append('strategy', strategy);
    if (strategy === 'ocr_only') {
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
