import { z } from 'zod';

/**
 * Prompt de sugestão de valores de índice por IA (Fase 7).
 *
 * Versão: suggest-indexes-v1
 *
 * O modelo recebe o TEXTO COMPLETO do documento (nunca truncado — diferente da
 * futura classificação de tipo, que só usa o início) e a lista de campos de
 * índice do tipo de documento (nome, tipo de dado, obrigatoriedade e dica de
 * extração) e deve, para cada campo, sugerir um valor encontrado literalmente
 * no texto — ou `null` quando não encontrar.
 *
 * Formato de resposta esperado (validado por `SuggestIndexesResponseSchema`):
 *   { "fields": [{ "name": string, "value": string | null, "confidence": number }] }
 *
 * A normalização de formatos pt-BR (datas, números) e a validação final contra
 * `validateIndexValues` acontecem DEPOIS da resposta do LLM, no serviço
 * `services/index-suggestion.ts` — o prompt só pede o valor "como está no texto".
 *
 * Spec §7 e §11. Regra de negócio na wiki: "Sugestão de valores de índice por
 * IA — alcance no texto e normalização de formato".
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
 * Validado com `safeParse` no serviço — resposta inválida (JSON malformado
 * ou fora do schema) dispara uma nova tentativa antes de desistir.
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
