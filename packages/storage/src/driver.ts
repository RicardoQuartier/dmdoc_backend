/**
 * Contrato comum de armazenamento de arquivos.
 *
 * O DMDoc guarda os documentos de cada empresa em um destino configurável
 * (bucket S3 da plataforma, bucket próprio do cliente, SharePoint do cliente).
 * Toda leitura e escrita de arquivo passa por esta interface — nenhuma rota,
 * worker ou serviço fala com o SDK de um provedor específico.
 */

/** Provedores de armazenamento suportados. */
export type StorageProvider = 's3' | 'sharepoint';

/**
 * Para quem a URL de download precisa funcionar.
 *
 * - `browser`: a URL vai para o navegador do usuário. Em desenvolvimento o
 *   MinIO responde no host publicado (`http://localhost:5054`), não no host
 *   interno da rede Docker.
 * - `internal`: a URL é consumida por outro contêiner (o extractor Python), que
 *   alcança o host interno (`http://minio:9000`) e **não** alcança o publicado.
 *
 * Usar o valor errado produz uma falha que só aparece em desenvolvimento e cuja
 * causa não é óbvia, por isso o parâmetro é obrigatório.
 */
export type UrlAudience = 'browser' | 'internal';

export interface PutParams {
  /** Chave do objeto — `tenants/{tenantId}/documents/{contentHash}/{filename}`. */
  key: string;
  buffer: Buffer;
  mimeType: string;
}

export interface DownloadUrlOptions {
  expiresInSeconds: number;
  /**
   * Valor do header `Content-Disposition` a embutir na URL. Quando presente, o
   * provedor injeta o header na resposta — usado para forçar download com nome
   * de arquivo (`attachment; filename="..."`) em vez de abrir inline.
   */
  contentDisposition?: string;
  audience: UrlAudience;
}

/**
 * Um destino de armazenamento já configurado e pronto para uso.
 *
 * Uma instância é sempre específica de uma empresa: quem a constrói
 * (`resolveStorageDriver`) já resolveu de onde vêm as credenciais.
 */
export interface StorageDriver {
  readonly provider: StorageProvider;

  put(params: PutParams): Promise<void>;

  /** Baixa o objeto inteiro em memória. Usado na conversão de preview e na migração de acervo. */
  get(key: string): Promise<Buffer>;

  /** URL temporária que baixa o objeto sem exigir credencial de quem acessa. */
  getDownloadUrl(key: string, options: DownloadUrlOptions): Promise<string>;

  delete(key: string): Promise<void>;

  /**
   * Remove tudo sob um prefixo (ex.: `tenants/{id}/`), usado na purga de empresa.
   * Prefixo sem nenhum objeto é no-op — purga idempotente reexecutada e empresa
   * sem arquivos são casos normais, não erro.
   */
  deletePrefix(prefix: string): Promise<void>;
}
