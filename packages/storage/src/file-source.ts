import { stat } from 'node:fs/promises';

import type { StorageProvider } from './driver.js';
import { StorageError } from './errors.js';

/**
 * Confere que o arquivo local de um `putFile` tem exatamente o tamanho
 * declarado. Chamado antes de abrir qualquer envio: um arquivo truncado (disco
 * cheio, parte faltando na montagem) viraria um objeto truncado no destino sem
 * ninguém notar.
 */
export async function assertLocalFileSize(
  path: string,
  expectedBytes: number,
  provider: StorageProvider,
): Promise<void> {
  const info = await stat(path);
  if (!info.isFile() || info.size !== expectedBytes) {
    throw new StorageError(
      `arquivo local com tamanho divergente: esperado ${expectedBytes} bytes, encontrado ${info.isFile() ? info.size : 'não-arquivo'}`,
      { provider, operation: 'putFile' },
    );
  }
}
