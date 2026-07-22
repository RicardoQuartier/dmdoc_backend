import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '@dmdoc/db-pg';
import type { ChatResult, LLMProvider } from '@dmdoc/llm-provider';
import { startTestDb, seedUser, type TestDb } from '../test/helpers.js';
import { ValidationError } from '../errors/index.js';
import { suggestDocumentIndexes } from './index-suggestion.js';

// ---------------------------------------------------------------------------
// Testes do service `suggestDocumentIndexes` — foco: o array `fields` devolvido
// (que a rota HTTP envia verbatim) é montado a partir dos campos REAIS do tipo
// do documento (`document_type_index_fields`), NUNCA da resposta crua do LLM.
// Um nome de campo alucinado pelo LLM jamais aparece no resultado.
// ---------------------------------------------------------------------------

const TENANT = crypto.randomUUID();
const DEPT_ID = newId();
const UPLOADER_ID = newId();
const DOC_TYPE_ID = newId();

const DISK_QUOTA = 10 * 1024 * 1024;

let testDb: TestDb;

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

/** Mock de LLMProvider que devolve um `content` fixo (JSON) na primeira chamada. */
function mockLlm(content: string): LLMProvider {
  const result: ChatResult = {
    content,
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, costUsd: 0.0002 },
    model: 'gpt-4o-mini',
  };
  return {
    chat: vi.fn().mockResolvedValue(result),
    chatStream: () => {
      throw new Error('não usado');
    },
  };
}

beforeAll(async () => {
  testDb = await startTestDb();
});

afterAll(async () => {
  await testDb.stop();
});

beforeEach(async () => {
  await testDb.db`DELETE FROM document_content`;
  await testDb.db`DELETE FROM documents`;
  await testDb.db`DELETE FROM document_type_index_fields`;
  await testDb.db`DELETE FROM document_types`;
  await testDb.db`DELETE FROM departments`;
  await testDb.db`DELETE FROM users WHERE tenant_id = ${TENANT}`;
  await testDb.db`DELETE FROM tenants WHERE id = ${TENANT}`;

  await testDb.db`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
    VALUES (${TENANT}, 'Empresa Sugestão', ${DISK_QUOTA}, 20, true, NOW())
  `;
  await testDb.db`
    INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, deleted, created_at)
    VALUES (${DEPT_ID}, ${TENANT}, NULL, 'Financeiro', 0, '{}'::text[], false, NOW())
  `;
  await seedUser(testDb.db, {
    id: UPLOADER_ID,
    tenantId: TENANT,
    email: 'uploader-sugestao@empresa.com',
    password: 'senha-forte-de-teste-123',
    role: 'UPLOADER',
  });
  await testDb.db`
    INSERT INTO document_types (id, tenant_id, name, description, is_global, index_fields, deleted, created_at)
    VALUES (${DOC_TYPE_ID}, ${TENANT}, 'Contrato', NULL, false, '[]'::jsonb, false, NOW())
  `;
  // Dois campos REAIS: "Cliente" (TEXT) e "Valor" (NUMBER).
  await testDb.db`
    INSERT INTO document_type_index_fields
      (id, document_type_id, name, field_type, required, ai_extraction_hint, sort_order, show_on_search, deleted)
    VALUES
      (${newId()}, ${DOC_TYPE_ID}, 'Cliente', 'TEXT', false, NULL, 0, true, false),
      (${newId()}, ${DOC_TYPE_ID}, 'Valor', 'NUMBER', false, NULL, 1, true, false)
  `;
});

async function seedReadyDoc(): Promise<string> {
  const docId = newId();
  const hash = crypto.randomBytes(32).toString('hex');
  await testDb.db`
    INSERT INTO documents (
      id, tenant_id, department_id, document_type_id,
      filename, original_filename, content_hash, size_bytes, mime_type,
      s3_key, status, failure_reason, tags, index_values,
      uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
    ) VALUES (
      ${docId}, ${TENANT}, ${DEPT_ID}, ${DOC_TYPE_ID},
      'contrato.pdf', 'contrato.pdf', ${hash}, 2048, 'application/pdf',
      ${`tenants/${TENANT}/documents/${hash}/contrato.pdf`}, 'READY', NULL, '{}'::text[], '{}'::jsonb,
      ${UPLOADER_ID}, NOW(), NOW(), 0, false
    )
  `;
  await testDb.db`
    INSERT INTO document_content (document_id, tenant_id, full_text, extraction)
    VALUES (${docId}, ${TENANT}, 'texto completo do contrato', ${testDb.db.json({ engine: 'native', pageCount: 1 })})
  `;
  return docId;
}

