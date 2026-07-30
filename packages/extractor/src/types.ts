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
 * Entrada para extração de documento — endereça o arquivo por URL temporária.
 *
 * O extractor NÃO conhece o destino de armazenamento: quem chama resolve o
 * driver da empresa e entrega uma URL já autenticada, que o extractor apenas
 * baixa por HTTP. É o que permite extrair de S3, MinIO ou SharePoint sem que o
 * microserviço Python saiba de qual dos três se trata.
 */
export interface ExtractInput {
  /**
   * URL de download temporária, JÁ AUTENTICADA (presign do S3, link do Graph).
   * Precisa ser alcançável de dentro da rede do extractor — quem gera usa
   * `audience: 'internal'`, nunca `'browser'`.
   *
   * A validade tem de cobrir fila + processamento, não só o download: o pedido
   * pode esperar atrás de outra extração pesada antes de sair da fila.
   */
  fileUrl: string;
  mimeType: string;
  /**
   * Nome original do arquivo (`relatorio.docx`), com extensão.
   *
   * Campo PRÓPRIO, e não derivado da URL, de propósito: o extractor escolhe o
   * parser pelo MIME **ou** pela extensão, e uma URL assinada termina em query
   * string (`?X-Amz-Signature=...`) — derivar o nome dela faria a escolha de
   * parser falhar em silêncio nos formatos que dependem da extensão.
   */
  filename: string;
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
