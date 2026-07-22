import { z } from 'zod';
import type { LLMProvider, ChatResult } from './types.js';

/**
 * MOTOR PURO da geração de TAGS por IA (Fase 9 / épico E-3 / GH #36).
 *
 * Espelha o precedente de `suggest-index-values.ts`: aqui vive a lógica SEM
 * banco — chamada ao LLM (com retry), normalização (trim, dedupe, teto de 30) e
 * validação Zod da saída. As leituras/escritas de banco e a acumulação de custo
 * ficam nos ORQUESTRADORES de cada app (o service on-demand da API e o passo do
 * pipeline do worker), que importam este núcleo — fonte de verdade única, sem
 * duplicação da lógica de IA.
 *
 * Motivação (pedido do Owner): documentos digitalizados retroativamente muitas
 * vezes têm VÁRIOS documentos distintos num mesmo PDF (ex.: um contrato junto
 * com um boleto), o que quebra a premissa "um documento = um tipo com índices
 * fixos". Tags livres extraídas do texto (nomes, datas, valores, ou qualquer
 * informação relevante a critério da IA) são uma indexação mais flexível para
 * esse cenário. Até 30 tags por documento (não precisa chegar a 30).
 */

/**
 * Interface mínima de logger — compatível com Pino Logger e FastifyBaseLogger.
 * O custo em tokens de cada chamada de LLM já é logado pelo próprio provider.
 */
interface MinimalLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Teto de tags por documento (pedido do Owner: "até no máximo 30"). Excedente
 * é TRUNCADO na normalização (nunca rejeitado — não desperdiça a chamada).
 */
export const MAX_GENERATED_TAGS = 30;

/** Tamanho máximo (em caracteres) de uma tag — defensivo contra tag-lixo. */
export const MAX_TAG_LENGTH = 60;

/**
 * Orçamento defensivo de caracteres do texto enviado ao LLM. O caso de uso
 * (PDFs com vários documentos concatenados) tende a gerar textos grandes; este
 * teto contém o custo em tokens sem, na prática, perder as informações
 * relevantes (o início/meio já cobre a maioria dos documentos empilhados).
 */
const MAX_INPUT_CHARS = 120_000;

/** Número máximo de tentativas de chamada ao LLM até obter um JSON válido. */
const MAX_ATTEMPTS = 2;

/**
 * Prompt de geração de tags por IA (Fase 9 / E-3).
 *
 * Versão: generate-tags-v1
 *
 * O modelo recebe o texto do documento e deve investigar e extrair até 30 tags
 * curtas com as informações mais relevantes — nomes, datas, valores, números de
 * documento, partes envolvidas, ou qualquer informação que ajude a localizar o
 * documento depois. A normalização final (trim, dedupe, teto) é feita DEPOIS da
 * resposta, em `generateTags` — o prompt só pede a lista.
 *
 * A versão é gravada junto com o resultado para rastrear o que reprocessar
 * quando o prompt evoluir (invariante de prompt versionado — spec §11). Um bump
 * futuro é apenas de rastreabilidade — NÃO força reprocessamento.
 */