describe('suggestDocumentIndexes — campos alucinados nunca vazam', () => {
  it('descarta nome de campo inexistente no tipo e mantém apenas os campos reais', async () => {
    const docId = await seedReadyDoc();
    // O LLM devolve um campo real ("Cliente") + um campo ALUCINADO ("CampoFantasma").
    const llm = mockLlm(
      JSON.stringify({
        fields: [
          { name: 'Cliente', value: 'ACME Ltda', confidence: 0.9 },
          { name: 'CampoFantasma', value: 'lixo', confidence: 0.99 },
        ],
      })
    );

    const result = await suggestDocumentIndexes(
      { tenantId: TENANT, documentId: docId },
      { sql: testDb.db, llmProvider: llm, logger: silentLogger }
    );

    const names = result.fields.map((f) => f.name);
    // Só os campos reais do tipo aparecem — nunca o nome alucinado.
    expect(names).toEqual(['Cliente', 'Valor']);
    expect(names).not.toContain('CampoFantasma');

    // O campo real sugerido carrega valor + confiança casada.
    const cliente = result.fields.find((f) => f.name === 'Cliente');
    expect(cliente).toMatchObject({ value: 'ACME Ltda', confidence: 0.9 });

    // O campo real que o LLM NÃO sugeriu aparece com value null e confiança 0.
    const valor = result.fields.find((f) => f.name === 'Valor');
    expect(valor).toMatchObject({ value: null, confidence: 0 });

    // Nenhum vestígio do nome alucinado em nenhum lugar do resultado serializado.
    expect(JSON.stringify(result.fields)).not.toContain('CampoFantasma');
  });

  it('mesmo se o LLM devolver SÓ campos alucinados, fields fica só com os reais (todos null)', async () => {
    const docId = await seedReadyDoc();
    const llm = mockLlm(
      JSON.stringify({
        fields: [
          { name: 'Inexistente1', value: 'x', confidence: 0.8 },
          { name: 'Inexistente2', value: 'y', confidence: 0.7 },
        ],
      })
    );

    const result = await suggestDocumentIndexes(
      { tenantId: TENANT, documentId: docId },
      { sql: testDb.db, llmProvider: llm, logger: silentLogger }
    );

    expect(result.fields.map((f) => f.name)).toEqual(['Cliente', 'Valor']);
    expect(result.fields.every((f) => f.value === null && f.confidence === 0)).toBe(true);
    expect(JSON.stringify(result.fields)).not.toContain('Inexistente');
  });
});

/**
 * Caminho do WORKER (gatilho automático): o service aceita um `documentTypeId`
 * EXPLÍCITO (o tipo SUGERIDO pela classificação). Nesse caso NÃO lê nem exige
 * `documents.document_type_id` — CONSULTIVO, roda antes de o usuário confirmar
 * o tipo. Sem o explícito (caminho on-demand), o comportamento antigo é mantido.
 */
describe('suggestDocumentIndexes — documentTypeId explícito (caminho do worker)', () => {
  /** Doc READY com conteúdo, mas SEM tipo confirmado (document_type_id NULL). */
  async function seedReadyDocNoType(): Promise<string> {
    const docId = newId();
    const hash = crypto.randomBytes(32).toString('hex');
    await testDb.db`
      INSERT INTO documents (
        id, tenant_id, department_id, document_type_id,
        filename, original_filename, content_hash, size_bytes, mime_type,
        s3_key, status, failure_reason, tags, index_values,
        uploaded_by_id, uploaded_at, processed_at, cost_usd_cents, deleted
      ) VALUES (
        ${docId}, ${TENANT}, ${DEPT_ID}, ${null},
        'contrato.pdf', 'contrato.pdf', ${hash}, 2048, 'application/pdf',
        ${`tenants/${TENANT}/documents/${hash}/contrato.pdf`}, 'READY', NULL, '{}'::text[], '{}'::jsonb,
        ${UPLOADER_ID}, NOW(), NOW(), 0, false
      )
    `;
    await testDb.db`
      INSERT INTO document_content (document_id, tenant_id, full_text, extraction)
      VALUES (${docId}, ${TENANT}, 'texto completo do contrato', ${testDb.db.json({ engine: 'native', pageCount: 1 })})
    `;
    return docId;
  }

  it('usa o tipo SUGERIDO explícito sem exigir document_type_id confirmado', async () => {
    const docId = await seedReadyDocNoType();
    const llm = mockLlm(
      JSON.stringify({ fields: [{ name: 'Cliente', value: 'ACME Ltda', confidence: 0.9 }] })
    );

    const result = await suggestDocumentIndexes(
      { tenantId: TENANT, documentId: docId, documentTypeId: DOC_TYPE_ID },
      { sql: testDb.db, llmProvider: llm, logger: silentLogger }
    );

    // Casou os campos do tipo SUGERIDO, mesmo com document_type_id NULL no doc.
    expect(result.fields.map((f) => f.name)).toEqual(['Cliente', 'Valor']);
    expect(result.fields.find((f) => f.name === 'Cliente')?.value).toBe('ACME Ltda');

    // CONSULTIVO: não tocou o tipo confirmado (segue NULL).
    const rows = await testDb.db<Array<{ document_type_id: string | null }>>`
      SELECT document_type_id FROM documents WHERE id = ${docId}
    `;
    expect(rows[0]!.document_type_id).toBeNull();
  });

  it('on-demand (sem tipo explícito): lança ValidationError quando o doc não tem tipo', async () => {
    const docId = await seedReadyDocNoType();
    const llm = mockLlm(JSON.stringify({ fields: [] }));

    await expect(
      suggestDocumentIndexes(
        { tenantId: TENANT, documentId: docId },
        { sql: testDb.db, llmProvider: llm, logger: silentLogger }
      )
    ).rejects.toBeInstanceOf(ValidationError);
    // Sem tipo ⇒ nem chega a chamar o LLM.
    expect(llm.chat).not.toHaveBeenCalled();
  });
});
