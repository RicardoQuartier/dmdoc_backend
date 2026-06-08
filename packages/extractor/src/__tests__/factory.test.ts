import { describe, expect, it } from 'vitest';
import { createExtractor } from '../factory.js';
import { UnstructuredExtractor } from '../unstructured.js';
import { NativeExtractor } from '../native.js';

describe('createExtractor', () => {
  it('retorna NativeExtractor quando type === "native"', () => {
    const extractor = createExtractor({ type: 'native' });
    expect(extractor).toBeInstanceOf(NativeExtractor);
  });

  it('retorna UnstructuredExtractor quando type === "unstructured"', () => {
    const extractor = createExtractor({
      type: 'unstructured',
      unstructured: { apiUrl: 'http://localhost:8000/general/v0/general' },
    });
    expect(extractor).toBeInstanceOf(UnstructuredExtractor);
  });

  it('lança quando type === "unstructured" mas config está ausente', () => {
    expect(() => createExtractor({ type: 'unstructured' })).toThrow(
      'unstructured config is required'
    );
  });
});
