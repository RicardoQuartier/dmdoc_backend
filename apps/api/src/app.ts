import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import type { Queue } from 'bullmq';
import { MongoDbClient } from '@dmdoc/db-mongo';
import type { Db } from 'mongodb';
import { getConfig, type Config } from './config.js';
import { AppError } from './errors/index.js';
import { authPlugin } from './plugins/auth.js';
import { authRoutes } from './routes/auth.js';
import { adminTenantsRoutes } from './routes/admin/tenants.js';
import { usersRoutes } from './routes/users.js';
import { departmentsRoutes } from './routes/departments.js';
import { documentTypesRoutes } from './routes/document-types.js';
import { permissionsRoutes } from './routes/permissions.js';
import { documentsRoutes } from './routes/documents.js';
import { searchRoutes, type SearchRoutesOptions } from './routes/search.js';
import { createS3Service, type S3Service, type S3Config } from './services/s3.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    /**
     * Serviço S3. Null em testes que injetam um mock ou desabilitam o S3.
     * As rotas que usam S3 verificam a presença antes de operar.
     */
    s3: S3Service;
    /**
     * Fila BullMQ de processamento de documentos.
     * Null em testes — jobs não são enfileirados.
     */
    queue: Queue | null;
    /**
     * Tamanho máximo permitido para upload de arquivo (em bytes).
     * Derivado de `config.MAX_UPLOAD_MB`.
     */
    uploadMaxBytes: number;
  }
}

export interface BuildAppOptions {
  /** Permite injetar uma config alternativa (útil em testes). */
  config?: Config;
  /**
   * Permite injetar um `Db` já conectado (ex.: mongodb-memory-server nos
   * testes). Quando ausente, `buildApp` conecta ao Mongo usando a config e
   * registra o fechamento da conexão no `onClose` da app.
   */
  db?: Db;
  /**
   * Fila BullMQ de processamento de documentos.
   * Em testes, passe `null` para desabilitar o enfileiramento.
   * Em produção, `server.ts` cria a fila e a injeta aqui.
   */
  queue?: Queue | null;
  /**
   * Instância de S3Service a injetar.
   * Em testes, passe um mock. Em produção é criado a partir da config.
   */
  s3?: S3Service;
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

  app.decorate('db', db);

  // Upload max em bytes (config em MB)
  const uploadMaxBytes = config.MAX_UPLOAD_MB * 1024 * 1024;
  app.decorate('uploadMaxBytes', uploadMaxBytes);

  // Fila BullMQ — null quando não injetada (testes)
  app.decorate('queue', options.queue ?? null);

  // Serviço S3
  const s3 = options.s3 ?? createS3Service(buildS3Config(config));
  app.decorate('s3', s3);

  // Plugin @fastify/multipart — necessário para POST /documents
  await app.register(multipart, {
    limits: {
      fileSize: uploadMaxBytes,
      files: 1, // apenas um arquivo por request
    },
  });

  await app.register(authPlugin, { config, db });

  app.get('/healthz', async () => {
    return { status: 'ok' } as const;
  });

  await app.register(authRoutes);
  await app.register(adminTenantsRoutes);
  await app.register(usersRoutes);
  await app.register(departmentsRoutes);
  await app.register(documentTypesRoutes);
  await app.register(permissionsRoutes);
  await app.register(documentsRoutes);
  await app.register(searchRoutes, { config } satisfies SearchRoutesOptions);

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
 * Monta a S3Config a partir do Config da aplicação.
 */
function buildS3Config(config: Config): S3Config {
  return {
    region: config.AWS_REGION,
    bucket: config.AWS_S3_BUCKET,
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
    ...(config.S3_ENDPOINT !== undefined ? { endpoint: config.S3_ENDPOINT } : {}),
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
  };
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

    // Erro de limite de tamanho de arquivo (@fastify/multipart)
    if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      request.log.info({ err: error }, 'arquivo excede tamanho máximo');
      return reply.status(422).send({
        error: {
          code: 'FILE_TOO_LARGE',
          message: `Arquivo excede o tamanho máximo permitido`,
        },
      });
    }

    request.log.error({ err: error }, 'erro não tratado');
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Erro interno do servidor' },
    });
  });
}