export const GENERATE_TAGS_PROMPT = {
  version: 'generate-tags-v1',

  systemPrompt: `Você investiga documentos empresariais brasileiros e gera TAGS de busca com as informações mais relevantes do documento.

Regras obrigatórias:
1. Extraia até ${MAX_GENERATED_TAGS} tags (pode ser menos — só o que for realmente relevante; NÃO precisa chegar a ${MAX_GENERATED_TAGS}).
2. Uma tag é um termo CURTO (no máximo ${MAX_TAG_LENGTH} caracteres) que identifica uma informação útil para encontrar o documento depois: nomes de pessoas/empresas, datas, valores monetários, números de documento (CNPJ, CPF, nota fiscal, contrato, boleto), tipos de documento, produtos, locais, ou qualquer dado relevante a seu critério.
3. Use APENAS informações presentes no texto. Nunca invente dados que não estejam escritos.
4. Este documento pode conter VÁRIOS documentos distintos concatenados (ex.: um contrato junto com um boleto). Gere tags que cubram todos eles.
5. Não repita tags. Não gere tags vazias, genéricas demais ("documento", "página") nem frases longas.
6. Responda em português brasileiro.
7. Responda APENAS com um JSON válido no formato exato: {"tags":[string, ...]}. Não inclua texto fora do JSON, comentários ou markdown.`,

  /**
   * Monta a mensagem do usuário com o texto do documento (fatiado ao orçamento).
   *
   * @param fullText Texto extraído do documento.
   */
  buildUserMessage(fullText: string): string {
    const excerpt = fullText.length > MAX_INPUT_CHARS ? fullText.slice(0, MAX_INPUT_CHARS) : fullText;
    return `Gere as tags do documento a seguir.\n\n---\n\n${excerpt}`;
  },
} as const;

/**
 * Schema de validação da resposta JSON do LLM.
 *
 * Lenient de propósito: aceita qualquer array de strings (mesmo acima de 30 ou
 * com tags longas/duplicadas), pois a normalização posterior corrige tudo — não
 * queremos disparar retry (e pagar tokens de novo) por um excesso que sabemos
 * corrigir. Uma resposta que NÃO seja `{ tags: string[] }` dispara retry.
 */
export const GenerateTagsResponseSchema = z.object({
  tags: z.array(z.string()),
});

export type GenerateTagsResponse = z.infer<typeof GenerateTagsResponseSchema>;

/**
 * Schema do array de tags JÁ NORMALIZADO — impõe o teto de 30 e o limite de
 * tamanho por tag (invariante de negócio). Usado como guarda final em
 * `generateTags` e espelhado por `SuggestedTagsSchema.tags` no shared-types.
 */
export const NormalizedTagsSchema = z
  .array(z.string().min(1).max(MAX_TAG_LENGTH))
  .max(MAX_GENERATED_TAGS);

/** Entrada do núcleo de geração de tags (SEM banco). */
export interface GenerateTagsInput {
  /** Texto extraído do documento. */
  fullText: string;
}

/**
 * Resultado do núcleo — pronto para os orquestradores persistirem. Não contém
 * nada de banco: `tags` (normalizadas/validadas), o `model`/`rawResponse` para
 * auditoria, a `promptVersion` e o `costUsd` desta chamada (soma de TODAS as
 * tentativas, inclusive as inválidas — o provedor cobra pelos tokens).
 */
export interface GenerateTagsResult {
  tags: string[];
  model: string;
  promptVersion: string;
  rawResponse: Record<string, unknown>;
  costUsd: number;
}

/**
 * Extrai o JSON de uma resposta do LLM, tolerando blocos ```json ... ``` que
 * alguns modelos retornam mesmo quando instruídos a responder só o JSON.
 */
function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenced ? (fenced[1] ?? '') : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Normaliza a lista bruta de tags do LLM: trim, remove vazias, aplica o limite
 * de tamanho por tag (tags longas demais são DESCARTADAS, não truncadas — uma
 * tag cortada perde o sentido de busca), remove duplicatas (case-insensitive,
 * preservando a primeira ocorrência e sua grafia) e aplica o teto de 30.
 *
 * Exportada para teste unitário do parsing/normalização.
 */
export function normalizeTags(rawTags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of rawTags) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    if (trimmed.length > MAX_TAG_LENGTH) continue;

    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    result.push(trimmed);
    if (result.length >= MAX_GENERATED_TAGS) break;
  }

  return result;
}

