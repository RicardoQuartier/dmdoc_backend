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
 * Teto de palavras-chave de reconhecimento renderizadas por tipo no prompt
 * (Fase 8, epic E-1). Defensivo: contém o custo em tokens quando o catálogo
 * inteiro entra em TODA chamada. Excedente é truncado silenciosamente. A API
 * (`document-types.ts`) valida a entrada com o MESMO teto.
 */
export const MAX_RECOGNITION_KEYWORDS_PER_TYPE = 20;

/**
 * Teto de caracteres das regras de desambiguação renderizadas por tipo no
 * prompt. Excedente é truncado (com reticências). A API valida com o mesmo teto.
 */
export const MAX_RECOGNITION_RULES_CHARS = 500;

/**
 * Prompt de classificação automática de tipo de documento.
 *
 * Versão: classify-document-type-v3
 *
 * O modelo recebe um CATÁLOGO FECHADO e NUMERADO de tipos (escopado ao
 * departamento do documento pelo chamador) e o início do texto extraído, e deve:
 * 1. Escolher o tipo pelo NÚMERO da lista numerada — ou `null` se nenhum se
 *    encaixa (nunca forçar uma escolha aproximada). Número fora da faixa é
 *    tratado como "nenhum tipo".
 * 2. Reportar uma confiança de 0 a 1.
 * 3. Sugerir um título de exibição legível (Fase 8.1 — a mesma chamada cobre
 *    classificação + título).
 *
 * SELEÇÃO POR ÍNDICE (v3): a v2 pedia o NOME EXATO do tipo e o backend resolvia
 * por match exato. Isso quebrava quando o modelo devolvia o nome BASE ("Boleto")
 * de um tipo com qualificador ("Boleto (QA E-1)", "Boleto Bancário"): o match
 * exato falhava e a sugestão correta era descartada silenciosamente (T-10). A
 * v3 pede o NÚMERO do tipo no catálogo numerado, eliminando a dependência de o
 * modelo ecoar o nome literalmente. CINTO E SUSPENSÓRIO: o backend ainda aceita
 * `documentTypeName` como campo opcional e resolve por nome EXATO como FALLBACK
 * quando o número vem ausente/inválido — estritamente superior à v2, sem
 * regressão possível.
 *
 * A `description` de cada tipo entra no prompt como dica de classificação
 * (mesmo papel do `aiExtractionHint` por campo na Fase 7). Cada tipo pode ainda
 * trazer SINAIS (palavras-chave) e REGRAS de desambiguação (inclusive
 * negativas) — usados para separar tipos parecidos (ex.: Boleto × Fatura ×
 * Recibo). Esses campos são renderizados apenas quando presentes.
 *
 * A versão é gravada junto com o resultado para rastrear o que reprocessar
 * quando o prompt evoluir (invariante de prompt versionado — spec §11). O bump
 * para v3 é apenas de rastreabilidade — NÃO força reprocessamento.
 */
