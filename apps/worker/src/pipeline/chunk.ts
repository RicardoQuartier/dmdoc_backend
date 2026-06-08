import { get_encoding } from 'tiktoken';

/**
 * Metadados de contexto necessários para montar o ChunkDraft.
 */
export interface ChunkDocumentMeta {
  documentId: string;
  tenantId: string;
  departmentId: string;
  documentTypeName: string | null;
}

/**
 * Rascunho de chunk antes de receber o embedding.
 *
 * Corresponde ao `ChunkSchema` de `@dmdoc/shared-types`, sem o campo
 * `embedding` (adicionado pela etapa `embed`) e sem `createdAt` (adicionado
 * pela etapa `persist`).
 */
export interface ChunkDraft {
  text: string;
  tokenCount: number;
  pageNumber: number | null;
  chunkIndex: number;
  documentId: string;
  tenantId: string;
  departmentId: string;
  documentTypeName: string | null;
}

const TARGET_TOKENS = 500;
const OVERLAP_TOKENS = 50;

/**
 * Encoding compatível com `text-embedding-3-small`.
 * Instanciado uma única vez por processo (o encoding é pesado para construir).
 */
let encoder: ReturnType<typeof get_encoding> | null = null;

function getEncoder(): ReturnType<typeof get_encoding> {
  if (!encoder) {
    // cl100k_base é o encoding correto para text-embedding-3-small
    encoder = get_encoding('cl100k_base');
  }
  return encoder;
}

/**
 * Conta o número de tokens de um texto usando o encoding cl100k_base.
 */
export function countTokens(text: string): number {
  return getEncoder().encode(text).length;
}

/**
 * Extrai os últimos `overlapTokens` tokens de um texto, retornando-os como string.
 * Usado para construir o overlap entre chunks consecutivos.
 */
function extractOverlapSuffix(text: string, overlapTokens: number): string {
  const enc = getEncoder();
  const tokens = enc.encode(text);
  if (tokens.length <= overlapTokens) {
    return text;
  }
  const overlapSlice = tokens.slice(tokens.length - overlapTokens);
  return new TextDecoder().decode(enc.decode(overlapSlice));
}

/**
 * Divide um texto em sentenças simples (split por '. ', '! ', '? ', '\n').
 * Preserva o separador ao final de cada sentença.
 */
function splitIntoSentences(text: string): string[] {
  const sentences: string[] = [];
  // Divide por terminadores de frase mantendo o terminador junto com o trecho anterior
  const parts = text.split(/(?<=[.!?])\s+/);
  for (const part of parts) {
    if (part.trim().length > 0) {
      sentences.push(part);
    }
  }
  return sentences.length > 0 ? sentences : [text];
}

/**
 * Quebra um parágrafo que excede `targetTokens` em sub-chunks por sentença.
 * Se uma sentença isolada ainda for maior que `targetTokens`, faz truncamento
 * hard com overlap.
 */
function splitLargeParagraph(
  paragraph: string,
  targetTokens: number,
  overlapTokens: number
): string[] {
  const enc = getEncoder();
  const sentences = splitIntoSentences(paragraph);
  const result: string[] = [];

  let currentText = '';
  let currentTokens = 0;

  for (const sentence of sentences) {
    const sentenceTokens = countTokens(sentence);

    // Sentença isolada já excede o alvo: truncamento hard com overlap
    if (sentenceTokens > targetTokens) {
      if (currentText.length > 0) {
        result.push(currentText.trim());
        currentText = extractOverlapSuffix(currentText, overlapTokens);
        currentTokens = countTokens(currentText);
      }

      const sentTokenArr = enc.encode(sentence);
      let offset = 0;
      while (offset < sentTokenArr.length) {
        const slice = sentTokenArr.slice(offset, offset + targetTokens);
        const sliceText = new TextDecoder().decode(enc.decode(slice));
        result.push(sliceText.trim());
        offset += targetTokens - overlapTokens;
      }
      currentText = '';
      currentTokens = 0;
      continue;
    }

    if (currentTokens + sentenceTokens > targetTokens && currentText.length > 0) {
      result.push(currentText.trim());
      currentText = extractOverlapSuffix(currentText, overlapTokens) + ' ' + sentence;
      currentTokens = countTokens(currentText);
    } else {
      currentText = currentText.length === 0 ? sentence : currentText + ' ' + sentence;
      currentTokens += sentenceTokens;
    }
  }

  if (currentText.trim().length > 0) {
    result.push(currentText.trim());
  }

  return result;
}

