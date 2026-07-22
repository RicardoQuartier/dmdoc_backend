/**
 * Deriva um rótulo amigável a partir do `name` de um campo de índice, para os
 * casos em que o admin não preencheu um `label` explícito. Divide por `_` ou
 * espaço, descarta pedaços vazios e capitaliza a primeira letra de cada
 * palavra — ex.: `"numero_nota"` → `"Numero Nota"`. Ver T-15 (fase 8).
 */
export function deriveIndexFieldLabel(name: string): string {
  return name
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Resolve o rótulo a ser exibido para um campo de índice: usa o `label`
 * explícito (com espaços nas pontas removidos) quando preenchido, senão
 * deriva do `name` via {@link deriveIndexFieldLabel}. Nunca retorna vazio
 * enquanto `name` for válido. Ver T-15 (fase 8).
 */
export function resolveIndexFieldDisplayLabel(field: { name: string; label: string | null }): string {
  const trimmed = field.label?.trim();
  return trimmed ? trimmed : deriveIndexFieldLabel(field.name);
}
