import type { Sql } from 'postgres';
import type { Logger } from 'pino';
import type { ExtractorProvider } from '@dmdoc/extractor';
import type { DocumentProcessingJobData } from '@dmdoc/shared-types';
import type { StorageDriver } from '@dmdoc/storage';
import type { StorageForTenant } from '../storage.js';

export interface ExtractResult {
  fullText: string;
  pageCount: number;
  ocrPages: number[];
  engine: 'unstructured' | 'native';
  engineVersion: string;
  durationMs: number;
  /** true quando o resultado veio do cache (idempotência) */
  fromCache: boolean;
}

export interface ExtractDeps {
  /** Resolve o destino de armazenamento — pela configuração DO DOCUMENTO. */
  storage: StorageForTenant;
  extractor: ExtractorProvider;
  sql: Sql;
  logger: Logger;
  /** Validade da URL entregue ao extractor, em segundos. */
  downloadUrlTtlSecs?: number;
}

/**
 * Validade default da URL de download entregue ao extractor.
 *
 * Cobre FILA + PROCESSAMENTO, não só o download: o pedido pode esperar atrás de
 * outra extração pesada (o consumer Python processa um job por vez) e só então
 * baixar o arquivo. Uma URL dimensionada pelo tempo de download expiraria
 * exatamente nos documentos grandes — os que mais demoram a ser lidos.
 */
const DEFAULT_DOWNLOAD_URL_TTL_SECS = 1800;

/**
 * Etapa 1 do pipeline: publica o pedido de extração na fila Redis e aguarda
 * o resultado via BLPOP.
 *
 * O worker resolve o destino DAQUELE documento e gera uma URL de download
 * temporária; o extractor Python só faz um GET nessa URL. É isso que mantém o
 * microserviço ignorante do provedor — ele funciona igual com bucket da
 * plataforma, bucket do cliente ou SharePoint.
 *
 * ⚠️ O destino vem de `documents.storage_config_id`, NUNCA da configuração
 * corrente da empresa. Reprocessar (E-4/E-7) é o caminho em que a diferença
 * aparece: o documento pode ter sido enviado meses antes da empresa trocar de
 * destino, ou estar entre os que uma migração ainda não copiou. Resolver pelo
 * destino corrente buscaria o arquivo onde ele não está — e, no caso S3→S3,
 * num bucket que existe e responde "objeto inexistente".
 *
 * Idempotência: se `document_content` já tem `full_text` para este `documentId`,
 * retorna o resultado existente sem re-processar (spec §8, invariante 1) — e sem
 * gerar URL nenhuma.
 *
 * Atualiza `documents.status` para `PROCESSING` antes de iniciar o trabalho.
 */
