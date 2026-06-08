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
 * Extrator que delega ao serviço Unstructured rodando via HTTP.
 *
 * Envia o arquivo como multipart/form-data e mapeia o array de elementos
 * para `ExtractionResult`. Lança `UnstructuredApiError` se o status HTTP
 * não for 2xx e `ExtractionError` para erros de rede ou MIME não suportado.
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

    // Lê o arquivo completo para um Buffer antes de montar o form-data.
    // Isso evita o uso de streams dentro do FormData, que incompatibiliza
    // com form.getBuffer() e com o fetch nativo do Node.
    const fileBuffer = await readFile(filePath);

    const form = new FormData();
    form.append('files', fileBuffer, {
      filename: basename(filePath),
      contentType: mimeType,
    });
    // Solicita coordenadas de página para determinar page_number corretamente
    form.append('include_page_breaks', 'true');
    form.append('strategy', 'auto');

    const formBuffer = form.getBuffer();
    const headers: Record<string, string> = {
      ...form.getHeaders(),
    };
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

    // Garante array (a API pode retornar elementos aninhados por arquivo)
    const flat: UnstructuredElement[] = Array.isArray(elements[0])
      ? (elements as unknown as UnstructuredElement[][]).flat()
      : elements;

    // Concatena textos, separando por parágrafo duplo
    const fullText = flat
      .filter((el) => typeof el.text === 'string' && el.text.trim().length > 0)
      .map((el) => el.text.trim())
      .join('\n\n');

    // Determina pageCount pelo maior page_number encontrado
    let maxPage = 0;
    for (const el of flat) {
      const pn = el.metadata.page_number;
      if (typeof pn === 'number' && pn > maxPage) {
        maxPage = pn;
      }
    }
    const pageCount = maxPage > 0 ? maxPage : 1;

    const durationMs = Date.now() - startMs;

    return {
      fullText,
      pageCount,
      ocrPages: [], // Unstructured não expõe quais páginas usaram OCR internamente
      engine: 'unstructured',
      engineVersion: '0.0.0', // versão do serviço — não exposta pela API free-tier
      durationMs,
    };
  }
}
