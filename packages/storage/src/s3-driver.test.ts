import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Testes do driver S3.
 *
 * O `@aws-sdk/client-s3` é mockado: capturamos os comandos enviados via
 * `S3Client.send` e validamos a paginação (ContinuationToken) e o lote de
 * deletes — sem abrir socket real.
 *
 * Migrado de `apps/worker/src/s3.test.ts` quando `WorkerS3` e `S3Service`
 * foram fundidos neste driver.
 */

// `vi.hoisted` é obrigatório aqui: as factories de `vi.mock` são içadas para o
// topo do arquivo e não enxergam `const` declaradas normalmente.
const { sendMock, getSignedUrlMock, createdClients } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  getSignedUrlMock: vi.fn(),
  /** Instâncias criadas, na ordem: [0] cliente interno, [1] cliente de presign público. */
  createdClients: [] as Array<{ config: Record<string, unknown> }>,
}));

vi.mock('@aws-sdk/client-s3', () => {
  class ListObjectsV2Command {
    constructor(public input: unknown) {}
  }
  class DeleteObjectsCommand {
    constructor(public input: unknown) {}
  }
  class DeleteObjectCommand {
    constructor(public input: unknown) {}
  }
  class PutObjectCommand {
    constructor(public input: unknown) {}
  }
  class GetObjectCommand {
    constructor(public input: unknown) {}
  }
  class S3Client {
    send = sendMock;
    constructor(public config: Record<string, unknown>) {
      createdClients.push(this);
    }
  }
  return {
    S3Client,
    ListObjectsV2Command,
    DeleteObjectsCommand,
    DeleteObjectCommand,
    PutObjectCommand,
    GetObjectCommand,
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: getSignedUrlMock,
}));

import { ListObjectsV2Command, DeleteObjectsCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createS3Driver, type S3Config } from './s3-driver.js';

const baseConfig: S3Config = {
  region: 'us-east-1',
  bucket: 'test-bucket',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
};

beforeEach(() => {
  sendMock.mockReset();
  getSignedUrlMock.mockReset();
  createdClients.length = 0;
});

describe('S3Driver.deletePrefix', () => {
  it('não envia delete quando o prefixo está vazio', async () => {
    sendMock.mockResolvedValueOnce({ Contents: [], IsTruncated: false });

    await createS3Driver(baseConfig).deletePrefix('tenants/abc/');

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[0]).toBeInstanceOf(ListObjectsV2Command);
  });

  it('apaga em lote os objetos de uma única página', async () => {
    sendMock
      .mockResolvedValueOnce({
        Contents: [{ Key: 'tenants/abc/a' }, { Key: 'tenants/abc/b' }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({});

    await createS3Driver(baseConfig).deletePrefix('tenants/abc/');

    expect(sendMock).toHaveBeenCalledTimes(2);
    const deleteCmd = sendMock.mock.calls[1]?.[0] as DeleteObjectsCommand;
    expect(deleteCmd).toBeInstanceOf(DeleteObjectsCommand);
    expect((deleteCmd.input as { Delete: { Objects: unknown[] } }).Delete.Objects).toEqual([
      { Key: 'tenants/abc/a' },
      { Key: 'tenants/abc/b' },
    ]);
  });

  it('pagina via ContinuationToken até esgotar os objetos', async () => {
    sendMock
      .mockResolvedValueOnce({
        Contents: [{ Key: 'tenants/abc/a' }],
        IsTruncated: true,
        NextContinuationToken: 'tok-1',
      })
      .mockResolvedValueOnce({}) // delete página 1
      .mockResolvedValueOnce({
        Contents: [{ Key: 'tenants/abc/b' }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({}); // delete página 2

    await createS3Driver(baseConfig).deletePrefix('tenants/abc/');

    expect(sendMock).toHaveBeenCalledTimes(4);
    const secondList = sendMock.mock.calls[2]?.[0] as ListObjectsV2Command;
    expect(secondList).toBeInstanceOf(ListObjectsV2Command);
    expect((secondList.input as { ContinuationToken?: string }).ContinuationToken).toBe('tok-1');
  });
});

describe('S3Driver.put', () => {
  it('envia buffer e content-type para a chave informada', async () => {
    sendMock.mockResolvedValueOnce({});

    await createS3Driver(baseConfig).put({
      key: 'tenants/abc/documents/hash/nota.pdf',
      buffer: Buffer.from('conteudo'),
      mimeType: 'application/pdf',
    });

    const cmd = sendMock.mock.calls[0]?.[0] as PutObjectCommand;
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input).toMatchObject({
      Bucket: 'test-bucket',
      Key: 'tenants/abc/documents/hash/nota.pdf',
      ContentType: 'application/pdf',
    });
  });
});

describe('S3Driver.getDownloadUrl', () => {
  it('assina com o endpoint público quando a URL é para o navegador', async () => {
    getSignedUrlMock.mockResolvedValueOnce('https://publico/assinada');

    const driver = createS3Driver({
      ...baseConfig,
      endpoint: 'http://minio:9000',
      publicEndpoint: 'http://localhost:5054',
    });
    await driver.getDownloadUrl('k', { expiresInSeconds: 300, audience: 'browser' });

    // [0] cliente interno, [1] cliente de presign público
    expect(getSignedUrlMock.mock.calls[0]?.[0]).toBe(createdClients[1]);
  });

  it('assina com o endpoint interno quando a URL é para outro contêiner', async () => {
    getSignedUrlMock.mockResolvedValueOnce('http://minio:9000/assinada');

    const driver = createS3Driver({
      ...baseConfig,
      endpoint: 'http://minio:9000',
      publicEndpoint: 'http://localhost:5054',
    });
    await driver.getDownloadUrl('k', { expiresInSeconds: 300, audience: 'internal' });

    expect(getSignedUrlMock.mock.calls[0]?.[0]).toBe(createdClients[0]);
  });

  it('usa o mesmo cliente para as duas audiências quando não há endpoint público', async () => {
    getSignedUrlMock.mockResolvedValue('https://assinada');

    const driver = createS3Driver(baseConfig);
    await driver.getDownloadUrl('k', { expiresInSeconds: 300, audience: 'browser' });
    await driver.getDownloadUrl('k', { expiresInSeconds: 300, audience: 'internal' });

    expect(createdClients).toHaveLength(1);
    expect(getSignedUrlMock.mock.calls[0]?.[0]).toBe(getSignedUrlMock.mock.calls[1]?.[0]);
  });

  it('embute o Content-Disposition quando informado', async () => {
    getSignedUrlMock.mockResolvedValueOnce('https://assinada');

    await createS3Driver(baseConfig).getDownloadUrl('k', {
      expiresInSeconds: 300,
      audience: 'browser',
      contentDisposition: 'attachment; filename="nota.pdf"',
    });

    const cmd = getSignedUrlMock.mock.calls[0]?.[1] as { input: Record<string, unknown> };
    expect(cmd.input['ResponseContentDisposition']).toBe('attachment; filename="nota.pdf"');
  });
});

describe('S3Driver.get', () => {
  it('concatena o stream do corpo num Buffer', async () => {
    sendMock.mockResolvedValueOnce({
      Body: (async function* () {
        yield new Uint8Array([1, 2]);
        yield new Uint8Array([3]);
      })(),
    });

    const buffer = await createS3Driver(baseConfig).get('k');

    expect(buffer).toEqual(Buffer.from([1, 2, 3]));
  });

  it('lança quando o objeto não existe', async () => {
    sendMock.mockResolvedValueOnce({ Body: undefined });

    await expect(createS3Driver(baseConfig).get('sumiu')).rejects.toThrow('sumiu');
  });
});
