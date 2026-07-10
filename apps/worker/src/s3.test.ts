import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Testes do helper de storage do worker (`WorkerS3.deleteByPrefix`).
 *
 * O `@aws-sdk/client-s3` é mockado: capturamos os comandos enviados via
 * `S3Client.send` e validamos a paginação (ContinuationToken) e o lote de
 * deletes — sem abrir socket real.
 */

const sendMock = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
  class ListObjectsV2Command {
    constructor(public input: unknown) {}
  }
  class DeleteObjectsCommand {
    constructor(public input: unknown) {}
  }
  class S3Client {
    send = sendMock;
  }
  return { S3Client, ListObjectsV2Command, DeleteObjectsCommand };
});

import { ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { loadConfig } from './config.js';
import { createWorkerS3 } from './s3.js';

const config = loadConfig({ AWS_S3_BUCKET: 'test-bucket' });

describe('WorkerS3.deleteByPrefix', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it('não envia delete quando o prefixo está vazio', async () => {
    sendMock.mockResolvedValueOnce({ Contents: [], IsTruncated: false });

    await createWorkerS3(config).deleteByPrefix('tenants/abc/');

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

    await createWorkerS3(config).deleteByPrefix('tenants/abc/');

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

    await createWorkerS3(config).deleteByPrefix('tenants/abc/');

    expect(sendMock).toHaveBeenCalledTimes(4);
    const secondList = sendMock.mock.calls[2]?.[0] as ListObjectsV2Command;
    expect(secondList).toBeInstanceOf(ListObjectsV2Command);
    expect((secondList.input as { ContinuationToken?: string }).ContinuationToken).toBe('tok-1');
  });
});
