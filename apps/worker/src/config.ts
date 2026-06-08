import { z } from 'zod';

/**
 * Schema de variáveis de ambiente do worker.
 *
 * Único ponto do código autorizado a ler `process.env`.
 * Qualquer outro módulo deve importar `config` daqui — `process.env.X`
 * espalhado é proibido pela convenção do projeto (CLAUDE.md / spec §14).
 *
 * Na Fase 0 validamos apenas o mínimo necessário para conectar o worker
 * ao Redis e registrar a fila vazia. Variáveis de Mongo, S3, LLM e
 * embeddings serão adicionadas nas fases que as introduzem (Fase 3+).
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
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
