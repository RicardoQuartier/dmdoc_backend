import { z } from 'zod';
import type { LLMProvider, TokenUsage } from './types.js';

/**
 * Interface mínima de logger — compatível com Pino e FastifyBaseLogger.
 * O service loga apenas suas próprias decisões (fallback, retry, skip). O custo
 * em tokens de cada chamada de LLM já é logado pelo próprio provider (ver
 * `OpenAIProvider.chat`), então aqui não reimplementamos esse log.
 */
interface MinimalLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Prompt de classificação automática de tipo de documento.
 *
 * Versão: classify-document-type-v1
 *
 * O modelo recebe um CATÁLOGO FECHADO de tipos (escopado ao departamento do
 * documento pelo chamador) e o início do texto extraído, e deve:
 * 1. Escolher o tipo pelo NOME EXATO da lista — ou `null` se nenhum se encaixa
 *    (nunca forçar uma escolha aproximada).
 * 2. Reportar uma confiança de 0 a 1.
 * 3. Sugerir um título de exibição legível (forward-compat da Fase 8.1 —
 *    a mesma chamada cobre classificação + título).
 *
 * A `description` de cada tipo entra no prompt como dica de classificação
 * (mesmo papel do `aiExtractionHint` por campo na Fase 7).
 *
 * A versão é gravada junto com o resultado para rastrear o que reprocessar
 * quando o prompt evoluir (invariante de prompt versionado — spec §11).
 */
export const CLASSIFY_DOCUMENT_TYPE_PROMPT = {
  version: 'classify-document-type-v1',

  systemPrompt: `Você classifica documentos empresariais dentro de um catálogo FECHADO de tipos e sugere um título de exibição.

Regras obrigatórias:
1. Escolha o tipo pelo NOME EXATO, exatamente como aparece na lista de tipos fornecida. Nunca invente um tipo fora da lista.
2. Se nenhum tipo da lista descrever bem o documento, retorne "documentTypeName": null — não force uma escolha aproximada.
3. Use a descrição de cada tipo como dica para decidir o encaixe.
4. "confidence" reflete sua certeza sobre o tipo escolhido, de 0 a 1. Se "documentTypeName" for null, "confidence" deve ser baixa (próxima de 0).
5. "suggestedTitle" é um título curto e legível gerado a partir do conteúdo do documento (não é o nome do arquivo). Se não for possível inferir, retorne null.
6. Responda em português brasileiro, em JSON estrito, contendo APENAS os campos "documentTypeName", "confidence" e "suggestedTitle". Sem texto fora do JSON.`,

  /**
   * Schema do que o LLM deve retornar. `suggestedTitle` é nullable (Fase 8.1) —
   * incluído sempre no schema (custo zero), mas descartado pela máscara de flags
   * quando `titleSuggestionEnabled === false`.
   */
  outputSchema: z.object({
    documentTypeName: z.string().nullable(),
    confidence: z.number().min(0).max(1),
    suggestedTitle: z.string().nullable(),
  }),

  /**
   * Monta a mensagem do usuário com o catálogo de tipos e o início do texto.
   *
   * Envia sempre NOMES + descrições dos tipos — NUNCA IDs. O `id` fica só do
   * lado do backend, que resolve `documentTypeName` → `documentTypeId` por match
   * exato após a resposta.
   *
   * @param text    Início do texto extraído do documento (já fatiado ao orçamento).
   * @param catalog Tipos visíveis para o departamento (name + description).
   */
  buildUserMessage(
    text: string,
    catalog: Array<{ name: string; description: string | null }>
  ): string {
    const catalogo = catalog
      .map((t) => `- ${t.name}${t.description ? `: ${t.description}` : ''}`)
      .join('\n');

    return `Tipos de documento disponíveis:\n${catalogo}\n\n---\n\nTexto do documento:\n${text}`;
  },
} as const;

/**
 * Fator de estimativa caracteres→tokens usado para fatiar o texto ao orçamento.
 *
 * O pipeline de chunking (`apps/worker/src/pipeline/chunk.ts`) conta tokens de
 * forma EXATA via `tiktoken` (encoding `cl100k_base`). Aqui, num pacote puro e
 * sem a dependência pesada do `tiktoken`, usamos a aproximação de referência de
 * ~4 caracteres por token — conservadora para pt-BR (que costuma ter menos de 4
 * caracteres/token, então tende a enviar UM POUCO menos que 3k tokens, nunca
 * mais). O corte serve só para limitar custo/latência: pega apenas o INÍCIO do
 * documento, onde o tipo e o título costumam ser evidentes.
 */
const CHARS_PER_TOKEN = 4;

