import { describe, expect, it } from 'vitest';
import { normalizeDatePtBr, normalizeNumberPtBr } from './normalize-index-value.js';

describe('normalizeDatePtBr', () => {
  it('mantém formato ISO já válido', () => {
    expect(normalizeDatePtBr('2026-12-31')).toBe('2026-12-31');
  });

  it('converte DD/MM/AAAA para ISO, resolvendo ambiguidade sempre como DD/MM', () => {
    expect(normalizeDatePtBr('31/12/2026')).toBe('2026-12-31');
    // 05/01/2026: ambíguo (dia 5, mês 1 vs dia 1, mês 5) — sempre DD/MM.
    expect(normalizeDatePtBr('05/01/2026')).toBe('2026-01-05');
  });

  it('converte data por extenso para ISO', () => {
    expect(normalizeDatePtBr('31 de dezembro de 2026')).toBe('2026-12-31');
    expect(normalizeDatePtBr('1º de janeiro de 2025')).toBe('2025-01-01');
    expect(normalizeDatePtBr('5 de março de 2024')).toBe('2024-03-05');
  });

  it('retorna null para formatos não reconhecidos ou datas inválidas', () => {
    expect(normalizeDatePtBr('não sei')).toBeNull();
    expect(normalizeDatePtBr('32/13/2026')).toBeNull();
    expect(normalizeDatePtBr('')).toBeNull();
  });
});

describe('normalizeNumberPtBr', () => {
  it('converte separador de milhar e vírgula decimal', () => {
    expect(normalizeNumberPtBr('1.234,56')).toBe('1234.56');
    expect(normalizeNumberPtBr('1234,56')).toBe('1234.56');
  });

  it('remove prefixo de moeda R$', () => {
    expect(normalizeNumberPtBr('R$ 1.234,56')).toBe('1234.56');
    expect(normalizeNumberPtBr('R$1.234,56')).toBe('1234.56');
  });

  it('mantém número já em formato canônico', () => {
    expect(normalizeNumberPtBr('1234.56')).toBe('1234.56');
  });

  it('retorna null para valores não numéricos', () => {
    expect(normalizeNumberPtBr('abc')).toBeNull();
    expect(normalizeNumberPtBr('')).toBeNull();
  });
});
