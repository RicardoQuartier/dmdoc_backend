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

  // AWS S3 — storage de arquivos (spec §12). S3_ENDPOINT é opcional para dev
  // com MinIO ou LocalStack. Ausente em produção (usa endpoint AWS padrão).
  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_S3_BUCKET: z.string().min(1, 'AWS_S3_BUCKET é obrigatória'),
  AWS_ACCESS_KEY_ID: z.string().min(1, 'AWS_ACCESS_KEY_ID é obrigatória'),
  AWS_SECRET_ACCESS_KEY: z.string().min(1, 'AWS_SECRET_ACCESS_KEY é obrigatória'),
  S3_ENDPOINT: z.string().url().optional(), // MinIO em dev; R2/LocalStack em staging
  // Endpoint público usado SÓ para assinar URLs de download. Em dev o S3_ENDPOINT
  // é o host interno do Docker (http://minio:9000), inacessível pelo navegador —
  // o presigner precisa do host publicado (http://localhost:5054). Em produção,
  // ausente: o endpoint público é o próprio do S3/R2.
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  // true para MinIO (path-style obrigatório); false para AWS S3 e Cloudflare R2
  S3_FORCE_PATH_STYLE: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),

  // Redis — BullMQ (spec §12). Fila de processamento de documentos.
  REDIS_URL: z.string().min(1, 'REDIS_URL é obrigatória'),

  // Limites de upload (spec §12).
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(50),

  // Extractor Python — conversão de documentos Office→PDF para preview.
  EXTRACTOR_URL: z.string().url().default('http://localhost:8000'),

  // LLM — geração de resposta RAG (spec §12).
  // LLM_PROVIDER=openai | openrouter
  LLM_PROVIDER: z.enum(['openai', 'openrouter']).default('openrouter'),
  LLM_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  LLM_API_KEY: z.string().default(''),
  LLM_MODEL: z.string().min(1).default('google/gemma-3-27b-it:free'),

  // Embeddings — sempre OpenAI, nunca OpenRouter (spec §12).
  OPENAI_API_KEY: z.string().default(''),
  EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),

  // Rate limiting por tenant — Fase 5, entregável 39 (spec §8).
  // Máximo de requisições por janela de tempo, por tenant.
  // Defaults conservadores para produção; sobrescrever em dev/staging.
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(200),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
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
