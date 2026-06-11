import { describe, expect, it } from 'vitest';
import { createExtractor } from '../factory.js';
import { PythonExtractor } from '../python.js';

describe('createExtractor', () => {
  it('retorna PythonExtractor quando type === "python"', () => {
    const extractor = createExtractor({
      type: 'python',
      python: { url: 'http://localhost:8000/extract' },
    });
    expect(extractor).toBeInstanceOf(PythonExtractor);
  });

  it('lança quando type === "python" mas config está ausente', () => {
    expect(() => createExtractor({ type: 'python' })).toThrow('python config is required');
  });
});