export async function extractDocument(
  job: DocumentProcessingJobData,
  deps: ExtractDeps
): Promise<ExtractResult> {
  const { tenantId, documentId, storageKey, mimeType } = job;
  const {
    storage,
    extractor,
    sql,
    logger: baseLogger,
    downloadUrlTtlSecs = DEFAULT_DOWNLOAD_URL_TTL_SECS,
  } = deps;

  const log = baseLogger.child({ tenantId, documentId, step: 'extract' });

  // Idempotência: verificar se já existe document_content com full_text
  const existingRows = await sql<
    Array<{ full_text: string; extraction: Record<string, unknown> | null }>
  >`
    SELECT full_text, extraction
    FROM document_content
    WHERE document_id = ${documentId}
      AND tenant_id = ${tenantId}
  `;

  const existing = existingRows[0];

  if (existing?.full_text) {
    log.info({ fromCache: true }, 'fullText já existe — pulando extração');
    const ext = existing.extraction ?? {};
    return {
      fullText: existing.full_text,
      pageCount: typeof ext['pageCount'] === 'number' ? ext['pageCount'] : 0,
      ocrPages: Array.isArray(ext['ocrPages']) ? (ext['ocrPages'] as number[]) : [],
      engine: (ext['engine'] as 'unstructured' | 'native') ?? 'native',
      engineVersion: typeof ext['engineVersion'] === 'string' ? ext['engineVersion'] : '0.0.0',
      durationMs: typeof ext['durationMs'] === 'number' ? ext['durationMs'] : 0,
      fromCache: true,
    };
  }

  // Atualizar status para PROCESSING e limpar failure_reason de tentativas
  // anteriores. O `RETURNING` aproveita a ida ao banco que já aconteceria: o
  // nome do arquivo é obrigatório no payload de extração e o
  // `storage_config_id` diz de onde baixar — os dois numa segunda query seriam
  // round-trips a mais por documento.
  //
  // O `storage_config_id` vem daqui, e não do payload do job, de propósito: ele
  // pode ter MUDADO entre o enfileiramento e o processamento (uma migração de
  // acervo comuta a coluna enquanto a fila anda). O banco é sempre a versão
  // atual de onde o arquivo está.
  const updatedRows = await sql<
    Array<{ original_filename: string; storage_config_id: string | null }>
  >`
    UPDATE documents
    SET status = 'PROCESSING',
        failure_reason = null
    WHERE id = ${documentId}
      AND tenant_id = ${tenantId}
    RETURNING original_filename, storage_config_id
  `;

  const updated = updatedRows[0];
  const filename = resolveFilename(updated?.original_filename, storageKey);

  // Destino DESTE documento — bucket da plataforma (`storage_config_id` nulo),
  // bucket do cliente ou SharePoint dele, ativo ou já aposentado. O extractor
  // não sabe a diferença.
  //
  // Linha ausente é o documento ter sumido entre o enfileiramento e agora: sem
  // linha não existe informação por documento, então resta o destino corrente da
  // empresa. O log em nível de aviso é o que evita interpretar o
  // "objeto inexistente" seguinte como problema de storage.
  let driver: StorageDriver;
  if (updated === undefined) {
    log.warn(
      { storageKey },
      'documento não encontrado ao marcar PROCESSING — resolvendo o destino corrente da empresa'
    );
    driver = await storage.forTenant(tenantId);
  } else {
    driver = await storage.forStorageConfig(tenantId, updated.storage_config_id);
  }

  // `audience: 'internal'` é obrigatório: quem consome a URL é o contêiner do
  // extractor, que alcança o host interno (http://minio:9000) e NÃO alcança o
  // host publicado para o navegador (http://localhost:5054). Trocar por
  // 'browser' quebra a extração só em desenvolvimento, e de um jeito opaco.
  const fileUrl = await driver.getDownloadUrl(storageKey, {
    audience: 'internal',
    expiresInSeconds: downloadUrlTtlSecs,
  });

  log.info(
    {
      storageKey,
      mimeType,
      filename,
      storageProvider: driver.provider,
      // Qual CONFIGURAÇÃO abriu o arquivo — é o que distingue dois destinos do
      // mesmo provider quando alguém for depurar "por que não achou o objeto".
      storageConfigId: updated?.storage_config_id ?? null,
      downloadUrlTtlSecs,
      // Só host + caminho: a query string carrega a assinatura, que é
      // credencial de leitura do arquivo enquanto a URL valer.
      ...describeUrl(fileUrl),
    },
    'enviando para fila de extração'
  );

  // Enfileira no Redis e aguarda resultado via BLPOP (sem timeout HTTP)
  const result = await extractor.extract({ fileUrl, mimeType, filename });

  log.info(
    {
      engine: result.engine,
      engineVersion: result.engineVersion,
      pageCount: result.pageCount,
      ocrPages: result.ocrPages,
      durationMs: result.durationMs,
      fullTextLength: result.fullText.length,
    },
    'extração concluída'
  );

  return {
    fullText: result.fullText,
    pageCount: result.pageCount,
    ocrPages: result.ocrPages,
    engine: result.engine,
    engineVersion: result.engineVersion,
    durationMs: result.durationMs,
    fromCache: false,
  };
}

/**
 * Nome do arquivo entregue ao extractor, que o usa para escolher o parser
 * quando o MIME não é conclusivo.
 *
 * Vem de `documents.original_filename`. O último segmento da `storageKey` é
 * apenas a rede de segurança para a linha ter sumido entre o enfileiramento e o
 * processamento: a chave termina com o nome do arquivo hoje
 * (`tenants/{id}/documents/{hash}/{filename}`), mas isso é convenção do driver
 * S3, não contrato — nenhum destino promete que a chave carregue o nome.
 */
function resolveFilename(originalFilename: string | undefined, storageKey: string): string {
  const fromDb = originalFilename?.trim();
  if (fromDb !== undefined && fromDb.length > 0) return fromDb;

  const lastSegment = storageKey.split('/').pop()?.trim();
  return lastSegment !== undefined && lastSegment.length > 0 ? lastSegment : storageKey;
}

/**
 * Parte não-secreta de uma URL assinada, para log: host e caminho, jamais a
 * query string (onde vive a assinatura). Serve para conferir que o extractor
 * recebeu o host INTERNO do Docker, e não o publicado para o navegador.
 *
 * URL inválida não derruba o job — o log é observabilidade, não regra.
 */
function describeUrl(fileUrl: string): { fileUrlHost?: string; fileUrlPath?: string } {
  try {
    const parsed = new URL(fileUrl);
    return { fileUrlHost: parsed.host, fileUrlPath: parsed.pathname };
  } catch {
    return {};
  }
}
