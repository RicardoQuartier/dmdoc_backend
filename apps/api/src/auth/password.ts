import argon2 from 'argon2';

/**
 * Hashing de senhas com argon2id (decisão de produto: argon2).
 *
 * `argon2.hash` já gera e embute um salt aleatório por hash, e o algoritmo +
 * parâmetros ficam codificados na própria string resultante — `verify` não
 * precisa de configuração externa. Usamos os defaults da lib (argon2id), que
 * são seguros para o MVP; ajuste de custo fica para tuning posterior.
 */
const HASH_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
};

/**
 * Gera o hash argon2id de uma senha em texto puro. O resultado é uma string
 * auto-descritiva (algoritmo, parâmetros e salt embutidos) pronta para salvar
 * em `users.passwordHash`.
 */
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, HASH_OPTIONS);
}

/**
 * Verifica uma senha em texto puro contra um hash argon2 armazenado.
 * Retorna `false` (em vez de lançar) se o hash for malformado, para que a rota
 * de login responda sempre com o mesmo 401 genérico, sem vazar detalhes.
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
