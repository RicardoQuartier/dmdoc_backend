import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import type { StorageForTenant } from './storage.js';

/**
 * Migração de acervo entre destinos de armazenamento (épico E-11 / T-141).
 *
 * Copia os arquivos que ainda moram em destinos ANTERIORES para o destino ATIVO
 * da empresa, um documento por vez, e só então comuta a linha de `documents`.
 *
 * ## O critério de seleção — onde a ADR-1 mora
 *
 * Um documento precisa migrar quando `storage_config_id IS DISTINCT FROM` a
 * configuração ativa. Nunca `storage_provider <> provider do destino`, e nunca
 * `<>` no lugar de `IS DISTINCT FROM`. Os dois desvios produzem a MESMA falha,
 * por caminhos diferentes:
 *
 * - por `storage_provider`: uma troca S3 → S3 (bucket da plataforma → bucket do
 *   cliente) tem o mesmo provider dos dois lados e seleciona ZERO documentos;
 * - por `<>`: com `NULL` de um dos lados (documento na plataforma, ou destino de
 *   plataforma) a comparação devolve `NULL`, o `WHERE` descarta a linha e a
 *   seleção volta vazia.
 *
 * Nos dois casos a migração fecha em `DONE` com `total_docs = 0`, o
 * `cleanup-source` conclui que ninguém depende da origem e apaga um acervo que
 * nunca foi copiado. Sem erro em lugar nenhum e sem volta. Ver o cabeçalho da
 * migration `0017_tenant_storage.sql`.
 *
 * ## A ordem das quatro operações por documento
 *
 * `get` na origem → confere o SHA-256 → `put` no destino → **só então** comuta
 * `storage_config_id`/`storage_provider`. A comutação é sempre a última: se o
 * processo morrer no meio, os documentos ainda não comutados continuam
 * apontando para a origem, de onde continuam sendo servidos. Em nenhum instante
 * existe documento apontando para arquivo que não está lá.
 *
 * É por isso que NÃO há transação abrangendo o lote: cada documento é sua
 * própria unidade atômica, e uma transação longa só serviria para transformar
 * uma interrupção em "perdi tudo o que já tinha copiado".
 *
 * ## Retomada
 *
 * Reexecutar é seguro e retoma sozinho: o filtro `IS DISTINCT FROM` já exclui
 * quem passou. Por isso os contadores da execução são ZERADOS ao (re)começar —
 * eles medem ESTA passada sobre o que ainda falta, não um acumulado histórico
 * que ninguém saberia interpretar depois de uma queda.
 */

/**
 * Documentos copiados em paralelo.
 *
 * Quatro é o teto prático do Microsoft Graph: acima disso o SharePoint começa a
 * responder 429 e o ganho vira espera de `Retry-After`. O tratamento do 429 (com
 * backoff e respeito ao header) já está DENTRO do `SharePointDriver` — aqui não
 * se reimplementa nada disso; o que se faz é não provocá-lo.
 */
export const STORAGE_MIGRATION_CONCURRENCY = 4;

/** Tamanho máximo do texto de erro guardado em `storage_migrations.last_error`. */
const LAST_ERROR_MAX_CHARS = 500;

export interface StorageMigrationDeps {
  sql: Sql;
  storage: StorageForTenant;
  logger: Logger;
  /** Documentos em paralelo. Default `STORAGE_MIGRATION_CONCURRENCY`. */
  concurrency?: number;
}

export interface StorageMigrationJob {
  tenantId: string;
  migrationId: string;
}

/**
 * Destino da migração: a configuração ATIVA da empresa, fixada no início do job.
 * `storageConfigId` nulo é o S3 da plataforma.
 */
export interface StorageMigrationDestination {
  storageConfigId: string | null;
  provider: string;
}

/**
 * Como a passada terminou.
 *
 * `SKIPPED` é o caso em que a linha de `storage_migrations` já não estava
 * `PENDING`/`RUNNING` quando o job pegou o trabalho — cancelada antes de
 * começar, ou já encerrada por outra execução. Nada é copiado e nada é
 * reescrito: quem cancelou é a autoridade sobre o estado final.
 */
