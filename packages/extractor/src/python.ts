import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import FormData from 'form-data';
import { Agent } from 'undici';
import {
  type ExtractionResult,
  type ExtractorProvider,
  ExtractionError,
} from './types.js';

/**
 * Timeout padrão da chamada ao extractor, em milissegundos.
 *
 * O motor de OCR (EasyOCR) roda em CPU em dev e pode levar vários minutos por
 * documento. O `headersTimeout`/`bodyTimeout` padrão do undici (300s) é curto
 * demais e fazia o worker abortar com `HeadersTimeoutError` mesmo quando o
 * extractor concluía a extração. 10 minutos dá folga suficiente.
 */
const DEFAULT_EXTRACTOR_TIMEOUT_MS = 600_000;

/**
 * Configuração do microserviço de extração em Python (DMDoc Extractor).
 *
 * Esse serviço unifica a extração de TODOS os formatos (PDF, imagens, DOCX, XLSX,
 * PPTX) com OCR de alta qualidade (EasyOCR), substituindo o Unstructured e o
 * NativeExtractor. O worker Node atua só como cliente HTTP fino.
 */
export interface PythonExtractorConfig {
  /** URL completa do endpoint, ex.: http://extractor:8000/extract */
  url: string;
  /**
   * Timeout total da requisição em ms. Cobre headers e corpo da resposta.
   * Default: 600000 (10 min) — OCR em CPU é lento. Use 0 para desabilitar.
   */
  timeoutMs?: number;
}

/** Resposta do microserviço de extração. */
interface PythonExtractResponse {
  text: string;
  pageCount: number;
  ocrPages: number[];
  engine?: string;
  error?: string;
}

/**
 * Extrator que delega toda a extração de texto a um microserviço Python via HTTP.
 *
 * Mantém o worker leve e desacoplado: o contrato é um POST multipart (arquivo +
 * content_type) que devolve `{ text, pageCount, ocrPages }`. Trocar o motor de OCR
 * ou de parsing acontece só do lado Python, sem tocar no TypeScript.
 */
export class PythonExtractor implements ExtractorProvider {
  private readonly config: PythonExtractorConfig;
  private readonly dispatcher: Agent;

  constructor(config: PythonExtractorConfig) {
    this.config = config;
    const timeoutMs = config.timeoutMs ?? DEFAULT_EXTRACTOR_TIMEOUT_MS;
    // Dispatcher dedicado: amplia os timeouts de headers e corpo do undici,
    // que por padrão (300s) abortavam extrações de OCR longas.
    this.dispatcher = new Agent({
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
  }

  async extract(filePath: string, mimeType: string): Promise<ExtractionResult> {
    const startMs = Date.now();
    const fileBuffer = await readFile(filePath);

    const form = new FormData();
    form.append('file', fileBuffer, {
      filename: path.basename(filePath),
      contentType: mimeType,
    });
    form.append('content_type', mimeType);

    let response: Response;
    try {
      // `dispatcher` não faz parte do tipo padrão RequestInit, mas é suportado
      // pelo fetch do undici (Node). Cast via unknown para anexá-lo.
      response = await fetch(this.config.url, {
        method: 'POST',
        headers: form.getHeaders(),
        body: form.getBuffer(),
        dispatcher: this.dispatcher,
      } as unknown as RequestInit);
    } catch (err) {
      throw new ExtractionError(
        `Network error calling extractor service: ${String(err)}`,
        mimeType,
        'native',
        err
      );
    }

    const responseText = await response.text();
    if (!response.ok) {
      throw new ExtractionError(
        `Extractor service returned HTTP ${response.status}: ${responseText.slice(0, 500)}`,
        mimeType,
        'native'
      );
    }

    let json: PythonExtractResponse;
    try {
      json = JSON.parse(responseText) as PythonExtractResponse;
    } catch (err) {
      throw new ExtractionError(
        'Failed to parse extractor service response as JSON',
        mimeType,
        'native',
        err
      );
    }

    if (json.error) {
      throw new ExtractionError(`Extractor service error: ${json.error}`, mimeType, 'native');
    }

    return {
      fullText: (json.text ?? '').trim(),
      pageCount: typeof json.pageCount === 'number' && json.pageCount > 0 ? json.pageCount : 1,
      ocrPages: Array.isArray(json.ocrPages) ? json.ocrPages : [],
      engine: 'native',
      engineVersion: 'python-extractor',
      durationMs: Date.now() - startMs,
    };
  }
}
