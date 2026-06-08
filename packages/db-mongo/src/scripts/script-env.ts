import pino from 'pino';

/**
 * Helpers compartilhados pelos scripts de bootstrap (`create-indexes`, `seed`).
 *
 * IMPORTANTE: estes são scripts operacionais executados via `tsx`, não código
 * de aplicação. Aqui é aceitável ler `process.env` diretamente (a API/worker
 * fazem isso via `config.ts` com Zod). Use um logger Pino em vez de `console`.
 */

/**
 * Logger Pino para os scripts. Em TTY usa transport `pino-pretty` se disponível,
 * caindo para JSON puro caso o transport não esteja instalado.
 */
export function createScriptLogger(name: string): pino.Logger {
  const level = process.env.LOG_LEVEL ?? 'info';
  return pino({ name, level });
}

/**
 * Lê a configuração de conexão Mongo do ambiente, com defaults seguros de dev.
 * Reflete `.env.example` (`MONGO_URI`, `MONGO_DB`).
 *
 * A imagem `mongodb/mongodb-atlas-local` roda como um replica set de 1 nó que
 * se anuncia pelo hostname interno do container (não resolvível do host). Para
 * conexões diretas a um único host `mongodb://` (dev/CI), forçamos
 * `directConnection=true`, evitando a descoberta de topologia que tentaria
 * resolver esse hostname. Conexões `mongodb+srv://` (Atlas cloud) são
 * preservadas intactas — lá a descoberta de replica set é necessária.
 */
export function readMongoConfig(): { uri: string; dbName: string } {
  const rawUri = process.env.MONGO_URI ?? 'mongodb://localhost:27017';
  const dbName = process.env.MONGO_DB ?? 'dmdoc';
  return { uri: withDirectConnection(rawUri), dbName };
}

function withDirectConnection(uri: string): string {
  if (uri.startsWith('mongodb+srv://') || uri.includes('directConnection=')) {
    return uri;
  }
  const separator = uri.includes('?') ? '&' : '?';
  return `${uri}${separator}directConnection=true`;
}

/**
 * Lê uma variável de ambiente com fallback. Centraliza o acesso a `process.env`
 * para manter os scripts legíveis e os defaults explícitos num único lugar.
 */
export function envOr(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
}
