import { describe, expect, it, vi } from 'vitest';
import type { Db } from 'mongodb';
import type { Logger } from 'pino';
import type { DocumentProcessingJobData } from '@dmdoc/shared-types';
import { persistProcessingResult } from '../persist.js';
import type { ExtractResult } from '../extract.js';

/**
 * Testes do backfill de `pageCount` em `document_events` na etapa final do
 * pipeline (persistProcessingResult, caminho de sucesso → READY).
 *
 * Regra de negócio (wiki "Histórico de eventos de upload e relatório de uso"):
 * o evento de upload nasce com `pageCount: null` e é preenchido por backfill
 * quando o documento fica READY. O backfill é escopado por `tenantId` —
 * eventos de outra empresa com o mesmo `documentId` nunca são afetados.
 *
 * Não usamos Mongo real: um stub mínimo do `Db` mantém `document_events` em
 * memória e implementa apenas `updateMany` com filtro `{ tenantId, documentId }`
 * e `$set`. As demais coleções tocadas pelo persist (chunks, document_content,
 * documents) recebem stubs no-op — o foco aqui é o backfill e seu escopo.
 */

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';
const DOCUMENT_ID = '00000000-0000-0000-0000-000000000001';

interface UploadEvent {
  id: string;
  tenantId: string;
  documentId: string;
  pageCount: number | null;
}

interface UpdateFilter {
  tenantId?: string;
  documentId?: string;
}

interface SetUpdate {
  $set: { pageCount: number };
}

/**
 * Constrói um `Db` stub. `document_events` é a única coleção com comportamento
 * real (updateMany por { tenantId, documentId } + $set). As demais são no-op.
 */
function makeDbStub(events: UploadEvent[]): Db {
  const noop = {
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    insertMany: vi.fn().mockResolvedValue({ insertedCount: 0 }),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
  };

  const documentEvents = {
    updateMany: vi.fn(
      (filter: UpdateFilter, update: SetUpdate) => {
        let modifiedCount = 0;
        let matchedCount = 0;
        for (const ev of events) {
          if (ev.tenantId !== filter.tenantId) continue;
          if (ev.documentId !== filter.documentId) continue;
          matchedCount += 1;
          if (ev.pageCount !== update.$set.pageCount) {
            ev.pageCount = update.$set.pageCount;
            modifiedCount += 1;
          }
        }
        return Promise.resolve({ matchedCount, modifiedCount });
      }
    ),
  };

  const collection = vi.fn((name: string) => {
    if (name === 'document_events') return documentEvents;
    return noop;
  });

  return { collection } as unknown as Db;
}

function makeSilentLogger(): Logger {
  return {
    child: () => makeSilentLogger(),
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger;
}

function makeJob(tenantId: string): DocumentProcessingJobData {
  return {
    tenantId,
    documentId: DOCUMENT_ID,
    s3Key: `tenants/${tenantId}/documents/${DOCUMENT_ID}/file.pdf`,
    mimeType: 'application/pdf',
  };
}

function makeExtractResult(pageCount: number): ExtractResult {
  return {
    fullText: 'conteúdo extraído',
    pageCount,
    ocrPages: [],
    engine: 'native',
    engineVersion: '1.0.0',
    durationMs: 10,
    fromCache: false,
  };
}

describe('persistProcessingResult — backfill de pageCount em document_events', () => {
  it('preenche pageCount em todos os eventos do documentId no tenant', async () => {
    const events: UploadEvent[] = [
      { id: 'e1', tenantId: TENANT_A, documentId: DOCUMENT_ID, pageCount: null },
      { id: 'e2', tenantId: TENANT_A, documentId: DOCUMENT_ID, pageCount: null },
    ];
    const db = makeDbStub(events);

    await persistProcessingResult(
      {
        job: makeJob(TENANT_A),
        extractResult: makeExtractResult(7),
        embeddedChunks: [],
        totalEmbeddingsUsd: 0,
        pipelineStartedAt: new Date(),
      },
      { db, logger: makeSilentLogger() }
    );

    expect(events.every((e) => e.pageCount === 7)).toBe(true);
  });

  it('não afeta eventos de outro tenant com o mesmo documentId', async () => {
    const events: UploadEvent[] = [
      { id: 'a1', tenantId: TENANT_A, documentId: DOCUMENT_ID, pageCount: null },
      { id: 'b1', tenantId: TENANT_B, documentId: DOCUMENT_ID, pageCount: null },
    ];
    const db = makeDbStub(events);

    await persistProcessingResult(
      {
        job: makeJob(TENANT_A),
        extractResult: makeExtractResult(12),
        embeddedChunks: [],
        totalEmbeddingsUsd: 0,
        pipelineStartedAt: new Date(),
      },
      { db, logger: makeSilentLogger() }
    );

    const tenantAEvent = events.find((e) => e.id === 'a1');
    const tenantBEvent = events.find((e) => e.id === 'b1');
    expect(tenantAEvent?.pageCount).toBe(12);
    expect(tenantBEvent?.pageCount).toBeNull();
  });

  it('é idempotente: reexecutar com o mesmo pageCount mantém o resultado', async () => {
    const events: UploadEvent[] = [
      { id: 'e1', tenantId: TENANT_A, documentId: DOCUMENT_ID, pageCount: null },
    ];
    const db = makeDbStub(events);

    const run = (): Promise<void> =>
      persistProcessingResult(
        {
          job: makeJob(TENANT_A),
          extractResult: makeExtractResult(5),
          embeddedChunks: [],
          totalEmbeddingsUsd: 0,
          pipelineStartedAt: new Date(),
        },
        { db, logger: makeSilentLogger() }
      );

    await run();
    await run();

    expect(events[0]?.pageCount).toBe(5);
  });
});
