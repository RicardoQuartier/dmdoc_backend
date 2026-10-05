import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  type ObjectIdentifier,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream } from 'node:fs';

import type {
  DownloadUrlOptions,
  PutFileParams,
  PutParams,
  StorageDriver,
  StorageProvider,
} from './driver.js';
import { assertLocalFileSize } from './file-source.js';

/**
 * Configuração necessária para construir o cliente S3.
 *
 * Serve tanto ao bucket da plataforma (valores vindos do `config.ts`) quanto ao
 * bucket próprio de uma empresa (valores vindos de `tenant_storage_configs`) —
 * o driver não sabe nem precisa saber a origem.
 */
export interface S3Config {
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Endpoint alternativo para MinIO em dev ou Cloudflare R2 em prod. */
  endpoint?: string;
  /**
   * Endpoint público para assinar URLs destinadas ao navegador. Em dev o
   * `endpoint` é o host interno do Docker (http://minio:9000), que o navegador
   * não alcança — as URLs assinadas precisam do host publicado
   * (http://localhost:5054). Quando ausente, o presign usa o mesmo `endpoint`.
   */
  publicEndpoint?: string;
  /** true para MinIO (path-style obrigatório). false para AWS S3 e Cloudflare R2. */
  forcePathStyle?: boolean;
}

/**
 * Limite máximo de chaves por `DeleteObjectsCommand` imposto pela API do S3.
 * A listagem é paginada e cada página é apagada em lotes de até este tamanho.
 */
const S3_DELETE_BATCH_LIMIT = 1000;

/**
 * Tamanho de cada parte do multipart upload do `putFile`. 10 MiB fica acima do
 * mínimo de 5 MiB do S3 e, com o teto de 10.000 partes, cobre objetos de até
 * ~100 GB — muito além de `MAX_UPLOAD_MB`.
 */
const PUT_FILE_PART_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Partes enviadas em paralelo pelo `putFile`. A memória do envio fica limitada
 * a ~`queueSize × partSize` (20 MiB), qualquer que seja o tamanho do arquivo.
 */
const PUT_FILE_QUEUE_SIZE = 2;

/**
 * Driver de armazenamento sobre o protocolo S3 — atende AWS S3, Cloudflare R2 e
 * MinIO, que só diferem em endpoint e path-style.
 *
 * O `S3Client` é criado a partir da `S3Config` injetada: o driver nunca lê
 * `process.env` diretamente (convenção do projeto, spec §12).
 */
export class S3Driver implements StorageDriver {
  readonly provider: StorageProvider = 's3';

  private readonly client: S3Client;
  /**
   * Cliente usado apenas para assinar URLs destinadas ao navegador —
   * configurado com o endpoint público. É o mesmo objeto que `client` quando
   * não há `publicEndpoint` (ex.: produção com AWS/R2).
   */
  private readonly presignClient: S3Client;
  private readonly bucket: string;

  constructor(config: S3Config) {
    this.bucket = config.bucket;

    const credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };

    this.client = new S3Client({
      region: config.region,
      credentials,
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
            credentials,
            endpoint: config.publicEndpoint,
            forcePathStyle: config.forcePathStyle ?? false,
          })
        : this.client;
  }

  async put(params: PutParams): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: params.key,
        Body: params.buffer,
        ContentType: params.mimeType,
      })
    );
  }

  /**
   * Envio por stream a partir do disco. Arquivo menor que uma parte vira um
   * `PutObject` simples (o `Upload` decide sozinho); maior vira multipart
   * upload, abortado pelo próprio `Upload` se uma parte falhar — não sobra
   * upload incompleto cobrando armazenamento no bucket.
   *
   * Usa o cliente interno, nunca o `presignClient` (que aponta para o
   * endpoint público, inalcançável de dentro da rede Docker em dev).
   */
  async putFile(params: PutFileParams): Promise<void> {
    await assertLocalFileSize(params.path, params.sizeBytes, this.provider);

    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: params.key,
        Body: createReadStream(params.path),
        ContentType: params.mimeType,
      },
      partSize: PUT_FILE_PART_SIZE_BYTES,
      queueSize: PUT_FILE_QUEUE_SIZE,
      leavePartsOnError: false,
    });
    await upload.done();
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key })
    );
    if (!response.Body) throw new Error(`objeto S3 não encontrado: ${key}`);

    const chunks: Uint8Array[] = [];
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async getDownloadUrl(key: string, options: DownloadUrlOptions): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(options.contentDisposition !== undefined && {
        ResponseContentDisposition: options.contentDisposition,
      }),
    });

    // `internal` assina com o cliente do endpoint interno; `browser`, com o
    // público (que cai no mesmo cliente quando não há publicEndpoint).
    const signer = options.audience === 'internal' ? this.client : this.presignClient;

    return getSignedUrl(signer, command, { expiresIn: options.expiresInSeconds });
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key })
    );
  }

  /**
   * Pagina a listagem com `ListObjectsV2Command` (`ContinuationToken`) e apaga
   * cada página com `DeleteObjectsCommand` em lotes de até 1000 chaves.
   */
  async deletePrefix(prefix: string): Promise<void> {
    let continuationToken: string | undefined;

    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
          MaxKeys: S3_DELETE_BATCH_LIMIT,
        })
      );

      const objects: ObjectIdentifier[] = (listed.Contents ?? [])
        .map((obj) => obj.Key)
        .filter((key): key is string => key !== undefined)
        .map((Key) => ({ Key }));

      if (objects.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: objects, Quiet: true },
          })
        );
      }

      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);
  }
}

/** Factory que cria um `S3Driver` a partir de uma `S3Config` já resolvida. */
export function createS3Driver(config: S3Config): S3Driver {
  return new S3Driver(config);
}
