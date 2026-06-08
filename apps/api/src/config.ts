import { z } from 'zod';

/**
 * Schema de variáveis de ambiente da API.
 *
 * Único ponto do código autorizado a ler `process.env`.
 * Qualquer outro módulo deve importar `config` daqui — `process.env.X`
 * espalhado é proibido pela convenção do projeto (CLAUDE.md / spec §14).
 *
 * Na Fase 0 validamos apenas o mínimo necessário para subir a API com
 * healthcheck. A Fase 1 acrescenta as variáveis de Mongo e JWT (autenticação).
 * Variáveis de Redis, S3 e LLM entram nas fases que as introduzem.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_PORT: z.coerce.number().int().positive().max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // MongoDB — conexão da API no boot (spec §12).
  MONGO_URI: z.string().min(1, 'MONGO_URI é obrigatória'),
  MONGO_DB: z.string().min(1).default('dmdoc'),

  // JWT — autenticação stateless (spec §12). Access curto + refresh longo,
  // assinados com segredos DISTINTOS para que um refresh não seja aceito como
  // access (e vice-versa). Os segredos não têm default: ausência é erro de boot.
  JWT_SECRET: z.string().min(1, 'JWT_SECRET é obrigatória'),
  JWT_REFRESH_SECRET: z.string().min(1, 'JWT_REFRESH_SECRET é obrigatória'),
  JWT_EXPIRES_IN: z.string().min(1).default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().min(1).default('7d'),
});

export type Config = Readonly<z.infer<typeof EnvSchema>>;

/**
 * Carrega e valida o ambiente. Em caso de configuração inválida, lança um
 * erro descritivo — falha rápida no boot é preferível a comportamento
 * indefinido em runtime.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuração de ambiente inválida:\n${issues}`);
  }

  return Object.freeze(parsed.data);
}

let cachedConfig: Config | null = null;

/**
 * Config singleton para uso da aplicação. Carregada e validada na PRIMEIRA
 * chamada (lazy), não no import do módulo — assim importar `config.ts` em um
 * teste que injeta seu próprio ambiente (via `loadConfig({...})`) não dispara
 * a validação de `process.env`. O `server.ts` chama isto no boot real.
 *
 * Em testes prefira `loadConfig({...})` para injetar um ambiente hermético.
 */
export function getConfig(): Config {
  if (cachedConfig === null) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}
