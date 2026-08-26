import { describe, expect, it, vi } from 'vitest';

import type { StorageDriver } from './driver.js';
import { StorageNotFoundError } from './errors.js';
import { buildDeletedStorageKey, moveWithinDriver } from './move.js';

/** Driver falso — só o suficiente para exercitar `moveWithinDriver`. */
function fakeDriver(overrides: Partial<StorageDriver> = {}): StorageDriver {
  return {
    provider: 's3',
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(Buffer.from('conteudo')),
    getDownloadUrl: vi.fn().mockResolvedValue('https://example.com/x'),
    delete: vi.fn().mockResolvedValue(undefined),
    deletePrefix: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('buildDeletedStorageKey', () => {
  it('troca só o basename, mantendo a pasta', () => {
    const key = buildDeletedStorageKey(
      'tenants/t1/documents/abc123/contrato.pdf',
      'doc-1'
    );
    expect(key).toBe('tenants/t1/documents/abc123/deleted__doc-1__contrato.pdf');
  });

  it('funciona sem nenhuma pasta na chave', () => {
    expect(buildDeletedStorageKey('contrato.pdf', 'doc-1')).toBe('deleted__doc-1__contrato.pdf');
  });

  it('gera chaves diferentes para o mesmo arquivo com documentIds diferentes (unicidade)', () => {
    const a = buildDeletedStorageKey('tenants/t1/documents/abc/f.pdf', 'doc-1');
    const b = buildDeletedStorageKey('tenants/t1/documents/abc/f.pdf', 'doc-2');
    expect(a).not.toBe(b);
  });

  it('preserva nomes de arquivo com múltiplos pontos e espaços', () => {
    const key = buildDeletedStorageKey('tenants/t1/documents/h/Relatório Final v2.docx', 'doc-9');
    expect(key).toBe('tenants/t1/documents/h/deleted__doc-9__Relatório Final v2.docx');
  });

  it('é idempotente em ciclo excluir→restaurar→excluir: não empilha o prefixo do mesmo documentId', () => {
    const firstDelete = buildDeletedStorageKey('tenants/t1/documents/abc/contrato.pdf', 'doc-1');
    // Restaurar não move o arquivo (decisão de design) — `storage_key` continua
    // sendo `firstDelete`. Uma segunda exclusão chama a função de novo sobre essa
    // mesma chave.
    const secondDelete = buildDeletedStorageKey(firstDelete, 'doc-1');
    expect(secondDelete).toBe(firstDelete);
  });

  it('NÃO trata como já-envelopado o prefixo de soft-delete de OUTRO documentId', () => {
    // Chave já soft-deletada de doc-1, mas agora reenvelopada para doc-2 (ex.:
    // colisão hipotética) — não deve ser confundida com o próprio prefixo.
    const key = buildDeletedStorageKey('tenants/t1/documents/abc/deleted__doc-1__contrato.pdf', 'doc-2');
    expect(key).toBe('tenants/t1/documents/abc/deleted__doc-2__deleted__doc-1__contrato.pdf');
  });
});

describe('moveWithinDriver', () => {
  it('faz get + put + delete na sequência correta', async () => {
    const calls: string[] = [];
    const driver = fakeDriver({
      get: vi.fn().mockImplementation(async (key: string) => {
        calls.push(`get:${key}`);
        return Buffer.from('bytes');
      }),
      put: vi.fn().mockImplementation(async (params) => {
        calls.push(`put:${params.key}`);
      }),
      delete: vi.fn().mockImplementation(async (key: string) => {
        calls.push(`delete:${key}`);
      }),
    });

    await moveWithinDriver(driver, 'from/key.pdf', 'to/key.pdf', 'application/pdf');

    expect(calls).toEqual(['get:from/key.pdf', 'put:to/key.pdf', 'delete:from/key.pdf']);
    expect(driver.put).toHaveBeenCalledWith({
      key: 'to/key.pdf',
      buffer: Buffer.from('bytes'),
      mimeType: 'application/pdf',
    });
  });

  it('é idempotente quando a origem já não existe (já movida antes)', async () => {
    const notFound = new StorageNotFoundError('não encontrado', {
      provider: 's3',
      operation: 'get',
    });
    const driver = fakeDriver({
      get: vi.fn().mockRejectedValue(notFound),
    });
    const logger = { warn: vi.fn() };

    await expect(
      moveWithinDriver(driver, 'from/key.pdf', 'to/key.pdf', 'application/pdf', logger)
    ).resolves.toBeUndefined();

    expect(driver.put).not.toHaveBeenCalled();
    expect(driver.delete).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('não engole erros que não sejam StorageNotFoundError', async () => {
    const driver = fakeDriver({
      get: vi.fn().mockRejectedValue(new Error('falha de rede')),
    });

    await expect(
      moveWithinDriver(driver, 'from/key.pdf', 'to/key.pdf', 'application/pdf')
    ).rejects.toThrow('falha de rede');

    expect(driver.put).not.toHaveBeenCalled();
    expect(driver.delete).not.toHaveBeenCalled();
  });

  it('propaga erro de put sem chamar delete (origem preservada em caso de falha)', async () => {
    const driver = fakeDriver({
      put: vi.fn().mockRejectedValue(new Error('put falhou')),
    });

    await expect(
      moveWithinDriver(driver, 'from/key.pdf', 'to/key.pdf', 'application/pdf')
    ).rejects.toThrow('put falhou');

    expect(driver.delete).not.toHaveBeenCalled();
  });

  it('é no-op quando fromKey === toKey (evita apagar o objeto de verdade em ciclo excluir→restaurar→excluir)', async () => {
    const driver = fakeDriver();
    const logger = { warn: vi.fn() };

    await expect(
      moveWithinDriver(driver, 'same/key.pdf', 'same/key.pdf', 'application/pdf', logger)
    ).resolves.toBeUndefined();

    expect(driver.get).not.toHaveBeenCalled();
    expect(driver.put).not.toHaveBeenCalled();
    expect(driver.delete).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