/**
 * Divide `fullText` em chunks semânticos de ~500 tokens com overlap de 50 tokens.
 *
 * Algoritmo:
 * 1. Quebra por parágrafos (`\n\n`).
 * 2. Acumula parágrafos até atingir `targetTokens`.
 * 3. Quando ultrapassar o alvo, fecha o chunk atual e inicia novo com overlap
 *    dos últimos `overlapTokens` tokens do chunk anterior.
 * 4. Parágrafos maiores que `targetTokens` são subdivididos por sentença.
 *    Se a sentença ainda for enorme, truncamento hard.
 *
 * Casos de borda:
 * - Texto vazio → retorna array vazio.
 * - Texto inteiro < targetTokens → retorna array com 1 chunk.
 * - Parágrafo gigante → subdivisão por sentença / truncamento.
 *
 * `pageNumber` é sempre `null` nesta implementação porque a extração `native`
 * não preserva informação de paginação por parágrafo. O `unstructured` retorna
 * página por elemento — suporte futuro via `documentMeta`.
 *
 * @param fullText  Texto completo extraído do documento.
 * @param meta      Metadados do documento (ids, tipo).
 * @param targetTokens  Alvo de tokens por chunk (default: 500).
 * @param overlapTokens Tokens de overlap entre chunks (default: 50).
 */
export function chunkText(
  fullText: string,
  meta: ChunkDocumentMeta,
  targetTokens: number = TARGET_TOKENS,
  overlapTokens: number = OVERLAP_TOKENS
): ChunkDraft[] {
  if (fullText.trim().length === 0) {
    return [];
  }

  const paragraphs = fullText.split(/\n\n+/).filter((p) => p.trim().length > 0);
  const chunks: ChunkDraft[] = [];
  let currentText = '';
  let currentTokens = 0;

  const flushChunk = (): void => {
    const text = currentText.trim();
    if (text.length === 0) return;
    chunks.push({
      text,
      tokenCount: countTokens(text),
      pageNumber: null,
      chunkIndex: chunks.length,
      documentId: meta.documentId,
      tenantId: meta.tenantId,
      departmentId: meta.departmentId,
      documentTypeName: meta.documentTypeName,
    });
  };

  for (const paragraph of paragraphs) {
    const paragraphTokens = countTokens(paragraph);

    // Parágrafo excede o alvo — precisa ser subdividido
    if (paragraphTokens > targetTokens) {
      // Flush do acumulado antes de processar este parágrafo grande
      if (currentText.length > 0) {
        flushChunk();
        currentText = extractOverlapSuffix(currentText, overlapTokens);
        currentTokens = countTokens(currentText);
      }

      const subChunks = splitLargeParagraph(paragraph, targetTokens, overlapTokens);
      for (const sub of subChunks) {
        if (currentText.length > 0) {
          const candidate = currentText + '\n\n' + sub;
          const candidateTokens = countTokens(candidate);
          if (candidateTokens > targetTokens) {
            flushChunk();
            currentText = extractOverlapSuffix(currentText, overlapTokens) + ' ' + sub;
            currentTokens = countTokens(currentText);
          } else {
            currentText = candidate;
            currentTokens = candidateTokens;
          }
        } else {
          currentText = sub;
          currentTokens = countTokens(sub);
        }
      }
      continue;
    }

    // Adicionar parágrafo ao acumulado
    const candidate =
      currentText.length === 0 ? paragraph : currentText + '\n\n' + paragraph;
    const candidateTokens = currentTokens + paragraphTokens;

    if (candidateTokens > targetTokens && currentText.length > 0) {
      // Flush e inicia novo chunk com overlap
      flushChunk();
      currentText = extractOverlapSuffix(currentText, overlapTokens) + '\n\n' + paragraph;
      currentTokens = countTokens(currentText);
    } else {
      currentText = candidate;
      currentTokens = candidateTokens;
    }
  }

  // Flush do restante
  if (currentText.trim().length > 0) {
    flushChunk();
  }

  // Re-numerar chunkIndex (já está correto, mas garantir consistência)
  return chunks.map((c, i) => ({ ...c, chunkIndex: i }));
}