export type StorageMigrationOutcome = 'DONE' | 'FAILED' | 'CANCELLED' | 'SKIPPED';

export interface StorageMigrationSummary {
  outcome: StorageMigrationOutcome;
  destination: StorageMigrationDestination;
  total: number;
  migrated: number;
  failed: number;
}

/** Linha da seleção — só o que o loop de cópia precisa. */
interface PendingDocumentRow {
  id: string;
  storage_key: string;
  storage_config_id: string | null;
  content_hash: string;
  mime_type: string;
}

/**
 * Executa uma migração de acervo do início ao fim.
 *
 * Idempotente e retomável: chamar de novo depois de uma queda continua de onde
 * parou, sem recopiar o que já foi comutado.
 */
export async function runStorageMigration(
  deps: StorageMigrationDeps,
  job: StorageMigrationJob
): Promise<StorageMigrationSummary> {
  const { sql, storage, logger } = deps;
  const { tenantId, migrationId } = job;
  const log = logger.child({ tenantId, migrationId });

  const destination = await loadActiveDestination(sql, tenantId);
  const pending = await selectPendingDocuments(sql, tenantId, destination.storageConfigId);

  // Marca a passada como em andamento e publica o total DESTA passada. O
  // `WHERE status IN ('PENDING','RUNNING')` cobre os dois caminhos legítimos de
  // entrada: o job novo (PENDING) e a retomada de um job que morreu no meio
  // (RUNNING, deixado para trás pela execução anterior). Zero linhas afetadas
  // significa que a migração foi cancelada ou encerrada — nada a fazer.
  // `clock_timestamp()`, e não `now()`, em todo carimbo de tempo desta tabela:
  // `now()` é o instante da TRANSAÇÃO, não o da consulta. Duas sentenças que
  // caiam na mesma transação implícita — e o postgres.js agrupa consultas em voo
  // sob um único Sync — receberiam o mesmo instante, e o par
  // `started_at`/`finished_at` pode até sair invertido em relação à ordem real
  // de execução. O que a tela precisa mostrar é quando a linha foi carimbada.
  const claimed = await sql<Array<{ id: string }>>`
    UPDATE storage_migrations
    SET status = 'RUNNING',
        started_at = COALESCE(started_at, clock_timestamp()),
        total_docs = ${pending.length},
        migrated_docs = 0,
        failed_docs = 0,
        last_error = NULL,
        finished_at = NULL
    WHERE id = ${migrationId}
      AND tenant_id = ${tenantId}
      AND status IN ('PENDING', 'RUNNING')
    RETURNING id
  `;

  if (claimed.length === 0) {
    log.info(
      'migração de acervo não está mais pendente (cancelada ou já encerrada) — nada a fazer'
    );
    return { outcome: 'SKIPPED', destination, total: 0, migrated: 0, failed: 0 };
  }

  log.info(
    {
      storageConfigId: destination.storageConfigId,
      provider: destination.provider,
      totalDocs: pending.length,
      sourceStorageConfigIds: [...new Set(pending.map((doc) => doc.storage_config_id))],
    },
    'migração de acervo iniciada'
  );

  if (pending.length === 0) {
    // Encerrar em DONE aqui é uma afirmação VERDADEIRA ("não havia nada a
    // migrar") porque o critério de seleção é confiável. Era exatamente isto
    // que o critério antigo (por provider) mentia.
    await finish(sql, migrationId, 'DONE');
    return { outcome: 'DONE', destination, total: 0, migrated: 0, failed: 0 };
  }

  const destinationDriver = await storage.forStorageConfig(tenantId, destination.storageConfigId);

  let migrated = 0;
  let failed = 0;
  let stopped = false;

  await runPool(pending, deps.concurrency ?? STORAGE_MIGRATION_CONCURRENCY, async (doc) => {
    if (stopped) return;

    // Cancelamento é observado ENTRE documentos: o que já começou termina (ou
    // falha) e nada é desfeito — cancelar interrompe o avanço, não reverte o
    // progresso. Uma consulta por PK por documento é ruído perto de baixar e
    // subir o arquivo.
    if (!(await isStillRunning(sql, migrationId, tenantId))) {
      stopped = true;
      return;
    }

    const docLog = log.child({ documentId: doc.id });

    try {
      // A origem é resolvida POR DOCUMENTO: uma empresa que já trocou de destino
      // duas vezes tem acervo em três lugares, e uma única passada converge
      // todos eles. Resolver "a origem da migração" (uma só) deixaria para trás
      // justamente o acervo mais antigo.
      const sourceDriver = await storage.forStorageConfig(tenantId, doc.storage_config_id);
      const buffer = await sourceDriver.get(doc.storage_key);

      const actualHash = sha256hex(buffer);
      if (actualHash !== doc.content_hash) {
        // O hash já está no banco (é a chave de dedup), então conferir a
        // integridade sai de graça. Divergiu: o arquivo na origem não é o que o
        // banco descreve — copiá-lo carregaria a corrupção para o destino novo e
        // ainda apagaria o original no `cleanup-source`. Falha e NÃO comuta: o
        // documento continua apontando para a origem, disponível para perícia.
        throw new StorageMigrationHashMismatchError(doc.content_hash, actualHash);
      }

      // A chave é a mesma nos dois destinos — cópia 1:1, sem reescrita de
      // caminho. Reescrever a chave exigiria atualizá-la no banco ANTES de ter
      // certeza da cópia, ou depois, com uma segunda janela de inconsistência.
      await destinationDriver.put({
        key: doc.storage_key,
        buffer,
        mimeType: doc.mime_type,
      });

      // A comutação é o ÚLTIMO passo. As duas colunas na MESMA sentença: a
      // denormalização (`storage_provider`) nunca pode ficar desalinhada da
      // autoridade (`storage_config_id`) — o CHECK
      // `documents_platform_storage_is_s3` recusaria o par incoerente, mas o
      // ponto é não chegar perto disso.
      await sql`
        UPDATE documents
        SET storage_config_id = ${destination.storageConfigId},
            storage_provider = ${destination.provider}
        WHERE id = ${doc.id}
          AND tenant_id = ${tenantId}
      `;

      migrated += 1;
      await sql`
        UPDATE storage_migrations
        SET migrated_docs = migrated_docs + 1
        WHERE id = ${migrationId}
      `;

      docLog.debug(
        { storageKey: doc.storage_key, fromStorageConfigId: doc.storage_config_id },
        'documento migrado para o destino ativo'
      );
    } catch (error: unknown) {
      failed += 1;
      const message = describeError(error);
      docLog.error(
        { err: error, storageKey: doc.storage_key, fromStorageConfigId: doc.storage_config_id },
        'falha ao migrar documento — permanece na origem'
      );
      await sql`
        UPDATE storage_migrations
        SET failed_docs = failed_docs + 1,
            last_error = ${message.slice(0, LAST_ERROR_MAX_CHARS)}
        WHERE id = ${migrationId}
      `;
    }
  });

  if (stopped) {
    // Quem cancelou já gravou `status = 'CANCELLED'`; aqui só se carimba o fim.
    await sql`
      UPDATE storage_migrations
      SET finished_at = COALESCE(finished_at, clock_timestamp())
      WHERE id = ${migrationId}
        AND tenant_id = ${tenantId}
    `;
    log.warn({ migrated, failed }, 'migração de acervo cancelada — o já migrado permanece');
    return { outcome: 'CANCELLED', destination, total: pending.length, migrated, failed };
  }

  // Com qualquer falha o estado final é FAILED, não DONE: é o que impede a tela
  // de liberar o `cleanup-source` sobre uma origem da qual ainda depende
  // arquivo. Disparar a migração de novo retoma só o que sobrou.
  const outcome: StorageMigrationOutcome = failed > 0 ? 'FAILED' : 'DONE';
  await finish(sql, migrationId, outcome);

  log.info({ total: pending.length, migrated, failed, outcome }, 'migração de acervo encerrada');
  return { outcome, destination, total: pending.length, migrated, failed };
}