/** Orçamento de entrada em tokens (spec §7/§11: "primeiros ~3k tokens"). */
const MAX_INPUT_TOKENS = 3_000;

/** Orçamento de entrada convertido para caracteres (~12.000). */
const MAX_INPUT_CHARS = MAX_INPUT_TOKENS * CHARS_PER_TOKEN;

/**
 * Teto de tokens da RESPOSTA. O JSON de saída é minúsculo (nome do tipo +
 * título curto + confiança), então um teto baixo basta e corta desperdício.
 */
const MAX_OUTPUT_TOKENS = 200;

/** Número máximo de tentativas de chamada+parse antes do fallback. */
const MAX_ATTEMPTS = 2;

/**
 * Item do catálogo de tipos visíveis para o departamento do documento.
 * `id` nunca vai para o prompt — só é usado para resolver o nome escolhido.
 */
export interface DocumentTypeCatalogItem {
  id: string;
  name: string;
  description: string | null;
}

/**
 * Flags de IA que controlam a MÁSCARA do resultado (Fase 6.9).
 *
 * A mesma chamada de LLM cobre classificação + título; estas flags decidem
 * quais campos do resultado sobrevivem:
 * - `classificationEnabled === false` ⇒ zera tipo (id/name null, confidence 0).
 * - `titleSuggestionEnabled === false` ⇒ zera `suggestedTitle`.
 */
export interface AiClassificationFlags {
  classificationEnabled: boolean;
  titleSuggestionEnabled: boolean;
}

/** Entrada do service de classificação. */
export interface ClassifyDocumentTypeInput {
  /** Texto completo extraído; será fatiado aos primeiros ~3k tokens. */
  text: string;
  /** Catálogo escopado ao departamento (resolvido pelo chamador). */
  catalog: DocumentTypeCatalogItem[];
  /** Flags efetivas de IA do tenant. */
  flags: AiClassificationFlags;
}

/**
 * Resultado da classificação — CONSULTIVO. Nunca sobrescreve a escolha manual
 * do usuário; o worker/endpoint mapeia isto para `DocumentContent.typeSuggestion`.
 *
 * `documentTypeId` é resolvido no backend por match exato do nome contra o
 * catálogo enviado — nunca confia em ID gerado pelo modelo, nunca faz fuzzy.
 */
export interface ClassificationResult {
  documentTypeId: string | null;
  documentTypeName: string | null;
  confidence: number;
  suggestedTitle: string | null;
  model: string;
  promptVersion: string;
  usage: TokenUsage;
  rawResponse: Record<string, unknown>;
}

const ZERO_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costUsd: 0,
};

/** Soma acumulada de uso entre tentativas (custo real = soma de todas as calls). */
function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

/**
 * Fatia o texto ao orçamento de entrada. Pega apenas o INÍCIO do documento —
 * onde o tipo e o título costumam ser evidentes.
 */
function sliceToInputBudget(text: string): string {
  if (text.length <= MAX_INPUT_CHARS) return text;
  return text.slice(0, MAX_INPUT_CHARS);
}

/**
 * Faz o parse do conteúdo do LLM como objeto JSON, tolerando cercas markdown
 * (```json ... ```) que alguns modelos adicionam. Retorna `null` se não for um
 * objeto JSON válido.
 */
