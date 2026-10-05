import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createS3Driver, type S3Driver } from './s3-driver.js';

/**
 * Integração REAL do `putFile` com um servidor S3 (MinIO do compose de dev).
 *
 * Fica desligado por padrão: o restante da suíte do pacote mocka o SDK e roda
 * sem rede. Para executar, dentro do contêiner `api` (que alcança `minio:9000`):
 *
 *   S3_TEST_ENDPOINT=http://minio:9000 pnpm --filter @dmdoc/storage test s3-driver.minio
 *
 * Credenciais e bucket vêm de `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/
 * `AWS_S3_BUCKET` (já definidas no contêiner de dev).
 */
const endpoint = process.env['S3_TEST_ENDPOINT'];

const FILE_BYTES = 30 * 1024 * 1024;

describe.skipIf(endpoint === undefined)('S3Driver.putFile — MinIO real', () => {
  let dir: string;
  let filePath: string;
  let originalHash: string;
  let driver: S3Driver;
  const key = `tests/putfile/${randomBytes(8).toString('hex')}/arquivo-30mb.bin`;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 's3-putfile-'));
    filePath = join(dir, 'arquivo.bin');

    // Escreve 30 MB aleatórios em blocos de 1 MiB, calculando o hash junto.
    const hash = createHash('sha256');
    const out = createWriteStream(filePath);
    for (let written = 0; written < FILE_BYTES; written += 1024 * 1024) {
      const block = randomBytes(Math.min(1024 * 1024, FILE_BYTES - written));
      hash.update(block);
      if (!out.write(block)) await new Promise((resolve) => out.once('drain', resolve));
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    originalHash = hash.digest('hex');

    driver = createS3Driver({
      region: process.env['AWS_REGION'] ?? 'us-east-1',
      bucket: process.env['AWS_S3_BUCKET'] ?? 'dmdoc-documents',
      accessKeyId: process.env['AWS_ACCESS_KEY_ID'] ?? 'minioadmin',
      secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? 'minioadmin',
      endpoint: endpoint as string,
      forcePathStyle: true,
    });
  });

  afterAll(async () => {
    await driver?.delete(key).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it('grava 30 MB por multipart e o objeto tem o mesmo SHA-256 do arquivo', async () => {
    await driver.putFile({ key, path: filePath, sizeBytes: FILE_BYTES, mimeType: 'application/octet-stream' });

    const stored = await driver.get(key);
    expect(stored.byteLength).toBe(FILE_BYTES);
    expect(createHash('sha256').update(stored).digest('hex')).toBe(originalHash);
  });

  it('recusa quando o tamanho declarado diverge do arquivo', async () => {
    await expect(
      driver.putFile({ key: `${key}.x`, path: filePath, sizeBytes: FILE_BYTES - 1, mimeType: 'application/octet-stream' })
    ).rejects.toThrow(/tamanho divergente/);
  });
});
