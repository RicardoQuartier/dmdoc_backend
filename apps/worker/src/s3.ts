import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  type ObjectIdentifier,
} from '@aws-sdk/client-s3';
import { type Config } from './config.js';

/**
 * Limite máximo de chaves por `DeleteObjectsCommand` imposto pela API do S3.
 * Iteramos a listagem em páginas e apagamos em lotes de até este tamanho.
 */
const S3_DELETE_BATCH_LIMIT = 1000;

/**
 * Helper de storage do worker, focado nas operações de purga de empresa.
 *
 * Espelha a configuração do `S3Service` da API (region, credentials, endpoint
 * opcional para MinIO/R2, forcePathStyle), porém só expõe o que o worker precisa:
 * a remoção em massa de todos os objetos sob um prefixo (`tenants/{id}/`).
 *
 * O `S3Client` é construído a partir da `Config` (Zod) — nunca lê `process.env`
 * diretamente (convenção do projeto, spec §14).
 */
export class WorkerS3 {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: Config) {
    this.bucket = config.AWS_S3_BUCKET;
    this.client = new S3Client({
      region: config.AWS_REGION,
      credentials: {
        accessKeyId: config.AWS_ACCESS_KEY_ID ?? '',
        secretAccessKey: config.AWS_SECRET_ACCESS_KEY ?? '',
      },
      ...(config.S3_ENDPOINT !== undefined
        ? {
            endpoint: config.S3_ENDPOINT,
            forcePathStyle: config.S3_FORCE_PATH_STYLE,
          }
        : {}),
    });
  }

  /**
   * Remove TODOS os objetos sob um prefixo no bucket (ex.: `tenants/{id}/`).
   *
   * Pagina a listagem com `ListObjectsV2Command` (`ContinuationToken`) e apaga
   * cada página com `DeleteObjectsCommand` em lotes de até 1000 chaves. Um
   * prefixo sem objetos é tratado como no-op (retorna sem erro) — caso comum em
   * purga idempotente reexecutada ou tenant sem arquivos.
   */
  async deleteByPrefix(prefix: string): Promise<void> {
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

/**
 * Factory que cria um `WorkerS3` a partir da `Config` carregada pelo `config.ts`.
 */
export function createWorkerS3(config: Config): WorkerS3 {
  return new WorkerS3(config);
}
