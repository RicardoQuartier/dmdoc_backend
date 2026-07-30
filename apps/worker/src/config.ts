import { z } from 'zod';
import { parseSecretKey } from '@dmdoc/storage';

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

  /**
   * Chave mestra (AES-256-GCM, 32 bytes em hexadecimal) que decifra o segredo
   * de armazenamento de cada empresa (`tenant_storage_configs.encrypted_secret`,
   * épico E-11). Precisa ser EXATAMENTE a mesma da API: as duas apps decifram
   * os mesmos segredos.
   *
   * Obrigatória e validada aqui, no boot. Uma chave de tamanho errado só se
   * revelaria no primeiro job de uma empresa com destino próprio — horas depois
   * do deploy, e no meio de um processamento.
   */
  STORAGE_SECRET_KEY: z
    .string()
    .min(1, 'STORAGE_SECRET_KEY é obrigatória')
    .superRefine((value, ctx) => {
      try {
        parseSecretKey(value);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : 'chave inválida',
        });
      }
    }),

  // Extração de texto — comunicação assíncrona via Redis (fila extract:requests).
  // O worker resolve o destino de armazenamento da empresa, gera uma URL de
  // download temporária e a publica na fila; o extractor Python baixa por HTTP e
  // publica o resultado em extract:result:{requestId}. O worker aguarda via
  // BLPOP sem timeout HTTP.
  /**
   * Timeout do BLPOP aguardando resultado de extração (segundos).
   * Default 15min — job falha se o extractor não responder nesse prazo.
   * 0 bloqueia indefinidamente (não recomendado em produção).
   */
  EXTRACT_BLPOP_TIMEOUT_SECS: z.coerce.number().int().nonnegative().default(900),
  /**
   * Validade (segundos) da URL de download entregue ao extractor. Default 30min.
   *
   * Precisa cobrir FILA + PROCESSAMENTO, não só o download: o consumer Python
   * processa um pedido por vez, então uma extração pesada segura as seguintes na
   * fila. Manter com folga sobre `EXTRACT_BLPOP_TIMEOUT_SECS` — uma URL que
   * expira antes do BLPOP desistir vira uma falha de download difícil de ler,
   * em vez de um timeout claro.
   */
  EXTRACT_URL_TTL_SECS: z.coerce.number().int().positive().default(1800),

  // Embeddings (sempre OpenAI, nunca OpenRouter)
  OPENAI_API_KEY: z.string().min(1).optional(),
  EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),

  // LLM de chat — usado na classificação automática de tipo (Fase 8) no
  // pipeline do worker. Espelha EXATAMENTE os nomes de env da API
  // (apps/api/src/config.ts): o worker compartilha o mesmo `.env` no compose,
  // então os mesmos valores valem para API e worker sem divergência.
  // Funciona com OpenAI e OpenRouter só trocando baseURL/apiKey/model.
  LLM_PROVIDER: z.enum(['openai', 'openrouter']).default('openrouter'),
  LLM_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  LLM_API_KEY: z.string().default(''),
  LLM_MODEL: z.string().min(1).default('google/gemma-3-27b-it:free'),

  // Limites de chunking (spec §12)
  CHUNK_TARGET_TOKENS: z.coerce.number().int().positive().default(500),
  CHUNK_OVERLAP_TOKENS: z.coerce.number().int().nonnegative().default(50),

  // Sugestão automática de índices por IA (Fase 7, gatilho no worker).
  // Confiança MÍNIMA da classificação de tipo (Fase 8) para disparar a sugestão
  // de índices sobre o TIPO SUGERIDO. Abaixo do limiar a etapa é pulada (a
  // sugestão continua disponível sob demanda ou ao confirmar o tipo no PATCH).
  DMDOC_INDEX_SUGGESTION_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.5),
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
