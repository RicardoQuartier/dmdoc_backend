import { UnstructuredExtractor, type UnstructuredExtractorConfig } from './unstructured.js';
import { NativeExtractor } from './native.js';
import { type ExtractorProvider } from './types.js';

export type ExtractorType = 'unstructured' | 'native';

export interface ExtractorConfig {
  type: ExtractorType;
  /** Obrigatório quando type === 'unstructured'. */
  unstructured?: UnstructuredExtractorConfig;
}

/**
 * Fábrica de extractores.
 *
 * Lê `config.type` para decidir qual implementação instanciar.
 * A configuração é sempre injetada pelo chamador (worker/config.ts via Zod).
 * Este pacote nunca lê `process.env` diretamente.
 *
 * @example
 * ```ts
 * const extractor = createExtractor({
 *   type: 'unstructured',
 *   unstructured: { apiUrl: env.UNSTRUCTURED_URL, apiKey: env.UNSTRUCTURED_API_KEY },
 * });
 * const result = await extractor.extract('/tmp/doc.pdf', 'application/pdf');
 * ```
 */
export function createExtractor(config: ExtractorConfig): ExtractorProvider {
  switch (config.type) {
    case 'unstructured': {
      const unstructuredConfig = config.unstructured;
      if (!unstructuredConfig) {
        throw new Error(
          'createExtractor: unstructured config is required when type is "unstructured"'
        );
      }
      return new UnstructuredExtractor(unstructuredConfig);
    }

    case 'native':
      return new NativeExtractor();

    default: {
      // Garante exhaustiveness em TypeScript
      const _exhaustive: never = config.type;
      throw new Error(`createExtractor: unknown extractor type "${String(_exhaustive)}"`);
    }
  }
}
