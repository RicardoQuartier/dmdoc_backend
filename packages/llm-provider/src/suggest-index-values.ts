import { z } from 'zod';
import type { LLMProvider, ChatResult } from './types.js';

/**
 * MOTOR PURO da sugestão de valores de índice por IA (Fase 7).
 *
 * Espelha o precedente de `classify-document-type.ts`: aqui vive a lógica SEM
 * banco — chamada ao LLM (com retry), normalização de formatos pt-BR e
 * validação de cada valor contra os campos do tipo. As leituras/escritas de
 * banco e o cálculo/acumulação de custo ficam nos ORQUESTRADORES de cada app
 * (o service on-demand da API e o passo do pipeline do worker), que importam
 * este núcleo — fonte de verdade única, sem duplicação da lógica de IA.
 *
 * Também é aqui que moram `validateIndexValues`, `normalizeDatePtBr`,
 * `normalizeNumberPtBr`, `IndexFieldRow` e o prompt `suggest-indexes-v1` —
 * antes espalhados em `apps/api/src/lib` e `apps/api/src/prompts`. O PATCH
 * `/documents/:id` (validação de valores salvos pelo usuário) e ambos os
 * caminhos de sugestão consomem esta MESMA `validateIndexValues`.
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

// ===========================================================================
// Definição de campo de índice + validação (antes em apps/api/src/lib)
// ===========================================================================

/** Linha de `document_type_index_fields`. */
export interface IndexFieldRow {
  id: string;
  name: string;
  field_type: 'TEXT' | 'DATE' | 'NUMBER';
  required: boolean;
  ai_extraction_hint: string | null;
  sort_order: number;
  show_on_search: boolean;
  deleted: boolean;
}

/**
 * Valida os valores de `indexValues` contra os `indexFields` do tipo de documento.
 *
 * Retorna lista de erros (vazia = válido). Mesma regra aplicada ao salvar
 * manualmente (PATCH /documents/:id) e ao validar as sugestões da IA — nunca se
 * expõe ao usuário uma sugestão que o PATCH rejeitaria ao salvar.
 */
export function validateIndexValues(
  indexValues: Record<string, string | number | null>,
  indexFields: IndexFieldRow[]
): string[] {
  const activeFields = indexFields.filter((f) => !f.deleted);
  const errors: string[] = [];

  for (const field of activeFields) {
    const value = indexValues[field.name];

    if (field.required && (value === undefined || value === null || value === '')) {
      errors.push(`Campo obrigatório ausente: "${field.name}"`);
      continue;
    }

    if (value === undefined || value === null) {
      continue;
    }

    switch (field.field_type) {
      case 'TEXT': {
        if (typeof value !== 'string' || value.trim() === '') {
          errors.push(`Campo "${field.name}" deve ser texto não vazio`);
        } else if (value.length > 500) {
          errors.push(`Campo "${field.name}" excede 500 caracteres`);
        }
        break;
      }
      case 'DATE': {
        const dateStr = String(value);
        if (!/^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/.test(dateStr) || isNaN(Date.parse(dateStr))) {
          errors.push(`Campo "${field.name}" deve ser uma data válida no formato ISO 8601`);
        }
        break;
      }
      case 'NUMBER': {
        const num = typeof value === 'number' ? value : parseFloat(String(value));
        if (!isFinite(num)) {
          errors.push(`Campo "${field.name}" deve ser um número válido`);
        }
        break;
      }
    }
  }

  return errors;
}

// ===========================================================================
// Normalização de formatos pt-BR (antes em apps/api/src/lib)
// ===========================================================================

const MESES_PT_BR: Record<string, string> = {
  janeiro: '01',
  fevereiro: '02',
  março: '03',
  marco: '03',
  abril: '04',
  maio: '05',
  junho: '06',
  julho: '07',
  agosto: '08',
  setembro: '09',
  outubro: '10',
  novembro: '11',
  dezembro: '12',
};

/** Formato ISO 8601 já aceito por `validateIndexValues` (mesma regex). */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/;

