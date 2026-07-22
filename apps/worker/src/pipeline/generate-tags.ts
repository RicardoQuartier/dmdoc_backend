import type { Sql, JSONValue } from 'postgres';
import type { Logger } from 'pino';
import { resolveAiFeatureFlags } from '@dmdoc/db-pg';
import { generateTags, type LLMProvider } from '@dmdoc/llm-provider';
import type { CostBreakdown } from '@dmdoc/shared-types';

/**
 * Parâmetros da etapa de geração automática de tags por IA (Fase 9 / E-3) no
 * pipeline do worker (GATILHO no upload).
 *
 * Roda APÓS o `persist` (o `document_content.full_text` já existe). Diferente da
 * sugestão de índices, NÃO depende do tipo (sugerido ou confirmado): as tags são
 * livres, extraídas direto do texto — cobrem inclusive o caso de vários
 * documentos concatenados num mesmo PDF.
 */
export interface GenerateTagsStepParams {
  tenantId: string;
  documentId: string;
}

export interface GenerateTagsStepDeps {
  sql: Sql;
  llmProvider: LLMProvider;
  logger: Logger;
}

/**
 * Etapa de geração automática de tags do pipeline do worker (Fase 9 / E-3).
 * ORQUESTRADOR best-effort — espelha o padrão de `suggest-indexes.ts`: a lógica
 * de IA vive no núcleo compartilhado (`generateTags` de `@dmdoc/llm-provider`);
 * aqui ficam só o gating, as leituras/escritas de banco e a acumulação de custo.
 *
 * Dispara SOMENTE quando `tagGenerationEnabled` (plataforma AND empresa) está
 * ligada. Feature desligada ⇒ pula sem custo (não é erro).
 *
 * CONSULTIVA: grava apenas `document_content.suggested_tags` (sugestão) — NUNCA
 * escreve em `documents.tags` (as tags CONFIRMADAS pelo usuário).
 *
 * BEST-EFFORT: qualquer erro (LLM fora do ar, resposta inválida, banco) é logado
 * como `warn` e NÃO derruba o pipeline — o documento já está READY.
 *
 * IDEMPOTENTE: reprocessar re-roda a etapa e sobrescreve `suggested_tags`; o
 * custo (`tagGenerationUsd`) é sempre ACUMULADO — inclui tentativas de retry.
 */
export async function generateTagsStep(
  params: GenerateTagsStepParams,
  deps: GenerateTagsStepDeps
): Promise<void> {
  const { tenantId, documentId } = params;
  const { sql, llmProvider, logger: baseLogger } = deps;

  const log = baseLogger.child({ tenantId, documentId, step: 'generate-tags' });

  try {
    // 1. Feature flag efetiva (plataforma AND empresa).
    const flags = await resolveAiFeatureFlags(sql, tenantId);
    if (!flags.tagGenerationEnabled) {
      log.info(
        { tagGenerationEnabled: false, reason: 'feature-desligada' },
        'geração automática de tags pulada: feature desabilitada para a empresa'
      );
      return;
    }

    // 2. Conteúdo extraído (texto completo) + custo já acumulado.
    const contentRows = await sql<
      Array<{ full_text: string; cost_breakdown: CostBreakdown | null }>
    >`
      SELECT full_text, cost_breakdown
      FROM document_content
      WHERE document_id = ${documentId}
        AND tenant_id = ${tenantId}
      LIMIT 1
    `;
    const content = contentRows[0];
    if (!content) {
      log.warn({}, 'geração automática de tags pulada: document_content ausente');
      return;
    }

    // 3. Núcleo compartilhado: LLM + normalize + validate (SEM banco).
    const core = await generateTags(llmProvider, { fullText: content.full_text }, log);

    // Sem chamada (texto vazio) ⇒ nada a persistir, sem custo.
    if (core.model === '') {
      log.info({}, 'geração automática de tags: sem texto para investigar — nada persistido');
      return;
    }

    // 4. Persiste suggested_tags + custo acumulado (nunca sobrescreve
    //    extraction/embeddings/classification/suggestion). Escopado por tenant.
    const existingBreakdown: CostBreakdown = content.cost_breakdown ?? {
      extractionUsd: 0,
      embeddingsUsd: 0,
      suggestionUsd: 0,
      classificationUsd: 0,
      tagGenerationUsd: 0,
      totalUsd: 0,
    };
    const newTagGenerationUsd = (existingBreakdown.tagGenerationUsd ?? 0) + core.costUsd;
    const newCostBreakdown: CostBreakdown = {
      extractionUsd: existingBreakdown.extractionUsd,
      embeddingsUsd: existingBreakdown.embeddingsUsd,
      suggestionUsd: existingBreakdown.suggestionUsd,
      classificationUsd: existingBreakdown.classificationUsd,
      tagGenerationUsd: newTagGenerationUsd,
      totalUsd:
        existingBreakdown.extractionUsd +
        existingBreakdown.embeddingsUsd +
        existingBreakdown.suggestionUsd +
        existingBreakdown.classificationUsd +
        newTagGenerationUsd,
    };

    const generatedAt = new Date();
    // jsonb sempre via `sql.json(...)` — NUNCA `JSON.stringify` (double-encoding).
    await sql`
      UPDATE document_content
      SET suggested_tags = ${sql.json({
        tags: core.tags,
        model: core.model,
        promptVersion: core.promptVersion,
        generatedAt: generatedAt.toISOString(),
        rawResponse: core.rawResponse,
      } as unknown as JSONValue)},
          cost_breakdown = ${sql.json(newCostBreakdown)}
      WHERE document_id = ${documentId}
        AND tenant_id = ${tenantId}
    `;

    // documents.cost_usd_cents SEMPRE incrementado, nunca sobrescrito.
    const deltaCents = Math.ceil(core.costUsd * 100);
    if (deltaCents > 0) {
      await sql`
        UPDATE documents
        SET cost_usd_cents = cost_usd_cents + ${deltaCents}
        WHERE id = ${documentId}
          AND tenant_id = ${tenantId}
      `;
    }

    log.info(
      {
        tagsGenerated: core.tags.length,
        model: core.model,
        promptVersion: core.promptVersion,
        tagGenerationUsd: core.costUsd.toFixed(6),
      },
      'geração automática de tags concluída'
    );
  } catch (err: unknown) {
    // Best-effort: NUNCA derruba o pipeline. O documento já está READY.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'geração automática de tags falhou — seguindo sem tags (best-effort)'
    );
  }
}
