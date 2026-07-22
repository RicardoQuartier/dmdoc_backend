import { describe, expect, it } from 'vitest';
import { coerceIndexValueForField, mergeSuggestedIndexValues, type IndexFieldRow } from './suggest-index-values.js';

/**
 * Testes do núcleo puro de auto-aplicação de índices (`mergeSuggestedIndexValues`),
 * reaproveitado por TODOS os pontos de auto-aplicação (upload/reprocessamento
 * individual, reprocessamento em lote, `PATCH /documents/:id`, endpoint sob
 * demanda).
 *
 * COM SOBRESCRITA (decisão do Owner, 2026-07-22): um campo sugerido SUBSTITUI o
 * valor já confirmado, mesmo que este já esteja preenchido — só é PRESERVADO
 * quando a sugestão desta rodada vier vazia para aquele campo específico
 * (`rawValue === ''`), quando o campo não vier na sugestão (`suggestedValues`
 * não tem a chave), ou quando o valor coercionado for idêntico ao já
 * confirmado (não conta como aplicação, evita UPDATE à toa).
 */

function makeField(overrides: Partial<IndexFieldRow> = {}): IndexFieldRow {
  return {
    id: 'f1',
    name: 'Cliente',
    field_type: 'TEXT',
    required: false,
    ai_extraction_hint: null,
    sort_order: 0,
    show_on_search: true,
    deleted: false,
    ...overrides,
  };
}

describe('mergeSuggestedIndexValues', () => {
  it('preenche um campo vazio com o valor sugerido', () => {
    const { merged, appliedCount } = mergeSuggestedIndexValues(
      {},
      { Cliente: 'ACME Ltda' },
      [makeField()]
    );

    expect(merged).toEqual({ Cliente: 'ACME Ltda' });
    expect(appliedCount).toBe(1);
  });

  it('SOBRESCREVE um campo já confirmado quando a sugestão desta rodada vier preenchida', () => {
    const { merged, appliedCount } = mergeSuggestedIndexValues(
      { Cliente: 'Valor antigo confirmado manualmente' },
      { Cliente: 'ACME Ltda (nova sugestão)' },
      [makeField()]
    );

    expect(merged).toEqual({ Cliente: 'ACME Ltda (nova sugestão)' });
    expect(appliedCount).toBe(1);
  });

  it('PRESERVA o valor confirmado quando a sugestão desta rodada vier vazia para aquele campo', () => {
    const { merged, appliedCount } = mergeSuggestedIndexValues(
      { Cliente: 'Valor antigo confirmado' },
      { Cliente: '' },
      [makeField()]
    );

    expect(merged).toEqual({ Cliente: 'Valor antigo confirmado' });
    expect(appliedCount).toBe(0);
  });

  it('PRESERVA um campo específico que não veio na sugestão desta rodada, sobrescrevendo só os demais', () => {
    const { merged, appliedCount } = mergeSuggestedIndexValues(
      { Cliente: 'Valor antigo confirmado', Fornecedor: 'Fornecedor antigo' },
      { Cliente: 'ACME Ltda (nova sugestão)' }, // "Fornecedor" nem aparece nesta rodada
      [makeField({ name: 'Cliente' }), makeField({ name: 'Fornecedor', id: 'f2' })]
    );

    expect(merged).toEqual({ Cliente: 'ACME Ltda (nova sugestão)', Fornecedor: 'Fornecedor antigo' });
    expect(appliedCount).toBe(1);
  });

  it('não conta como aplicação quando o valor coercionado é idêntico ao já confirmado', () => {
    const { merged, appliedCount } = mergeSuggestedIndexValues(
      { Valor: 1234.56 },
      { Valor: '1234.56' },
      [makeField({ name: 'Valor', field_type: 'NUMBER' })]
    );

    expect(merged).toEqual({ Valor: 1234.56 });
    expect(appliedCount).toBe(0);
  });

  it('coerciona campo NUMBER para number e sobrescreve o valor numérico já confirmado', () => {
    const { merged, appliedCount } = mergeSuggestedIndexValues(
      { Valor: 999 },
      { Valor: '1234.56' }, // já vem normalizado pelo núcleo de sugestão (formato canônico)
      [makeField({ name: 'Valor', field_type: 'NUMBER' })]
    );

    expect(merged).toEqual({ Valor: 1234.56 });
    expect(typeof merged.Valor).toBe('number');
    expect(appliedCount).toBe(1);
  });

  it('mescla múltiplos campos independentemente — cada um segue sua própria regra de sobrescrita', () => {
    const { merged, appliedCount } = mergeSuggestedIndexValues(
      { Cliente: 'Antigo', Valor: 100, Observacao: 'Nota antiga' },
      { Cliente: 'Novo', Valor: '', Observacao: 'Nota antiga' }, // Valor vazio preserva; Observacao idêntico não conta
      [
        makeField({ name: 'Cliente' }),
        makeField({ name: 'Valor', field_type: 'NUMBER', id: 'f2' }),
        makeField({ name: 'Observacao', id: 'f3' }),
      ]
    );

    expect(merged).toEqual({ Cliente: 'Novo', Valor: 100, Observacao: 'Nota antiga' });
    expect(appliedCount).toBe(1);
  });
});

describe('coerceIndexValueForField', () => {
  it('converte campo NUMBER para number quando finito', () => {
    expect(coerceIndexValueForField('NUMBER', '1234.56')).toBe(1234.56);
  });

  it('mantém string quando o campo NUMBER não é um número finito', () => {
    expect(coerceIndexValueForField('NUMBER', 'não é número')).toBe('não é número');
  });

  it('mantém TEXT e DATE como string, sem coerção', () => {
    expect(coerceIndexValueForField('TEXT', 'ACME Ltda')).toBe('ACME Ltda');
    expect(coerceIndexValueForField('DATE', '2026-12-31')).toBe('2026-12-31');
  });
});