/** `DD/MM/AAAA` ou `D/M/AAAA` — separador `/` ou `-`. */
const DATE_DDMMYYYY_RE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;

/** Data por extenso: "31 de dezembro de 2026" (aceita "1º de janeiro de 2025"). */
const DATE_EXTENSO_RE = /^(\d{1,2})º?\s*de\s+([a-zçãéô]+)\s+de\s+(\d{4})$/i;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Normaliza uma data sugerida pela IA em formato pt-BR comum para ISO 8601
 * (`AAAA-MM-DD`). Retorna `null` quando o formato não é reconhecido ou os
 * componentes da data são inválidos (ex.: mês 13, dia 32).
 *
 * Regra de negócio: ambiguidade `DD/MM` vs `MM/DD` é SEMPRE resolvida como
 * `DD/MM` (locale do projeto).
 */
export function normalizeDatePtBr(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  // Já está no formato canônico — passa direto (evita reformatar à toa).
  if (ISO_DATE_RE.test(trimmed)) {
    return trimmed;
  }

  const ddmmyyyy = DATE_DDMMYYYY_RE.exec(trimmed);
  if (ddmmyyyy) {
    // Ambiguidade DD/MM vs MM/DD sempre resolvida como DD/MM (locale do projeto).
    const day = Number(ddmmyyyy[1]);
    const month = Number(ddmmyyyy[2]);
    const year = Number(ddmmyyyy[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }

  const extenso = DATE_EXTENSO_RE.exec(trimmed);
  if (extenso) {
    const day = Number(extenso[1]);
    const monthName = (extenso[2] ?? '').toLowerCase();
    const year = Number(extenso[3]);
    const month = MESES_PT_BR[monthName];
    if (!month || day < 1 || day > 31) return null;
    return `${year}-${month}-${pad2(day)}`;
  }

  return null;
}

/** `1.234,56` ou `1234,56` — separador de milhar `.` e decimal `,`. */
const NUMBER_PT_BR_THOUSANDS_RE = /^-?\d{1,3}(\.\d{3})*(,\d+)?$/;
/** `1234,56` sem separador de milhar. */
const NUMBER_PT_BR_DECIMAL_RE = /^-?\d+,\d+$/;

/**
 * Normaliza um número sugerido pela IA em formato pt-BR (separador de milhar
 * `.`, decimal `,`, possível prefixo `R$`) para o formato numérico canônico
 * (ponto decimal, sem separador de milhar) exigido por `validateIndexValues`.
 * Retorna `null` quando não é possível interpretar como número.
 */
export function normalizeNumberPtBr(raw: string): string | null {
  let s = raw.trim();
  if (s === '') return null;

  // Remove símbolo de moeda e espaços (ex.: "R$ 1.234,56" → "1.234,56").
  s = s.replace(/^R\$\s*/i, '').replace(/\s+/g, '');

  if (NUMBER_PT_BR_THOUSANDS_RE.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (NUMBER_PT_BR_DECIMAL_RE.test(s)) {
    s = s.replace(',', '.');
  }

  const num = Number(s);
  if (!isFinite(num)) return null;
  return String(num);
}

// ===========================================================================
// Prompt suggest-indexes-v1 (antes em apps/api/src/prompts)
// ===========================================================================

/**
 * Prompt de sugestão de valores de índice por IA (Fase 7).
 *
 * Versão: suggest-indexes-v1
 *
 * O modelo recebe o TEXTO COMPLETO do documento (nunca truncado — diferente da
 * classificação de tipo, que só usa o início) e a lista de campos de índice do
 * tipo de documento e deve, para cada campo, sugerir um valor encontrado
 * literalmente no texto — ou `null` quando não encontrar.
 *
 * A normalização de formatos pt-BR e a validação final contra
 * `validateIndexValues` acontecem DEPOIS da resposta do LLM, em
 * `suggestIndexValues` — o prompt só pede o valor "como está no texto".
 */
export const SUGGEST_INDEXES_PROMPT = {
  version: 'suggest-indexes-v1',

  systemPrompt: `Você extrai valores de campos de índice de documentos empresariais brasileiros.

Regras obrigatórias:
1. Use APENAS informações literalmente presentes no texto do documento fornecido. Nunca invente ou infira um valor que não esteja escrito no texto.
2. Para cada campo solicitado, procure o valor em QUALQUER parte do texto — o valor pode estar no início, meio ou fim do documento.
3. Use a "dica de extração" de cada campo (quando houver) para saber onde ou como procurar o valor.
4. Se não encontrar um valor claro e confiável para um campo, retorne "value": null e "confidence" baixa (0 a 0.3) para esse campo — nunca invente.
5. Retorne o valor exatamente como aparece no texto (ex.: datas como escritas, valores monetários com "R$" se assim aparecerem) — a normalização de formato é feita depois, por outra etapa do sistema.
6. Responda em português brasileiro.
7. Responda APENAS com um JSON válido no formato exato: {"fields":[{"name":string,"value":string|null,"confidence":number}]}. Não inclua texto fora do JSON, comentários ou markdown.`,

  /**
   * Monta a mensagem do usuário com o texto completo do documento e os
   * campos de índice a extrair.
   *
   * @param fullText Texto completo extraído do documento (sem truncar).
   * @param fields   Campos de índice do tipo de documento.
   */
  buildUserMessage(
    fullText: string,
    fields: Array<{
      name: string;
      fieldType: 'TEXT' | 'DATE' | 'NUMBER';
      required: boolean;
      aiExtractionHint: string | null;
    }>
  ): string {
    const fieldsFormatted = fields
      .map((f) => {
        const hint = f.aiExtractionHint ? ` — dica: ${f.aiExtractionHint}` : '';
        const requiredLabel = f.required ? 'obrigatório' : 'opcional';
        return `- "${f.name}" (tipo: ${f.fieldType}, ${requiredLabel})${hint}`;
      })
      .join('\n');

    return `Campos a extrair:\n${fieldsFormatted}\n\n---\n\nTexto completo do documento:\n\n${fullText}`;
  },
} as const;

/**
 * Schema de validação da resposta JSON do LLM para a sugestão de índices.
 *
 * Validado com `safeParse` — resposta inválida (JSON malformado ou fora do
 * schema) dispara uma nova tentativa antes de desistir.
 */
export const SuggestIndexesResponseSchema = z.object({
  fields: z.array(
    z.object({
      name: z.string().min(1),
      value: z.string().nullable(),
      confidence: z.number().min(0).max(1),
    })
  ),
});

export type SuggestIndexesResponse = z.infer<typeof SuggestIndexesResponseSchema>;

// ===========================================================================
// Núcleo: LLM + retry + normalize + validate (SEM banco)
// ===========================================================================

/** Número máximo de tentativas de chamada ao LLM até obter um JSON válido. */
const MAX_ATTEMPTS = 2;

/**
 * Sugestão por campo já casada contra os campos REAIS do tipo do documento
 * (`document_type_index_fields`) — nunca contém nomes alucinados pelo LLM.
 */
export interface SuggestedIndexField {
  /** Nome do campo real do tipo (nunca um nome inventado pelo LLM). */
  name: string;
  /** Valor já normalizado/validado, ou `null` quando descartado/ausente. */
  value: string | null;
  /** Confiança devolvida pelo LLM para este campo; 0 quando o LLM não o sugeriu. */
  confidence: number;
}

/** Entrada do núcleo de sugestão de índices (SEM banco). */
export interface SuggestIndexValuesInput {
  /** Texto completo extraído do documento (nunca truncado). */
  fullText: string;
  /** Campos REAIS do tipo do documento — fonte de verdade dos nomes. */
  indexFields: IndexFieldRow[];
}

/**
 * Resultado do núcleo — pronto para os orquestradores persistirem. Não contém
 * nada de banco: `values` (mapa nome→valor validado), `fields` (array por campo
 * real, incl. os não sugeridos), o `model`/`rawResponse` para auditoria e o
 * `costUsd` desta chamada (soma de TODAS as tentativas, inclusive as inválidas).
 */
export interface SuggestIndexValuesResult {
  /** Mapa nome→valor validado (só campos com valor normalizado/validado). */
  values: Record<string, string>;
  /** Sugestão por campo real (valor validado ou null + confiança casada). */
  fields: SuggestedIndexField[];
  /** Modelo que respondeu (vazio quando não houve chamada — sem campos). */
  model: string;
  /** Versão do prompt usada (rastreabilidade — spec §11). */
  promptVersion: string;
  /** Resposta crua parseada do LLM ({} quando não houve chamada). */
  rawResponse: Record<string, unknown>;
  /** Custo em USD desta sugestão (soma de todas as tentativas). */
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
 * Normaliza (formatos pt-BR) e valida um valor candidato sugerido pela IA
 * contra o `IndexFieldRow` correspondente, usando exatamente a mesma
 * `validateIndexValues` do PATCH /documents/:id.
 *
 * Retorna o valor pronto para persistir, ou `null` se a IA não encontrou o
 * campo, o valor veio vazio, ou não validou mesmo após a normalização.
 */
function normalizeAndValidateField(field: IndexFieldRow, rawValue: string | null): string | null {
  if (rawValue === null) return null;

  const trimmed = rawValue.trim();
  if (trimmed === '') return null;

  let candidate: string | null = trimmed;
  if (field.field_type === 'DATE') {
    candidate = normalizeDatePtBr(trimmed);
  } else if (field.field_type === 'NUMBER') {
    candidate = normalizeNumberPtBr(trimmed);
  }
  // TEXT: sem normalização de formato — só o trim já aplicado.

  if (candidate === null) return null;

  const errors = validateIndexValues({ [field.name]: candidate }, [field]);
  if (errors.length > 0) return null;

  return candidate;
}

/**
 * Chama o LLM pedindo a sugestão de índices, com retry (até `MAX_ATTEMPTS`)
 * quando a resposta não é um JSON válido no formato esperado.
 *
 * Retorna também o custo ACUMULADO de todas as tentativas — inclusive a(s)
 * tentativa(s) inválida(s), pois o provedor cobra pelos tokens gerados mesmo
 * quando a resposta não pôde ser aproveitada. Lança um `Error` quando nenhuma
 * tentativa produziu um JSON válido (o chamador decide: 500 no on-demand,
 * best-effort no worker). Erros do provider (`LLMError`) propagam direto.
 */
async function callLlmWithRetry(
  llmProvider: LLMProvider,
  userMessage: string,
  logger: MinimalLogger
): Promise<{ parsed: SuggestIndexesResponse; lastResult: ChatResult; totalCostUsd: number }> {
  let totalCostUsd = 0;
  let lastResult: ChatResult | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const messages = [
      { role: 'system' as const, content: SUGGEST_INDEXES_PROMPT.systemPrompt },
      { role: 'user' as const, content: userMessage },
      ...(attempt > 1
        ? [
            {
              role: 'user' as const,
              content:
                'Sua resposta anterior não era um JSON válido no formato exigido. Responda ' +
                'APENAS com o JSON: {"fields":[{"name":string,"value":string|null,"confidence":number}]}.',
            },
          ]
        : []),
    ];

    const result = await llmProvider.chat({ messages, temperature: 0.1, maxTokens: 2048 });
    lastResult = result;
    totalCostUsd += result.usage.costUsd;

    const json = tryParseJson(result.content);
    const parsed = SuggestIndexesResponseSchema.safeParse(json);

    if (parsed.success) {
      return { parsed: parsed.data, lastResult: result, totalCostUsd };
    }

    logger.warn(
      { attempt, maxAttempts: MAX_ATTEMPTS, issue: parsed.error.message },
      'resposta do LLM não passou na validação Zod da sugestão de índices — tentando novamente'
    );
  }

  throw new Error(
    `Resposta do LLM inválida para sugestão de índices após ${MAX_ATTEMPTS} tentativas` +
      (lastResult ? ` (último conteúdo: ${lastResult.content.slice(0, 200)})` : '')
  );
}

/**
 * Núcleo puro da sugestão de valores de índice (Fase 7) — SEM banco.
 *
 * 1. Sem campos de índice ⇒ retorna resultado vazio SEM chamar o LLM (custo 0).
 * 2. Monta o prompt `suggest-indexes-v1` e chama o LLM (com retry).
 * 3. Casa a resposta contra os campos REAIS do tipo: nomes alucinados pelo LLM
 *    NUNCA entram em `values`/`fields`. Cada campo real carrega o valor
 *    normalizado/validado (ou `null`) e a confiança casada (0 se não sugerido).
 *
 * Não lê nem escreve no banco e não calcula custo acumulado — só o `costUsd`
 * desta chamada. Os orquestradores (API on-demand, passo do worker) persistem
 * o resultado e acumulam o custo.
 */
export async function suggestIndexValues(
  llmProvider: LLMProvider,
  input: SuggestIndexValuesInput,
  logger: MinimalLogger
): Promise<SuggestIndexValuesResult> {
  const { fullText, indexFields } = input;
  const promptVersion = SUGGEST_INDEXES_PROMPT.version;

  // Tipo sem campos de índice: nada a sugerir, sem custo, sem chamar o LLM.
  if (indexFields.length === 0) {
    logger.info({}, 'tipo de documento sem campos de índice configurados — nenhuma sugestão gerada');
    return {
      values: {},
      fields: [],
      model: '',
      promptVersion,
      rawResponse: {},
      costUsd: 0,
    };
  }

  const userMessage = SUGGEST_INDEXES_PROMPT.buildUserMessage(
    fullText,
    indexFields.map((f) => ({
      name: f.name,
      fieldType: f.field_type,
      required: f.required,
      aiExtractionHint: f.ai_extraction_hint,
    }))
  );

  const { parsed, lastResult, totalCostUsd } = await callLlmWithRetry(
    llmProvider,
    userMessage,
    logger
  );

  // Indexa a resposta do LLM por nome para casar contra os campos REAIS do tipo
  // (fonte de verdade). Nomes inventados pelo LLM (que não existem em
  // `indexFields`) nunca são consultados — não entram em `values` nem em `fields`.
  const suggestionByName = new Map(parsed.fields.map((f) => [f.name, f]));
  const values: Record<string, string> = {};

  const realNames = new Set(indexFields.map((f) => f.name));
  for (const suggested of parsed.fields) {
    if (!realNames.has(suggested.name)) {
      logger.warn(
        { fieldName: suggested.name },
        'IA sugeriu campo que não existe no tipo do documento — ignorado'
      );
    }
  }

  const fields: SuggestedIndexField[] = indexFields.map((field) => {
    const suggested = suggestionByName.get(field.name);
    const normalized = suggested ? normalizeAndValidateField(field, suggested.value) : null;
    if (suggested && normalized === null && suggested.value !== null) {
      logger.warn(
        { fieldName: field.name, rawValue: suggested.value },
        'sugestão de índice descartada — não validou mesmo após normalização pt-BR'
      );
    }
    if (normalized !== null) {
      values[field.name] = normalized;
    }
    return {
      name: field.name,
      value: normalized,
      confidence: suggested?.confidence ?? 0,
    };
  });

  logger.info(
    {
      fieldsRequested: indexFields.length,
      fieldsSuggested: Object.keys(values).length,
      model: lastResult.model,
      costUsd: totalCostUsd.toFixed(6),
    },
    'sugestão de índices (núcleo) concluída'
  );

  return {
    values,
    fields,
    model: lastResult.model,
    promptVersion,
    rawResponse: parsed as unknown as Record<string, unknown>,
    costUsd: totalCostUsd,
  };
}
