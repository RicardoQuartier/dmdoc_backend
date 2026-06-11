import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Configuração necessária para construir o cliente S3.
 * Lida do `config.ts` — nunca `process.env.X` direto.
 */
export interface S3Config {
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Endpoint alternativo para MinIO em dev ou Cloudflare R2 em prod. */
  endpoint?: string;
  /**
   * Endpoint público para assinar URLs de download. Em dev o `endpoint` é o host
   * interno do Docker (http://minio:9000), que o navegador não alcança — as URLs
   * assinadas precisam do host publicado (http://localhost:5054). Quando ausente,
   * o presign usa o mesmo `endpoint`.
   */
  publicEndpoint?: string;
  /** true para MinIO (path-style obrigatório). false para AWS S3 e Cloudflare R2. */
  forcePathStyle?: boolean;
}

/**
 * Serviço de storage S3. Encapsula o SDK v3 da AWS e expõe operações de
 * alto nível usadas pelas rotas (upload, presigned download, delete).
 *
 * O `S3Client` é criado a partir da `S3Config` injetada — o serviço nunca
 * lê `process.env` diretamente (convenção do projeto, spec §12).
 */
export class S3Service {
  private readonly client: S3Client;
  /**
   * Cliente usado APENAS para assinar URLs de download — configurado com o
   * endpoint público (browser-reachable). Igual ao `client` quando não há
   * `publicEndpoint` (ex.: produção com AWS/R2).
   */
  private readonly presignClient: S3Client;
  private readonly bucket: string;

  constructor(config: S3Config) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      ...(config.endpoint !== undefined
        ? {
            endpoint: config.endpoint,
            forcePathStyle: config.forcePathStyle ?? false,
          }
        : {}),
    });

    this.presignClient =
      config.publicEndpoint !== undefined
        ? new S3Client({
            region: config.region,
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
            endpoint: config.publicEndpoint,
            forcePathStyle: config.forcePathStyle ?? false,
          })
        : this.client;
  }

  /**
   * Faz upload de um buffer para o S3.
   *
   * @param key      Chave de objeto no bucket (ex.: `tenants/{t}/documents/{sha}/{name}`)
   * @param buffer   Conteúdo do arquivo
   * @param mimeType Content-Type a gravar nos metadados do objeto
   */
  async uploadFile(params: {
    key: string;
    buffer: Buffer;
    mimeType: string;
  }): Promise<void> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: params.key,
      Body: params.buffer,
      ContentType: params.mimeType,
    });
    await this.client.send(command);
  }

  /**
   * Gera uma URL pré-assinada para download do objeto.
   *
   * @param key             Chave do objeto no bucket
   * @param expiresInSeconds Validade em segundos (padrão: 3600 = 1 hora)
   */
  async getSignedDownloadUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    return getSignedUrl(this.presignClient, command, { expiresIn: expiresInSeconds });
  }

  /**
   * Remove um objeto do S3.
   * Usado em rollback: se o insert no Mongo falhar após o upload, o arquivo
   * é removido do bucket para evitar objetos órfãos.
   */
  async deleteFile(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    await this.client.send(command);
  }
}

/**
 * Factory que cria um `S3Service` a partir da config carregada pelo `config.ts`.
 */
export function createS3Service(config: S3Config): S3Service {
  return new S3Service(config);
}
