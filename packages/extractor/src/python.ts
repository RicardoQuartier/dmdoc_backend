import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import FormData from 'form-data';
import {
  type ExtractionResult,
  type ExtractorProvider,
  ExtractionError,
} from './types.js';

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

  constructor(config: PythonExtractorConfig) {
    this.config = config;
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
      response = await fetch(this.config.url, {
        method: 'POST',
        headers: form.getHeaders(),
        body: form.getBuffer(),
      });
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
