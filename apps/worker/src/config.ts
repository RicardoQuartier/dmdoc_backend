import { z } from 'zod';

/**
 * Schema de variáveis de ambiente do worker.
 *
 * Único ponto do código autorizado a ler `process.env`.
 * Qualquer outro módulo deve importar `config` daqui — `process.env.X`
 * espalhado é proibido pela convenção do projeto (CLAUDE.md / spec §14).
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // PostgreSQL
  DATABASE_URL: z
    .string()
    .url()
    .default('postgresql://dmdoc:dmdoc@localhost:5432/dmdoc'),

  // AWS S3
  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_S3_BUCKET: z.string().min(1).default('dmdoc-documents'),
  AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  /** Endpoint alternativo para MinIO em dev ou S3-compatible em prod. */
  S3_ENDPOINT: z.string().url().optional(),
  /** true para MinIO (path-style obrigatório). false para AWS S3 e Cloudflare R2. */
  S3_FORCE_PATH_STYLE: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),

  // Extração de texto — comunicação assíncrona via Redis (fila extract:requests).
  // O extractor Python baixa o arquivo do S3 diretamente e publica o resultado em
  // extract:result:{requestId}. O worker aguarda via BLPOP sem timeout HTTP.
  /**
   * Timeout do BLPOP aguardando resultado de extração (segundos).
   * Default 2h — cobre documentos grandes com OCR em CPU.
   * 0 bloqueia indefinidamente (não recomendado em produção).
   */
  EXTRACT_BLPOP_TIMEOUT_SECS: z.coerce.number().int().nonnegative().default(7200),

  // Embeddings (sempre OpenAI, nunca OpenRouter)
  OPENAI_API_KEY: z.string().min(1).optional(),
  EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),

  // Limites de chunking (spec §12)
  CHUNK_TARGET_TOKENS: z.coerce.number().int().positive().default(500),
  CHUNK_OVERLAP_TOKENS: z.coerce.number().int().nonnegative().default(50),
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

/**
 * Config singleton para uso da aplicação. Lido uma única vez no carregamento
 * do módulo. Em testes prefira `loadConfig({...})` para injetar um ambiente.
 */
export const config: Config = loadConfig();
