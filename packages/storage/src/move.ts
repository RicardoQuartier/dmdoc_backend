import type { StorageDriver } from './driver.js';
import { StorageNotFoundError } from './errors.js';

/**
 * Interface mínima de logger — compatível com Pino e `FastifyBaseLogger`.
 * Segue o mesmo padrão de injeção usado em `packages/llm-provider` (evita
 * puxar `@dmdoc/logger` como dependência só para um `warn`).
 */
export interface MinimalLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Constrói a chave física do soft-delete de um documento.
 *
 * Mantém o arquivo na MESMA pasta/prefixo do original — só o basename muda —
 * de propósito: uma purga futura de empresa (`deletePrefix`) varre a árvore
 * inteira do tenant e continua alcançando os arquivos soft-deletados, o que é
 * o comportamento desejado (a purga final não deve deixar órfãos).
 *
 * O prefixo `deleted__{documentId}__` garante unicidade: um `documentId` só
 * passa por soft-delete uma vez (a coluna `deleted` trava reexecução), então
 * a chave nunca colide — nem com um reupload posterior do mesmo nome+conteúdo.
 *
 * IDEMPOTENTE em ciclos excluir→restaurar→excluir: como a restauração (`POST
 * /documents/:id/restore`) NÃO move o arquivo de volta para a chave original
 * (decisão de design — ver rota), uma segunda exclusão do mesmo documento
 * chamaria esta função sobre uma chave que JÁ é `deleted__{documentId}__...`.
 * Sem esta guarda, o prefixo empilharia
 * (`deleted__{id}__deleted__{id}__{basename}`) a cada ciclo — feio, mas sem
 * perda de dado. Se o basename já começa com o prefixo deste MESMO
 * `documentId`, retorna a própria `originalKey` inalterada.
 */
export function buildDeletedStorageKey(originalKey: string, documentId: string): string {
  const lastSlashIndex = originalKey.lastIndexOf('/');
  const dir = lastSlashIndex === -1 ? '' : originalKey.slice(0, lastSlashIndex + 1);
  const basename = lastSlashIndex === -1 ? originalKey : originalKey.slice(lastSlashIndex + 1);
  const deletedPrefix = `deleted__${documentId}__`;
  if (basename.startsWith(deletedPrefix)) {
    return originalKey;
  }
  return `${dir}${deletedPrefix}${basename}`;
}

/**
 * Move um objeto dentro do MESMO driver via `get` + `put` + `delete`.
 *
 * Não existe `CopyObjectCommand` (S3) nem rename atômico via Graph (SharePoint)
 * em uso neste código — nenhum dos dois drivers implementa operação nativa de
 * cópia/rename hoje, e introduzir isso só para o soft-delete físico adicionaria
 * dois caminhos novos, não testados, numa rota que não é hot-path de
 * performance. `get`+`put`+`delete` funciona identicamente para os dois
 * provedores, reaproveitando exatamente o que já existe e já é testado (mesmo
 * padrão do worker de migração de acervo, `apps/worker/src/storage-migration.ts`).
 *
 * Idempotente: se `fromKey` já não existir (`StorageNotFoundError`), assume que
 * um soft-delete anterior já moveu o objeto — loga aviso e retorna sem erro em
 * vez de propagar a falha.
 *
 * Idempotente TAMBÉM quando `fromKey === toKey` (ciclo excluir→restaurar→
 * excluir com `buildDeletedStorageKey` já idempotente — ver comentário acima):
 * sem esta guarda, `get`+`put`+`delete` sobre a MESMA chave apagaria o objeto
 * de verdade (o `delete` final removeria o que o `put` acabou de escrever) —
 * perda de dado real, não só cosmética. No-op explícito.
 */
export async function moveWithinDriver(
  driver: StorageDriver,
  fromKey: string,
  toKey: string,
  mimeType: string,
  logger?: MinimalLogger
): Promise<void> {
  if (fromKey === toKey) {
    logger?.warn(
      { provider: driver.provider, fromKey, toKey },
      'origem e destino idênticos ao mover — operação já era um no-op (idempotente)'
    );
    return;
  }

  let buffer: Buffer;
  try {
    buffer = await driver.get(fromKey);
  } catch (err) {
    if (err instanceof StorageNotFoundError) {
      logger?.warn(
        { provider: driver.provider, fromKey, toKey },
        'objeto de origem não encontrado ao mover — já movido anteriormente (operação idempotente)'
      );
      return;
    }
    throw err;
  }

  await driver.put({ key: toKey, buffer, mimeType });
  await driver.delete(fromKey);
}
