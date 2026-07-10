/**
 * Utilitários compartilhados sobre `document_type_index_fields` — validação
 * dos valores de índice de um documento contra os campos definidos no seu tipo.
 *
 * Extraído de `routes/documents.ts` (PATCH /documents/:id) para reuso pelo
 * serviço de sugestão de índices por IA (Fase 7), que precisa validar cada
 * valor sugerido com exatamente a mesma regra aplicada ao salvar manualmente
 * — nunca expor ao usuário uma sugestão que o PATCH rejeitaria.
 */

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
 * Retorna lista de erros (vazia = válido).
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
