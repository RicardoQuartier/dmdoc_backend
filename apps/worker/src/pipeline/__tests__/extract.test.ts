import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import type { ExtractInput, ExtractionResult, ExtractorProvider } from '@dmdoc/extractor';
import type { DocumentProcessingJobData } from '@dmdoc/shared-types';
import type { StorageDriver } from '@dmdoc/storage';

import { extractDocument } from '../extract.js';
import type { StorageForTenant } from '../../storage.js';

/**
 * Testes da etapa 1 do pipeline depois do desacoplamento do S3 (E-11 / T-138).
 *
 * O que está sob teste é o CONTRATO com o extractor: o worker resolve o destino
 * da empresa, assina uma URL temporária alcançável de dentro da rede Docker e
 * publica `{ fileUrl, mimeType, filename }`. Nada aqui fala de bucket.
 *
 * Os dois pontos que quebram em silêncio se regredirem:
 *  - `audience: 'internal'` — com `'browser'` a URL aponta para o host publicado
 *    (localhost), que o contêiner do extractor não alcança;
 *  - `filename` vindo de `documents.original_filename` — a escolha de parser no
 *    Python usa a extensão, e a URL assinada termina em query string.
 */

const TENANT_ID = '00000000-0000-0000-0000-00000000000a';
const DOCUMENT_ID = '00000000-0000-0000-0000-000000000001';
const STORAGE_KEY = `tenants/${TENANT_ID}/documents/abc123/relatorio-anual.docx`;