/** Erro de integridade — o arquivo na origem não é o que o banco descreve. */
export class StorageMigrationHashMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(
      `conteúdo divergente na origem: content_hash do banco é ${expected}, ` +
        `o arquivo lido tem ${actual}`
    );
    this.name = 'StorageMigrationHashMismatchError';
  }
}

/**
 * Configuração ATIVA da empresa — o destino da migração.
 *
 * Ausência de linha ativa NÃO é erro: é o S3 da plataforma, o estado de toda
 * empresa que nunca configurou destino próprio (e o destino de quem VOLTA para
 * a plataforma). `storageConfigId` nulo e `provider = 's3'` é o par que o CHECK
 * `documents_platform_storage_is_s3` exige.
 */
async function loadActiveDestination(
  sql: Sql,
  tenantId: string
): Promise<StorageMigrationDestination> {
  const rows = await sql<Array<{ id: string; provider: string }>>`
    SELECT id, provider
    FROM tenant_storage_configs
    WHERE tenant_id = ${tenantId}
      AND active
    LIMIT 1
  `;

  const row = rows[0];
  if (row === undefined) return { storageConfigId: null, provider: 's3' };
  return { storageConfigId: row.id, provider: row.provider };
}

/**
 * Documentos que ainda dependem de um destino que não é o ativo.
 *
 * ⚠️ `IS DISTINCT FROM`, nunca `<>` — ver o cabeçalho deste arquivo. É a mesma
 * consulta que o `cleanup-source` usa como guarda, e é atendida pelo índice
 * `docs_by_storage_config (tenant_id, storage_config_id)`.
 *
 * `deleted = false` porque a exclusão de documento já apaga o binário do
 * destino (wiki "Exclusão lógica (soft delete)"): não há o que copiar, e
 * tentar copiar produziria uma falha garantida por documento excluído.
 */