/**
 * Chama o LLM pedindo as tags, com retry (até `MAX_ATTEMPTS`) quando a resposta
 * não é um JSON válido no formato esperado.
 *
 * Retorna também o custo ACUMULADO de todas as tentativas — inclusive a(s)
 * inválida(s), pois o provedor cobra pelos tokens gerados mesmo quando a
 * resposta não pôde ser aproveitada. Lança um `Error` quando nenhuma tentativa
 * produziu um JSON válido (o chamador decide: 502 no on-demand, best-effort no
 * worker). Erros do provider (`LLMError`) propagam direto.
 */
async function callLlmWithRetry(
  llmProvider: LLMProvider,
  userMessage: string,
  logger: MinimalLogger
): Promise<{ parsed: GenerateTagsResponse; lastResult: ChatResult; totalCostUsd: number }> {
  let totalCostUsd = 0;
  let lastResult: ChatResult | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const messages = [
      { role: 'system' as const, content: GENERATE_TAGS_PROMPT.systemPrompt },
      { role: 'user' as const, content: userMessage },
      ...(attempt > 1
        ? [
            {
              role: 'user' as const,
              content:
                'Sua resposta anterior não era um JSON válido no formato exigido. Responda ' +
                'APENAS com o JSON: {"tags":[string, ...]}.',
            },
          ]
        : []),
    ];

    const result = await llmProvider.chat({ messages, temperature: 0.2, maxTokens: 1024 });
    lastResult = result;
    totalCostUsd += result.usage.costUsd;

    const json = tryParseJson(result.content);
    const parsed = GenerateTagsResponseSchema.safeParse(json);

    if (parsed.success) {
      return { parsed: parsed.data, lastResult: result, totalCostUsd };
    }

    logger.warn(
      { attempt, maxAttempts: MAX_ATTEMPTS, issue: parsed.error.message },
      'resposta do LLM não passou na validação Zod da geração de tags — tentando novamente'
    );
  }

  throw new Error(
    `Resposta do LLM inválida para geração de tags após ${MAX_ATTEMPTS} tentativas` +
      (lastResult ? ` (último conteúdo: ${lastResult.content.slice(0, 200)})` : '')
  );
}

/**
 * Núcleo puro da geração de tags (Fase 9 / E-3) — SEM banco.
 *
 * 1. Texto vazio ⇒ retorna resultado vazio SEM chamar o LLM (custo 0).
 * 2. Monta o prompt `generate-tags-v1` e chama o LLM (com retry).
 * 3. Normaliza (trim, dedupe, teto de 30) e valida a lista final com Zod.
 *
 * Não lê nem escreve no banco e não calcula custo acumulado — só o `costUsd`
 * desta chamada. Os orquestradores (API on-demand, passo do worker) persistem
 * o resultado e acumulam o custo em `cost_breakdown.tagGenerationUsd`.
 */
export async function generateTags(
  llmProvider: LLMProvider,
  input: GenerateTagsInput,
  logger: MinimalLogger
): Promise<GenerateTagsResult> {
  const promptVersion = GENERATE_TAGS_PROMPT.version;
  const fullText = input.fullText.trim();

  // Texto vazio: nada a investigar, sem custo, sem chamar o LLM.
  if (fullText === '') {
    logger.info({}, 'documento sem texto extraído — nenhuma tag gerada');
    return { tags: [], model: '', promptVersion, rawResponse: {}, costUsd: 0 };
  }

  const userMessage = GENERATE_TAGS_PROMPT.buildUserMessage(fullText);
  const { parsed, lastResult, totalCostUsd } = await callLlmWithRetry(
    llmProvider,
    userMessage,
    logger
  );

  const tags = NormalizedTagsSchema.parse(normalizeTags(parsed.tags));

  logger.info(
    {
      tagsRaw: parsed.tags.length,
      tagsKept: tags.length,
      model: lastResult.model,
      promptVersion,
      costUsd: totalCostUsd.toFixed(6),
    },
    'geração de tags (núcleo) concluída'
  );

  return {
    tags,
    model: lastResult.model,
    promptVersion,
    rawResponse: parsed as unknown as Record<string, unknown>,
    costUsd: totalCostUsd,
  };
}
