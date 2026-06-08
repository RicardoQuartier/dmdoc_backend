import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { MongoDbClient } from '@dmdoc/db-mongo';
import type { Db } from 'mongodb';
import { getConfig, type Config } from './config.js';
import { AppError } from './errors/index.js';
import { authPlugin } from './plugins/auth.js';
import { authRoutes } from './routes/auth.js';

export interface BuildAppOptions {
  /** Permite injetar uma config alternativa (útil em testes). */
  config?: Config;
  /**
   * Permite injetar um `Db` já conectado (ex.: mongodb-memory-server nos
   * testes). Quando ausente, `buildApp` conecta ao Mongo usando a config e
   * registra o fechamento da conexão no `onClose` da app.
   */
  db?: Db;
}

/**
 * Factory da aplicação Fastify.
 *
 * Configura o logger Pino, conecta ao MongoDB (ou usa o `db` injetado),
 * registra o plugin de autenticação, o error handler central e as rotas.
 * Não dá `listen` — isso é responsabilidade do `server.ts`. Manter a criação
 * como factory permite que os testes instanciem a app sem abrir porta nem
 * depender de um Mongo real (via `app.inject` + `db` injetado).
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? getConfig();

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
    },
  });

  registerErrorHandler(app);

  const db = await resolveDb(app, options, config);

  await app.register(authPlugin, { config, db });

  app.get('/healthz', async () => {
    return { status: 'ok' } as const;
  });

  await app.register(authRoutes);

  await app.ready();
  return app;
}

/**
 * Resolve o `Db`: usa o injetado (testes) ou conecta no boot real. Em conexão
 * própria, fecha o cliente quando a app fecha — evita vazar conexões em testes
 * e no shutdown.
 */
async function resolveDb(
  app: FastifyInstance,
  options: BuildAppOptions,
  config: Config
): Promise<Db> {
  if (options.db) {
    return options.db;
  }

  const client = await MongoDbClient.connect(config.MONGO_URI, config.MONGO_DB);
  app.addHook('onClose', async () => {
    await client.close();
  });
  return client.getDb();
}

/**
 * Error handler central. Mapeia erros tipados para respostas HTTP estáveis:
 *  - `AppError`  → statusCode + code da própria classe
 *  - `ZodError`  → 422 VALIDATION_ERROR (input externo inválido)
 *  - demais      → 500 INTERNAL_ERROR (mensagem ocultada do cliente)
 */
function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      request.log.info({ err: error, code: error.code }, 'erro de domínio tratado');
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }

    if (error instanceof ZodError) {
      request.log.info({ err: error }, 'erro de validação');
      return reply.status(422).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Dados de entrada inválidos',
          details: error.issues,
        },
      });
    }

    // Erros de validação nativos do Fastify (schemas de rota).
    if (error.validation) {
      request.log.info({ err: error }, 'erro de validação (fastify)');
      return reply.status(422).send({
        error: { code: 'VALIDATION_ERROR', message: error.message },
      });
    }

    request.log.error({ err: error }, 'erro não tratado');
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Erro interno do servidor' },
    });
  });
}