async function selectPendingDocuments(
  sql: Sql,
  tenantId: string,
  destinationConfigId: string | null
): Promise<PendingDocumentRow[]> {
  return sql<PendingDocumentRow[]>`
    SELECT id, storage_key, storage_config_id, content_hash, mime_type
    FROM documents
    WHERE tenant_id = ${tenantId}
      AND deleted = false
      AND storage_config_id IS DISTINCT FROM ${destinationConfigId}
    ORDER BY uploaded_at ASC, id ASC
  `;
}

/** A migração continua valendo? Falso quando foi cancelada ou encerrada. */
async function isStillRunning(sql: Sql, migrationId: string, tenantId: string): Promise<boolean> {
  const rows = await sql<Array<{ status: string }>>`
    SELECT status
    FROM storage_migrations
    WHERE id = ${migrationId}
      AND tenant_id = ${tenantId}
    LIMIT 1
  `;
  return rows[0]?.status === 'RUNNING';
}

/**
 * Carimba o estado final.
 *
 * `AND status = 'RUNNING'` para não sobrescrever um cancelamento que chegou
 * entre o último documento e este UPDATE — a intenção de quem cancelou vence.
 */
async function finish(
  sql: Sql,
  migrationId: string,
  status: 'DONE' | 'FAILED'
): Promise<void> {
  await sql`
    UPDATE storage_migrations
    SET status = ${status},
        finished_at = clock_timestamp()
    WHERE id = ${migrationId}
      AND status = 'RUNNING'
  `;
}

/**
 * Executa `task` sobre os itens com no máximo `concurrency` em voo.
 *
 * Um cursor compartilhado em vez de fatiar em blocos: com blocos, um documento
 * de 200 MB seguraria os outros três do bloco parados até terminar. Aqui cada
 * runner puxa o próximo assim que fica livre.
 */
async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () =>
    (async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        await task(items[index] as T);
      }
    })()
  );
  await Promise.all(runners);
}

function sha256hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
