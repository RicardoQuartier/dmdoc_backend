import { PythonExtractor, type PythonExtractorConfig } from './python.js';
import { type ExtractorProvider } from './types.js';

export type ExtractorType = 'python';

export interface ExtractorConfig {
  type: ExtractorType;
  /** Obrigatório quando type === 'python'. */
  python?: PythonExtractorConfig;
}

/**
 * Fábrica de extractores.
 *
 * Toda a extração é delegada ao microserviço Python (PyMuPDF/docx/xlsx/pptx +
 * EasyOCR), que cobre todos os formatos em dev e prod. A configuração é sempre
 * injetada pelo chamador (worker/config.ts via Zod); este pacote nunca lê
 * `process.env` diretamente.
 *
 * @example
 * ```ts
 * const extractor = createExtractor({
 *   type: 'python',
 *   python: { url: env.EXTRACTOR_URL },
 * });
 * const result = await extractor.extract('/tmp/doc.pdf', 'application/pdf');
 * ```
 */
export function createExtractor(config: ExtractorConfig): ExtractorProvider {
  switch (config.type) {
    case 'python': {
      const pythonConfig = config.python;
      if (!pythonConfig) {
        throw new Error('createExtractor: python config is required when type is "python"');
      }
      return new PythonExtractor(pythonConfig);
    }

    default: {
      // Garante exhaustiveness em TypeScript
      const _exhaustive: never = config.type;
      throw new Error(`createExtractor: unknown extractor type "${String(_exhaustive)}"`);
    }
  }
}
