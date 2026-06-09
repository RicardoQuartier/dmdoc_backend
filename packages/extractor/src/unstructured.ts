import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import FormData from 'form-data';
import { type ExtractionResult, type ExtractorProvider, UnstructuredApiError, ExtractionError } from './types.js';

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

/**
 * Mínimo de caracteres para considerar que a extração com strategy=auto
 * produziu texto útil. Abaixo disso o documento provavelmente é uma imagem
 * escaneada e o fallback hi_res (OCR forçado) será acionado.
 */
const MIN_TEXT_LENGTH_AUTO = 50;

/**
 * Extrator que delega ao serviço Unstructured rodando via HTTP.
 *
 * Estratégia de extração em dois níveis:
 * 1. Tenta `auto` (rápido, sem OCR forçado).
 * 2. Se o texto extraído for menor que MIN_TEXT_LENGTH_AUTO (indica PDF
 *    escaneado / sem camada de texto), re-tenta com `hi_res` que aciona
 *    Tesseract via detectron2 para layout + OCR completo.
 *
 * Lança `UnstructuredApiError` se o status HTTP não for 2xx e
 * `ExtractionError` para erros de rede ou MIME não suportado.
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

    if (autoResult.fullText.length >= MIN_TEXT_LENGTH_AUTO) {
      return { ...autoResult, durationMs: Date.now() - startMs };
    }

    // Texto insuficiente — provável PDF escaneado. Re-tenta com hi_res (OCR forçado).
    const hiResResult = await this.callApi(fileBuffer, filePath, mimeType, 'hi_res');
    return {
      ...hiResResult,
      // Marca todas as páginas como OCR quando hi_res foi necessário
      ocrPages: Array.from({ length: hiResResult.pageCount }, (_, i) => i + 1),
      durationMs: Date.now() - startMs,
    };
  }

  private async callApi(
    fileBuffer: Buffer,
    filePath: string,
    mimeType: string,
    strategy: 'auto' | 'hi_res'
  ): Promise<ExtractionResult> {
    const form = new FormData();
    form.append('files', fileBuffer, {
      filename: basename(filePath),
      contentType: mimeType,
    });
    form.append('include_page_breaks', 'true');
    form.append('strategy', strategy);
    // hi_res aciona OCR (Tesseract); especifica português para melhor acurácia
    if (strategy === 'hi_res') {
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
      durationMs: 0, // preenchido pelo chamador com o tempo total
    };
  }
}
