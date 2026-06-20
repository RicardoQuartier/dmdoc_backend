/**
 * Resultado da extração de texto de um documento.
 */
export interface ExtractionResult {
  /** Texto completo extraído, parágrafos separados por \n\n. */
  fullText: string;
  /** Número total de páginas do documento. */
  pageCount: number;
  /**
   * Índices (1-based) das páginas que precisaram de OCR.
   * Vazio quando a extração foi puramente textual.
   */
  ocrPages: number[];
  /** Motor utilizado na extração. */
  engine: 'unstructured' | 'native';
  /** Versão do motor (e.g. "1.0.0" para native, versão da API para unstructured). */
  engineVersion: string;
  /** Duração total da extração em milissegundos. */
  durationMs: number;
}

/**
 * Entrada para extração de documento — endereça o arquivo via S3.
 * O extractor é responsável por buscar o conteúdo diretamente do storage.
 */
export interface ExtractInput {
  s3Key: string;
  s3Bucket: string;
  mimeType: string;
}

/**
 * Contrato de todo extrator de documentos.
 */
export interface ExtractorProvider {
  extract(input: ExtractInput): Promise<ExtractionResult>;
}

/**
 * Erro tipado para falhas de extração, carregando o MIME e o motor tentado.
 */
export class ExtractionError extends Error {
  public readonly mimeType: string;
  public readonly engine: 'unstructured' | 'native';

  constructor(
    message: string,
    mimeType: string,
    engine: 'unstructured' | 'native',
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = 'ExtractionError';
    this.mimeType = mimeType;
    this.engine = engine;
  }
}

/**
 * Erro lançado pelo UnstructuredExtractor quando a API HTTP retorna status != 2xx.
 */
export class UnstructuredApiError extends Error {
  public readonly status: number;
  public readonly body: string;

  constructor(status: number, body: string) {
    super(`Unstructured API returned HTTP ${status}`);
    this.name = 'UnstructuredApiError';
    this.status = status;
    this.body = body;
  }
}