function parseJsonObject(content: string): Record<string, unknown> | null {
  const withoutFences = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    const parsed: unknown = JSON.parse(withoutFences);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve o nome escolhido pelo modelo para um item do catálogo por match
 * EXATO case-insensitive (após trim). Sem correspondência ⇒ `null` (tratado
 * como "nenhum tipo", nunca como erro). NUNCA fuzzy, NUNCA usa ID do modelo.
 */
function resolveCatalogType(
  name: string | null,
  catalog: DocumentTypeCatalogItem[]
): { id: string; name: string } | null {
  if (name === null) return null;
  const target = name.trim().toLowerCase();
  if (target.length === 0) return null;
  const match = catalog.find((c) => c.name.trim().toLowerCase() === target);
  return match ? { id: match.id, name: match.name } : null;
}

/**
 * Aplica a máscara de flags de IA (Fase 6.9). Responsabilidade DESTE service:
 * quando invocado pelo caminho sob demanda, o endpoint pode ter só uma das
 * features ligada, então o campo da feature desligada é zerado mesmo que o LLM
 * o tenha gerado.
 */
function applyFlagMask(
  result: ClassificationResult,
  flags: AiClassificationFlags
): ClassificationResult {
  const masked: ClassificationResult = { ...result };
  if (!flags.classificationEnabled) {
    masked.documentTypeId = null;
    masked.documentTypeName = null;
    masked.confidence = 0;
  }
  if (!flags.titleSuggestionEnabled) {
    masked.suggestedTitle = null;
  }
  return masked;
}

/**
 * Classifica um documento contra um catálogo fechado de tipos e sugere um
 * título de exibição — numa ÚNICA chamada de LLM.
 *
 * Garantias:
 * - Nunca lança: falhas de API ou de parse viram fallback "nenhum tipo"
 *   (`documentTypeId: null, confidence: 0`) — não pode derrubar o pipeline.
 * - Resolve nome→id por match exato case-insensitive contra o catálogo enviado.
 *   Nome sem correspondência ⇒ "nenhum tipo".
 * - Catálogo vazio ⇒ retorna "nenhum tipo" SEM chamar o LLM (economia).
 * - Custo em tokens de cada call é logado pelo próprio provider.
 *
 * @param provider Adaptador de LLM (o mesmo `chat` que loga tokens+custo).
 * @param input    Texto, catálogo escopado e flags de IA efetivas.
 * @param logger   Logger para decisões do service (fallback/retry/skip).
 */
export async function classifyDocumentType(
  provider: LLMProvider,
  input: ClassifyDocumentTypeInput,
  logger: MinimalLogger
): Promise<ClassificationResult> {
  const { text, catalog, flags } = input;
  const promptVersion = CLASSIFY_DOCUMENT_TYPE_PROMPT.version;

  // Catálogo vazio: nenhum tipo é possível — não gasta uma chamada de LLM.
  if (catalog.length === 0) {
    logger.info({ promptVersion }, 'classificação pulada: catálogo de tipos vazio');
    return applyFlagMask(
      {
        documentTypeId: null,
        documentTypeName: null,
        confidence: 0,
        suggestedTitle: null,
        model: '',
        promptVersion,
        usage: ZERO_USAGE,
        rawResponse: {},
      },
      flags
    );
  }

  const excerpt = sliceToInputBudget(text);
  const messages = [
    { role: 'system' as const, content: CLASSIFY_DOCUMENT_TYPE_PROMPT.systemPrompt },
    {
      role: 'user' as const,
      content: CLASSIFY_DOCUMENT_TYPE_PROMPT.buildUserMessage(excerpt, catalog),
    },
  ];

  let usage: TokenUsage = ZERO_USAGE;
  let model = '';
  let rawResponse: Record<string, unknown> = {};
  let parsed: z.infer<typeof CLASSIFY_DOCUMENT_TYPE_PROMPT.outputSchema> | null = null;

  // 1 tentativa + 1 retry. Falha de API ou de parse não derruba o pipeline.
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && parsed === null; attempt++) {
    let content: string;
    try {
      const response = await provider.chat({
        messages,
        temperature: 0,
        maxTokens: MAX_OUTPUT_TOKENS,
      });
      model = response.model;
      usage = addUsage(usage, response.usage);
      content = response.content;
    } catch (err) {
      logger.warn(
        { promptVersion, attempt, err: err instanceof Error ? err.message : String(err) },
        'classificação: chamada ao LLM falhou'
      );
      continue;
    }

    const candidate = parseJsonObject(content);
    if (candidate !== null) {
      rawResponse = candidate;
    }

    const validated = CLASSIFY_DOCUMENT_TYPE_PROMPT.outputSchema.safeParse(candidate);
    if (validated.success) {
      parsed = validated.data;
    } else {
      logger.warn(
        { promptVersion, attempt, issues: validated.error.issues },
        'classificação: resposta do LLM inválida'
      );
    }
  }

  // Fallback: nenhuma resposta válida após retry ⇒ "nenhum tipo".
  if (parsed === null) {
    logger.warn(
      { promptVersion },
      'classificação sem resposta válida após retry — fallback nenhum tipo'
    );
    return applyFlagMask(
      {
        documentTypeId: null,
        documentTypeName: null,
        confidence: 0,
        suggestedTitle: null,
        model,
        promptVersion,
        usage,
        rawResponse,
      },
      flags
    );
  }

  // Resolve nome→id por match exato. Sem correspondência ⇒ "nenhum tipo",
  // mas o título (independente do tipo) é preservado.
  const match = resolveCatalogType(parsed.documentTypeName, catalog);

  return applyFlagMask(
    {
      documentTypeId: match ? match.id : null,
      documentTypeName: match ? match.name : null,
      confidence: match ? parsed.confidence : 0,
      suggestedTitle: parsed.suggestedTitle,
      model,
      promptVersion,
      usage,
      rawResponse,
    },
    flags
  );
}
