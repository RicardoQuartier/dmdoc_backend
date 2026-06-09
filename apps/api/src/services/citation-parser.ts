import type { Citation } from '@dmdoc/shared-types';

/**
 * Extrai citações do texto de resposta do LLM.
 *
 * O prompt `rag-answer-v1` instrui o modelo a referenciar documentos no formato:
 *   [doc:UUID, pág:N]  → com número de página
 *   [doc:UUID]         → sem número de página
 *
 * Este parser:
 * 1. Encontra todas as marcações via regex.
 * 2. Deduplicam por (documentId, pageNumber).
 * 3. Extrai o trecho de texto imediatamente antes da marcação como `excerpt`.
 *
 * Marcações malformadas (UUID inválido, etc.) são silenciosamente ignoradas —
 * a resposta ainda é válida, apenas a citação não é incluída.
 */
export function parseCitations(answerText: string): Citation[] {
  // Regex: [doc:UUID] ou [doc:UUID, pág:N]
  const CITATION_REGEX = /\[doc:([0-9a-f-]{36})(?:,\s*pág:(\d+))?\]/gi;

  const seen = new Set<string>();
  const citations: Citation[] = [];

  let match: RegExpExecArray | null;

  while ((match = CITATION_REGEX.exec(answerText)) !== null) {
    const documentId = match[1];
    const pageStr = match[2];

    if (!documentId) continue;

    const pageNumber = pageStr !== undefined ? parseInt(pageStr, 10) : null;
    const key = `${documentId}:${pageNumber}`;

    if (seen.has(key)) continue;
    seen.add(key);

    // Extrai até 200 chars antes da marcação como excerpt
    const startPos = Math.max(0, match.index - 200);
    const rawExcerpt = answerText.slice(startPos, match.index).trim();
    // Remove citações anteriores do excerpt
    const excerpt = rawExcerpt.replace(/\[doc:[^\]]+\]/g, '').trim();

    citations.push({ documentId, pageNumber, excerpt: excerpt.slice(-200) });
  }

  return citations;
}