export const CLASSIFY_DOCUMENT_TYPE_PROMPT = {
  version: 'classify-document-type-v3',

  systemPrompt: `Você classifica documentos empresariais dentro de um catálogo FECHADO e NUMERADO de tipos e sugere um título de exibição.

Regras obrigatórias:
1. Escolha o tipo pelo NÚMERO que aparece à esquerda de cada tipo na lista numerada (ex.: se o tipo certo é "3. Boleto (QA E-1)", retorne "documentTypeNumber": 3). Nunca invente um número fora da lista.
2. Se nenhum tipo da lista descrever bem o documento, retorne "documentTypeNumber": null — não force uma escolha aproximada. Um número fora da faixa da lista também é tratado como "nenhum tipo".
3. Use a descrição de cada tipo como dica para decidir o encaixe.
4. Quando um tipo trouxer "Sinais" (palavras-chave) ou "Regras", use-os para desambiguar entre tipos parecidos. As regras podem ser NEGATIVAS (ex.: "NÃO classifique como X se..."): respeite-as — se uma regra negativa se aplicar ao documento, NÃO escolha aquele tipo.
5. "confidence" reflete sua certeza sobre o tipo escolhido, de 0 a 1. Se "documentTypeNumber" for null, "confidence" deve ser baixa (próxima de 0).
6. "suggestedTitle" é um título curto e legível gerado a partir do conteúdo do documento (não é o nome do arquivo). Se não for possível inferir, retorne null.
7. Responda em português brasileiro, em JSON estrito, contendo APENAS os campos "documentTypeNumber", "confidence" e "suggestedTitle". Sem texto fora do JSON.`,

  /**
   * Schema do que o LLM deve retornar.
   *
   * `documentTypeNumber` (v3) é o índice 1-based do tipo escolhido no catálogo
   * numerado — o caminho PRIMÁRIO de resolução. `documentTypeName` permanece
   * aceito (opcional) como CINTO E SUSPENSÓRIO: se o número vier ausente/nulo, o
   * backend tenta resolver por nome EXATO como na v2 (sem regressão). Ambos são
   * opcionais/nullable para que uma resposta com só um deles ainda valide.
   * `suggestedTitle` é nullable (Fase 8.1) — sempre no schema (custo zero), mas
   * descartado pela máscara de flags quando `titleSuggestionEnabled === false`.
   */
  outputSchema: z.object({
    documentTypeNumber: z.number().int().nullable().optional(),
    documentTypeName: z.string().nullable().optional(),
    confidence: z.number().min(0).max(1),
    suggestedTitle: z.string().nullable(),
  }),

  /**
   * Monta a mensagem do usuário com o catálogo NUMERADO de tipos e o início do
   * texto.
   *
   * Envia sempre NÚMERO + NOME + descrição dos tipos — NUNCA IDs. O `id` fica só
   * do lado do backend, que resolve o `documentTypeNumber` escolhido → índice do
   * catálogo → `documentTypeId`. O nome ainda vai no prompt (legibilidade para o
   * modelo e fallback de resolução por nome exato no backend), mas a seleção é
   * pelo NÚMERO — o modelo não precisa ecoar o nome literalmente.
   *
   * Cada tipo pode acrescentar — SÓ quando presentes — uma linha `Sinais:`
   * (palavras-chave) e/ou uma linha `Regras:` (desambiguação). Tetos defensivos
   * por tipo (`MAX_RECOGNITION_KEYWORDS_PER_TYPE`, `MAX_RECOGNITION_RULES_CHARS`)
   * contêm o custo em tokens.
   *
   * @param text    Início do texto extraído do documento (já fatiado ao orçamento).
   * @param catalog Tipos visíveis para o departamento (name + description +
   *                sinais/regras opcionais). A ordem define o NÚMERO de cada tipo
   *                (1-based) — deve ser a MESMA lista usada na resolução.
   */
  buildUserMessage(
    text: string,
    catalog: Array<{
      name: string;
      description: string | null;
      recognitionKeywords?: string[];
      recognitionRules?: string | null;
    }>
  ): string {
    const catalogo =
      catalog.length === 0
        ? '(nenhum tipo disponível — retorne documentTypeNumber: null, mas ainda sugira um título)'
        : catalog.map((t, i) => renderCatalogType(t, i + 1)).join('\n');

    return `Tipos de documento disponíveis:\n${catalogo}\n\n---\n\nTexto do documento:\n${text}`;
  },
} as const;

/**
 * Renderiza UM tipo do catálogo para o prompt, prefixado pelo seu NÚMERO
 * (1-based) — é esse número que o modelo retorna em `documentTypeNumber`. A
 * linha base é `{index}. {name}[: {description}]`. As linhas `Sinais:` e
 * `Regras:` só aparecem quando há conteúdo, com os tetos defensivos aplicados.
 */
