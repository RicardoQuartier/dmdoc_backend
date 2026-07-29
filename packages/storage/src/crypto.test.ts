import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  StorageCryptoError,
  decryptSecret,
  encryptSecret,
  parseSecretKey,
  secretsMatch,
} from './crypto.js';

const key = randomBytes(32);
const otherKey = randomBytes(32);

describe('encryptSecret / decryptSecret', () => {
  it('faz round-trip do segredo', () => {
    const secret = 'client-secret-do-sharepoint';
    expect(decryptSecret(encryptSecret(secret, key), key)).toBe(secret);
  });

  it('preserva caracteres não-ASCII e strings longas', () => {
    const secret = `çãé-${'x'.repeat(5000)}-🔐`;
    expect(decryptSecret(encryptSecret(secret, key), key)).toBe(secret);
  });

  it('produz saídas diferentes para o mesmo segredo (IV aleatório)', () => {
    // Se duas empresas usarem o mesmo segredo, as linhas do banco não podem
    // revelar isso por comparação direta.
    const a = encryptSecret('mesmo-segredo', key);
    const b = encryptSecret('mesmo-segredo', key);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, key)).toBe(decryptSecret(b, key));
  });

  it('grava com o prefixo de versão do formato', () => {
    expect(encryptSecret('x', key).startsWith('v1:')).toBe(true);
  });

  it('não deixa o segredo legível no texto cifrado', () => {
    expect(encryptSecret('segredo-visivel', key)).not.toContain('segredo-visivel');
  });

  it('lança com chave errada, em vez de devolver lixo', () => {
    const stored = encryptSecret('segredo', key);
    expect(() => decryptSecret(stored, otherKey)).toThrow(StorageCryptoError);
  });

  it('lança quando o texto cifrado foi adulterado', () => {
    const parts = encryptSecret('segredo', key).split(':');
    const tampered = Buffer.from(parts[3]!, 'base64');
    tampered[0] = tampered[0]! ^ 0xff;
    parts[3] = tampered.toString('base64');

    expect(() => decryptSecret(parts.join(':'), key)).toThrow(StorageCryptoError);
  });

  it('lança em formato inválido ou versão desconhecida', () => {
    expect(() => decryptSecret('nao-e-formato', key)).toThrow(StorageCryptoError);
    expect(() => decryptSecret('v9:a:b:c', key)).toThrow(/versão de formato/);
  });

  it('recusa chave de tamanho errado', () => {
    expect(() => encryptSecret('x', randomBytes(16))).toThrow(StorageCryptoError);
  });
});

describe('parseSecretKey', () => {
  it('converte hex de 64 chars em 32 bytes', () => {
    expect(parseSecretKey('ab'.repeat(32))).toHaveLength(32);
  });

  it('recusa hex de tamanho errado', () => {
    expect(() => parseSecretKey('abcd')).toThrow(/32 bytes/);
  });

  it('recusa string que não é hexadecimal', () => {
    expect(() => parseSecretKey('z'.repeat(64))).toThrow(/hexadecimal/);
  });
});

describe('secretsMatch', () => {
  it('compara segredos iguais e diferentes', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true);
    expect(secretsMatch('abc', 'abd')).toBe(false);
    expect(secretsMatch('abc', 'abcd')).toBe(false);
  });
});
