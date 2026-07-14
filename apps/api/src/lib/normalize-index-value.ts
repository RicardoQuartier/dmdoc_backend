/**
 * Normalização de valores sugeridos por IA para o formato exigido por
 * `validateIndexValues` (`lib/index-fields.ts`).
 *
 * A IA responde no formato "como está no texto" (ex.: `31/12/2026`,
 * `R$ 1.234,56`) — este módulo converte formatos comuns em português para o
 * formato canônico esperado pelo campo antes da validação final, evitando
 * descartar sugestões válidas só por causa do formato.
 *
 * Regra de negócio (wiki "Sugestão de valores de índice por IA — alcance no
 * texto e normalização de formato"): ambiguidade de data `DD/MM` vs `MM/DD`
 * é SEMPRE resolvida como `DD/MM` (locale do projeto). Se a normalização não
 * for possível, retorna `null` — o chamador decide o que fazer (no serviço de
 * sugestão, campo sem normalização válida vira "sem sugestão").
 */

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

/**
 * Formato ISO 8601 já aceito por `validateIndexValues` (mesma regex).
 */
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
