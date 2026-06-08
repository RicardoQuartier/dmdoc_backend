import { describe, expect, it } from 'vitest';
import { chunkText, countTokens, type ChunkDocumentMeta } from '../chunk.js';

const META: ChunkDocumentMeta = {
  documentId: '00000000-0000-0000-0000-000000000001',
  tenantId: '00000000-0000-0000-0000-000000000002',
  departmentId: '00000000-0000-0000-0000-000000000003',
  documentTypeName: 'Contrato',
};

// Helper para gerar texto com N tokens aproximados (cada palavra ~1 token)
function wordRepeat(word: string, n: number): string {
  return Array.from({ length: n }, () => word).join(' ');
}

describe('countTokens', () => {
  it('conta tokens de texto simples', () => {
    const count = countTokens('hello world');
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(3);
  });

  it('retorna 0 para string vazia', () => {
    expect(countTokens('')).toBe(0);
  });
});

describe('chunkText', () => {
  it('retorna array vazio para texto vazio', () => {
    const result = chunkText('', META);
    expect(result).toEqual([]);
  });

  it('retorna array vazio para texto só com espaços', () => {
    const result = chunkText('   \n\n   ', META);
    expect(result).toEqual([]);
  });

  it('retorna chunk único para texto menor que 500 tokens', () => {
    const text = 'Este é um documento curto com poucas palavras.';
    const result = chunkText(text, META);

    expect(result).toHaveLength(1);
    expect(result[0]).toBeDefined();
    const chunk = result[0]!;
    expect(chunk.text).toContain('documento curto');
    expect(chunk.chunkIndex).toBe(0);
    expect(chunk.tokenCount).toBeGreaterThan(0);
    expect(chunk.pageNumber).toBeNull();
    expect(chunk.documentId).toBe(META.documentId);
    expect(chunk.tenantId).toBe(META.tenantId);
    expect(chunk.departmentId).toBe(META.departmentId);
    expect(chunk.documentTypeName).toBe(META.documentTypeName);
  });

  it('divide texto com múltiplos parágrafos em vários chunks', () => {
    // Criar texto com ~1500 tokens — deve gerar ~3 chunks
    const para1 = wordRepeat('alpha', 500);
    const para2 = wordRepeat('beta', 500);
    const para3 = wordRepeat('gamma', 500);
    const text = [para1, para2, para3].join('\n\n');

    const result = chunkText(text, META, 500, 50);

    expect(result.length).toBeGreaterThanOrEqual(2);

    // chunkIndex deve ser sequencial começando em 0
    for (let i = 0; i < result.length; i++) {
      expect(result[i]!.chunkIndex).toBe(i);
    }
  });

  it('cada chunk não excede muito o alvo de 500 tokens (tolerância para overlap)', () => {
    const para = wordRepeat('palavra', 400);
    const text = [para, para, para, para].join('\n\n');

    const result = chunkText(text, META, 500, 50);

    for (const chunk of result) {
      // Chunks podem exceder levemente por causa de parágrafos inteiros
      // Tolerância razoável: 1.5x o alvo
      expect(chunk.tokenCount).toBeLessThanOrEqual(750);
    }
  });

  it('lida com parágrafo único maior que 500 tokens', () => {
    // Um único parágrafo com ~800 tokens — sem separador \n\n
    const bigParagraph = wordRepeat('enorme', 800);

    const result = chunkText(bigParagraph, META, 500, 50);

    expect(result.length).toBeGreaterThanOrEqual(1);
    // Nenhum chunk deve exceder muito o alvo
    for (const chunk of result) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(600);
    }
  });

  it('preserva metadados do documento em todos os chunks', () => {
    const text = [wordRepeat('doc', 300), wordRepeat('texto', 300)].join('\n\n');
    const result = chunkText(text, META, 500, 50);

    for (const chunk of result) {
      expect(chunk.documentId).toBe(META.documentId);
      expect(chunk.tenantId).toBe(META.tenantId);
      expect(chunk.departmentId).toBe(META.departmentId);
      expect(chunk.documentTypeName).toBe(META.documentTypeName);
    }
  });

  it('aceita documentTypeName nulo', () => {
    const metaNoType = { ...META, documentTypeName: null };
    const result = chunkText('texto simples', metaNoType);
    expect(result[0]!.documentTypeName).toBeNull();
  });

  it('chunks têm chunkIndex sequencial independente da quantidade', () => {
    const text = Array.from({ length: 10 }, (_, i) =>
      wordRepeat(`paragrafo${i}`, 200)
    ).join('\n\n');

    const result = chunkText(text, META, 500, 50);

    for (let i = 0; i < result.length; i++) {
      expect(result[i]!.chunkIndex).toBe(i);
    }
  });

  it('targetTokens e overlapTokens são configuráveis', () => {
    const text = wordRepeat('palavra', 300);
    // Target de 100 tokens deve gerar vários chunks
    const result = chunkText(text, META, 100, 10);

    expect(result.length).toBeGreaterThan(1);
  });
});
