import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Criptografia dos segredos de armazenamento das empresas (client secret do
 * SharePoint, secret access key de um bucket próprio).
 *
 * Esses segredos pertencem ao cliente, não à plataforma: um dump do banco não
 * pode entregar acesso ao SharePoint ou ao bucket dele. Por isso ficam cifrados
 * em `tenant_storage_configs.encrypted_secret`, com a chave mestra fora do
 * banco (variável de ambiente `STORAGE_SECRET_KEY`).
 *
 * AES-256-GCM: além de cifrar, autentica — adulterar o texto cifrado faz a
 * decifragem falhar em vez de devolver lixo silenciosamente.
 */

/** Prefixo de versão do formato. Permite trocar de algoritmo sem quebrar o que já está gravado. */
const FORMAT_VERSION = 'v1';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96 bits — tamanho recomendado para GCM
const AUTH_TAG_BYTES = 16;

export class StorageCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageCryptoError';
  }
}

/**
 * Converte a chave mestra em hexadecimal (64 chars) para bytes, validando o
 * tamanho. Falhar aqui, no boot, é muito melhor do que falhar no primeiro
 * upload de um cliente.
 */
export function parseSecretKey(hexKey: string): Buffer {
  if (!/^[0-9a-fA-F]+$/.test(hexKey)) {
    throw new StorageCryptoError('STORAGE_SECRET_KEY deve estar em hexadecimal');
  }
  const key = Buffer.from(hexKey, 'hex');
  if (key.length !== KEY_BYTES) {
    throw new StorageCryptoError(
      `STORAGE_SECRET_KEY deve ter ${KEY_BYTES} bytes (${KEY_BYTES * 2} chars hex), recebeu ${key.length}`
    );
  }
  return key;
}

/**
 * Cifra um segredo. O IV é aleatório a cada chamada, então cifrar o mesmo valor
 * duas vezes produz saídas diferentes — não dá para inferir, comparando duas
 * linhas, que duas empresas usam o mesmo segredo.
 *
 * Formato de saída: `v1:{iv}:{authTag}:{ciphertext}`, todos em base64.
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  assertKey(key);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    FORMAT_VERSION,
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/**
 * Decifra um segredo gravado por `encryptSecret`.
 *
 * Lança `StorageCryptoError` quando o formato é inválido, a chave está errada
 * ou o conteúdo foi adulterado — nunca devolve um valor duvidoso, porque um
 * segredo silenciosamente errado viraria uma falha de autenticação confusa
 * lá no provedor.
 */
export function decryptSecret(stored: string, key: Buffer): string {
  assertKey(key);

  const parts = stored.split(':');
  if (parts.length !== 4) {
    throw new StorageCryptoError('segredo cifrado em formato inválido');
  }

  const [version, ivB64, authTagB64, ciphertextB64] = parts as [string, string, string, string];
  if (version !== FORMAT_VERSION) {
    throw new StorageCryptoError(`versão de formato não suportada: ${version}`);
  }

  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new StorageCryptoError('segredo cifrado com IV ou tag de tamanho inválido');
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // A mensagem do Node ("Unsupported state or unable to authenticate data")
    // não ajuda quem lê o log; o que importa é que a chave não serve.
    throw new StorageCryptoError(
      'não foi possível decifrar o segredo — chave incorreta ou conteúdo adulterado'
    );
  }
}

function assertKey(key: Buffer): void {
  // timingSafeEqual exige tamanhos iguais; aqui só validamos o comprimento,
  // mas mantemos a checagem explícita para falhar cedo e com mensagem clara.
  if (key.length !== KEY_BYTES) {
    throw new StorageCryptoError(`chave de criptografia deve ter ${KEY_BYTES} bytes`);
  }
}

/** Comparação em tempo constante, para conferir segredos sem vazar por timing. */
export function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