function renderCatalogType(
  t: {
    name: string;
    description: string | null;
    recognitionKeywords?: string[];
    recognitionRules?: string | null;
  },
  index: number
): string {
  let line = `${index}. ${t.name}${t.description ? `: ${t.description}` : ''}`;

  const keywords = (t.recognitionKeywords ?? [])
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    .slice(0, MAX_RECOGNITION_KEYWORDS_PER_TYPE);
  if (keywords.length > 0) {
    line += `\n  Sinais: ${keywords.join(', ')}`;
  }

  const rules = (t.recognitionRules ?? '').trim();
  if (rules.length > 0) {
    const truncated =
      rules.length > MAX_RECOGNITION_RULES_CHARS
        ? `${rules.slice(0, MAX_RECOGNITION_RULES_CHARS)}…`
        : rules;
    line += `\n  Regras: ${truncated}`;
  }

  return line;
}

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
  /**
   * Palavras/expressões-sinal do tipo (Fase 8, epic E-1). Renderizadas no prompt
   * como linha `Sinais:` quando presentes. Opcional para retrocompatibilidade
   * com chamadores que ainda não carregam o campo (o prompt trata como ausente).
   */
  recognitionKeywords?: string[];
  /**
   * Regras de desambiguação em texto livre — inclusive negativas. Renderizadas
   * no prompt como linha `Regras:` quando presentes.
   */
  recognitionRules?: string | null;
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
 * `documentTypeId` é resolvido no backend pelo NÚMERO escolhido (índice 1-based
 * do catálogo enviado) e, como fallback, por match exato do nome — nunca confia
 * em ID gerado pelo modelo, nunca faz fuzzy.
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
 * Resolve o NÚMERO escolhido pelo modelo (1-based, na ordem do catálogo enviado
 * ao prompt) para um item do catálogo. Caminho PRIMÁRIO de resolução na v3.
 *
 * Valida a faixa `1..catalog.length`: um número ausente, não inteiro ou fora da
 * faixa ⇒ `null` (tratado como "nenhum tipo" — preserva o invariante "nenhum
 * tipo quando não há encaixe", inclusive quando o modelo alucina um índice).
 */
function resolveByIndex(
  n: number | null | undefined,
  catalog: DocumentTypeCatalogItem[]
): { id: string; name: string } | null {
  if (n === null || n === undefined || !Number.isInteger(n)) return null;
  if (n < 1 || n > catalog.length) return null;
  const item = catalog[n - 1];
  return item ? { id: item.id, name: item.name } : null;
}

/**
 * FALLBACK (v2): resolve o nome escolhido pelo modelo para um item do catálogo
 * por match EXATO case-insensitive (após trim). Usado só quando a resolução por
 * índice não deu resultado. Sem correspondência ⇒ `null` (tratado como "nenhum
 * tipo", nunca como erro). NUNCA fuzzy, NUNCA usa ID do modelo.
 */
function resolveCatalogType(
  name: string | null | undefined,
  catalog: DocumentTypeCatalogItem[]
): { id: string; name: string } | null {
  if (name === null || name === undefined) return null;
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
 * - Catálogo vazio + título DESLIGADO ⇒ retorna "nenhum tipo" SEM chamar o LLM
 *   (economia). Com título LIGADO, ainda chama o LLM para sugerir só o título
 *   (o tipo resolve para null) — o título independe do catálogo de tipos.
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

  // Catálogo vazio: nenhum TIPO é possível (nenhum nome pode bater). Mas a
  // sugestão de TÍTULO é INDEPENDENTE do catálogo de tipos — regra de negócio:
  // "a sugestão de título não depende do tipo; roda mesmo em documentos ainda
  // sem tipo definido". Portanto:
  // - título LIGADO  ⇒ segue para a chamada de LLM (caminho só-título; o tipo
  //   resolve para null naturalmente, pois o catálogo enviado está vazio).
  // - título DESLIGADO ⇒ não há nada a ganhar com a chamada: pula (economia).
  if (catalog.length === 0 && !flags.titleSuggestionEnabled) {
    logger.info(
      { promptVersion },
      'classificação pulada: catálogo vazio e título desligado'
    );
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

  // Resolução v3: NÚMERO → índice do catálogo (primário). Se ausente/inválido,
  // FALLBACK por nome EXATO (comportamento v2). Sem nenhum dos dois ⇒ "nenhum
  // tipo", mas o título (independente do tipo) é preservado.
  const match =
    resolveByIndex(parsed.documentTypeNumber, catalog) ??
    resolveCatalogType(parsed.documentTypeName, catalog);

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