const JOB: DocumentProcessingJobData = {
  tenantId: TENANT_ID,
  documentId: DOCUMENT_ID,
  storageKey: STORAGE_KEY,
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function makeSilentLogger(): Logger {
  const logger = {
    child: () => logger,
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  };
  return logger as unknown as Logger;
}

interface SqlStubOptions {
  /** Linha de `document_content` — presente só nos testes de idempotência. */
  content?: { full_text: string; extraction: Record<string, unknown> | null };
  /** `original_filename` devolvido pelo UPDATE; `null` simula documento sumido. */
  originalFilename?: string | null;
  /** Configuração de armazenamento DO DOCUMENTO; ausente = plataforma. */
  storageConfigId?: string | null;
}

function makeSqlStub(opts: SqlStubOptions = {}): Sql {
  const noop = Object.assign([], { count: 0 });

  const sqlFn = vi.fn().mockImplementation((strings: TemplateStringsArray | string) => {
    if (typeof strings === 'string') return { __pgIdentifier: strings };
    const query = strings.join('?').toLowerCase();

    if (query.includes('from document_content')) {
      return Promise.resolve(opts.content === undefined ? [] : [opts.content]);
    }
    if (query.includes('update documents')) {
      // O destino do arquivo sai DESTE returning, não do payload do job: entre
      // enfileirar e processar, uma migração de acervo pode ter comutado a
      // coluna.
      expect(query).toContain('returning original_filename, storage_config_id');
      return Promise.resolve(
        opts.originalFilename === null || opts.originalFilename === undefined
          ? []
          : [
              {
                original_filename: opts.originalFilename,
                storage_config_id: opts.storageConfigId ?? null,
              },
            ]
      );
    }
    return Promise.resolve(noop);
  });

  return sqlFn as unknown as Sql;
}

function makeDriver(url = 'http://minio:9000/dmdoc-documents/obj?X-Amz-Signature=abc'): StorageDriver {
  return {
    provider: 's3',
    put: vi.fn(),
    get: vi.fn(),
    getDownloadUrl: vi.fn().mockResolvedValue(url),
    delete: vi.fn(),
    deletePrefix: vi.fn(),
  } as unknown as StorageDriver;
}

function makeExtractor(): ExtractorProvider & { calls: ExtractInput[] } {
  const calls: ExtractInput[] = [];
  return {
    calls,
    extract: (input: ExtractInput): Promise<ExtractionResult> => {
      calls.push(input);
      return Promise.resolve({
        fullText: 'texto extraído',
        pageCount: 3,
        ocrPages: [2],
        engine: 'native',
        engineVersion: 'python-extractor-redis',
        durationMs: 42,
      });
    },
  };
}

/**
 * Resolvedor falso que anota COMO foi chamado.
 *
 * `resolved` registra cada resolução por documento como `tenant/config` — é a
 * asserção que prova que o pipeline pergunta pela configuração DO DOCUMENTO.
 * `tenants` registra as resoluções pelo destino corrente da empresa, que depois
 * desta tarefa só podem acontecer no caso degenerado (documento sumido).
 */
function makeStorage(
  driver: StorageDriver
): StorageForTenant & { tenants: string[]; resolved: string[] } {
  const tenants: string[] = [];
  const resolved: string[] = [];
  return {
    tenants,
    resolved,
    forTenant: (tenantId: string) => {
      tenants.push(tenantId);
      return Promise.resolve(driver);
    },
    forStorageConfig: (tenantId: string, storageConfigId: string | null) => {
      resolved.push(`${tenantId}/${storageConfigId ?? 'platform'}`);
      return Promise.resolve(driver);
    },
  };
}

describe('extractDocument — contrato por URL', () => {
  it('assina a URL do destino DO DOCUMENTO com audience internal e publica fileUrl/mimeType/filename', async () => {
    const driver = makeDriver();
    const storage = makeStorage(driver);
    const extractor = makeExtractor();

    const result = await extractDocument(JOB, {
      storage,
      extractor,
      sql: makeSqlStub({ originalFilename: 'relatorio-anual.docx' }),
      logger: makeSilentLogger(),
      downloadUrlTtlSecs: 1800,
    });

    expect(storage.resolved).toEqual([`${TENANT_ID}/platform`]);
    expect(storage.tenants).toEqual([]);
    expect(driver.getDownloadUrl).toHaveBeenCalledWith(STORAGE_KEY, {
      audience: 'internal',
      expiresInSeconds: 1800,
    });
    expect(extractor.calls).toEqual([
      {
        fileUrl: 'http://minio:9000/dmdoc-documents/obj?X-Amz-Signature=abc',
        mimeType: JOB.mimeType,
        filename: 'relatorio-anual.docx',
      },
    ]);
    expect(result.fullText).toBe('texto extraído');
    expect(result.fromCache).toBe(false);
  });

  it('usa 30 min de validade quando o TTL não é configurado — cobre fila + processamento', async () => {
    const driver = makeDriver();

    await extractDocument(JOB, {
      storage: makeStorage(driver),
      extractor: makeExtractor(),
      sql: makeSqlStub({ originalFilename: 'a.pdf' }),
      logger: makeSilentLogger(),
    });

    expect(driver.getDownloadUrl).toHaveBeenCalledWith(
      STORAGE_KEY,
      expect.objectContaining({ expiresInSeconds: 1800 })
    );
  });

  it('manda o original_filename do banco, não o último segmento da chave', async () => {
    // Chave opaca, sem extensão: só o nome do banco salva a escolha de parser.
    const opaqueJob: DocumentProcessingJobData = {
      ...JOB,
      storageKey: '01HXYZ-item-id-sem-extensao',
    };
    const extractor = makeExtractor();

    await extractDocument(opaqueJob, {
      storage: makeStorage(makeDriver()),
      extractor,
      sql: makeSqlStub({ originalFilename: 'planilha de custos.xlsx' }),
      logger: makeSilentLogger(),
    });

    expect(extractor.calls[0]?.filename).toBe('planilha de custos.xlsx');
  });

  it('cai no último segmento da chave quando o documento não devolve nome', async () => {
    const extractor = makeExtractor();

    await extractDocument(JOB, {
      storage: makeStorage(makeDriver()),
      extractor,
      sql: makeSqlStub({ originalFilename: null }),
      logger: makeSilentLogger(),
    });

    expect(extractor.calls[0]?.filename).toBe('relatorio-anual.docx');
  });

  it('não resolve driver nem assina URL quando full_text já existe (idempotência)', async () => {
    const driver = makeDriver();
    const storage = makeStorage(driver);
    const extractor = makeExtractor();

    const result = await extractDocument(JOB, {
      storage,
      extractor,
      sql: makeSqlStub({
        content: {
          full_text: 'já extraído antes',
          extraction: { pageCount: 7, ocrPages: [], engine: 'native', engineVersion: 'x', durationMs: 1 },
        },
      }),
      logger: makeSilentLogger(),
    });

    expect(result.fromCache).toBe(true);
    expect(result.fullText).toBe('já extraído antes');
    expect(storage.tenants).toEqual([]);
    expect(storage.resolved).toEqual([]);
    expect(driver.getDownloadUrl).not.toHaveBeenCalled();
    expect(extractor.calls).toEqual([]);
  });

  it('propaga falha de resolução do destino — o pipeline marca o documento FAILED', async () => {
    const storage: StorageForTenant = {
      forTenant: () => Promise.reject(new Error('não deveria resolver pela empresa')),
      forStorageConfig: () =>
        Promise.reject(new Error('configuração de armazenamento quebrada')),
    };
    const extractor = makeExtractor();

    await expect(
      extractDocument(JOB, {
        storage,
        extractor,
        sql: makeSqlStub({ originalFilename: 'a.pdf' }),
        logger: makeSilentLogger(),
      })
    ).rejects.toThrow('configuração de armazenamento quebrada');

    expect(extractor.calls).toEqual([]);
  });
});

describe('extractDocument — destino é o DO DOCUMENTO, não o corrente da empresa', () => {
  /**
   * O cenário que motivou a ADR-1: a empresa já trocou de destino, e o
   * documento que está sendo REPROCESSADO ficou na configuração anterior.
   * Resolver pelo destino corrente buscaria o arquivo num bucket que existe e
   * simplesmente não tem o objeto.
   */
  it('reprocessamento de documento em configuração APOSENTADA resolve aquela configuração', async () => {
    const storage = makeStorage(makeDriver());
    const configAposentada = '99999999-9999-4999-8999-999999999999';

    await extractDocument(JOB, {
      storage,
      extractor: makeExtractor(),
      sql: makeSqlStub({
        originalFilename: 'contrato-antigo.pdf',
        storageConfigId: configAposentada,
      }),
      logger: makeSilentLogger(),
    });

    expect(storage.resolved).toEqual([`${TENANT_ID}/${configAposentada}`]);
    // Em nenhum momento perguntou "para onde esta empresa grava hoje?".
    expect(storage.tenants).toEqual([]);
  });

  it('documento ainda na plataforma (storage_config_id NULL) continua vindo do bucket do .env', async () => {
    const storage = makeStorage(makeDriver());

    await extractDocument(JOB, {
      storage,
      extractor: makeExtractor(),
      sql: makeSqlStub({ originalFilename: 'a.pdf', storageConfigId: null }),
      logger: makeSilentLogger(),
    });

    expect(storage.resolved).toEqual([`${TENANT_ID}/platform`]);
  });

  it('documento sumido entre enfileirar e processar cai no destino corrente da empresa', async () => {
    // Caso degenerado: sem linha não existe informação por documento. O
    // resultado prático é o mesmo (o objeto também não está lá), mas o caminho
    // fica explícito em vez de virar um `null` silencioso tratado como
    // plataforma.
    const storage = makeStorage(makeDriver());

    await extractDocument(JOB, {
      storage,
      extractor: makeExtractor(),
      sql: makeSqlStub({ originalFilename: null }),
      logger: makeSilentLogger(),
    });

    expect(storage.tenants).toEqual([TENANT_ID]);
    expect(storage.resolved).toEqual([]);
  });
});
