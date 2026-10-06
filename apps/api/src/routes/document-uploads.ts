import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyBaseLogger, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Queue } from 'bullmq';
import type { Sql } from '@dmdoc/db-pg';
import type { StorageResolver } from '@dmdoc/storage';
import type { Role } from '@dmdoc/shared-types';
import {
  AppError,
  BadRequestError,
  ClientClosedRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from '../errors/index.js';
import type { Config } from '../config.js';
import {
  assertCanUploadToDepartment,
  assertDiskQuota,
  assertDocumentTypeAvailable,
  ingestDocument,
} from '../services/ingest-document.js';
import { type DocumentRow, rowToDocument } from '../services/document-row.js';

/**
 * Upload de arquivos grandes em partes pela própria API (épico E-16, ADR 0004 —
 * `docs/adr/0004-upload-em-partes.md` é o contrato).
 *
 *   POST   /documents/uploads                abre a sessão (201)
 *   PUT    /documents/uploads/:id/parts/:n   recebe a parte n (204, idempotente)
 *   GET    /documents/uploads/:id            estado da sessão (200)
 *   POST   /documents/uploads/:id/complete   inicia a conclusão (202)
 *   DELETE /documents/uploads/:id            cancela (204)
 *
 * As partes ficam em disco local (`${UPLOAD_TMP_DIR}/<tenantId>/<uploadId>/`),
 * caminho montado SÓ a partir de ids do banco. A conclusão roda em segundo plano
 * no processo da API (montagem por stream + SHA-256 + `ingestDocument` com
 * `putFile`), porque montar e enviar ~500 MB a um storage remoto passa dos 100 s
 * da borda do Cloudflare. O cliente consulta o GET até COMPLETED ou FAILED.
 *
 * Isolamento: sessão de outra empresa OU de outro usuário → 404 em todas as
 * rotas. O gate de papel (403) roda antes de qualquer leitura.
 */

/** Tamanho fixo da parte: 10 MiB = 32 × 320 KiB (grade do Microsoft Graph). */
export const UPLOAD_CHUNK_SIZE_BYTES = 10 * 1024 * 1024;

/** TTL da sessão OPEN e da conclusão presa em COMPLETING (ADR 0004). */
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Intervalo padrão da limpeza periódica de sessões vencidas. */
export const UPLOAD_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

/** Papéis que fazem upload — o mesmo gate do `POST /documents`, sem SUPER_ADMIN. */
const UPLOAD_ROLES: readonly Role[] = ['TENANT_ADMIN', 'UPLOADER', 'MULTI_TENANT_ADMIN'];

/** Nome do arquivo montado dentro do diretório da sessão. */
const ASSEMBLED_FILENAME = 'assembled.bin';

// ---------------------------------------------------------------------------
// Schemas de entrada
// ---------------------------------------------------------------------------

const IndexValuesSchema = z.record(z.union([z.string(), z.number(), z.null()]));

const InitBodySchema = z.object({
  filename: z.string().trim().min(1, 'filename é obrigatório').max(1000),
  // Sem lista de formatos: o `POST /documents` aceita o tipo que o navegador
  // declarar (inclusive `application/octet-stream` quando ele não sabe), e o
  // upload em partes segue o mesmo critério.
  mimeType: z.string().trim().min(1, 'mimeType é obrigatório').max(255),
  sizeBytes: z.number().int().positive('sizeBytes deve ser positivo').max(Number.MAX_SAFE_INTEGER),
  departmentId: z.string().uuid('departmentId inválido'),
  documentTypeId: z.string().uuid('documentTypeId inválido').optional(),
  // Objeto JSON (`{"campo": valor}`); string JSON também é aceita, pelo mesmo
  // formato do campo de texto do multipart do upload simples.
  indexValues: z
    .union([
      IndexValuesSchema,
      z.string().transform((v, ctx) => {
        if (v === '') return {};
        try {
          return IndexValuesSchema.parse(JSON.parse(v));
        } catch {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'indexValues deve ser um JSON válido' });
          return z.NEVER;
        }
      }),
    ])
    .optional(),
  originalPath: z.string().max(4000).optional(),
  tenantId: z.string().uuid('tenantId inválido').optional(),
});

const UploadIdParamsSchema = z.object({ id: z.string() });
const PartParamsSchema = z.object({ id: z.string(), n: z.string() });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

type UploadSessionStatus = 'OPEN' | 'COMPLETING' | 'COMPLETED' | 'FAILED' | 'ABORTED' | 'EXPIRED';

/** Linha de `upload_sessions` como o postgres.js entrega (bigint vem string). */
interface UploadSessionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  department_id: string;
  document_type_id: string | null;
  index_values: Record<string, string | number | null>;
  original_path: string | null;
  filename: string;
  mime_type: string;
  declared_size_bytes: string;
  chunk_size_bytes: number;
  total_parts: number;
  received_parts: number[];
  status: UploadSessionStatus;
  document_id: string | null;
  deduplicated: boolean | null;
  error_code: string | null;
  error_message: string | null;
  expires_at: Date;
  completing_started_at: Date | null;
}

export interface DocumentUploadsRoutesOptions {
  config: Config;
  /**
   * Intervalo da limpeza periódica, em ms. `0` desliga o timer (testes chamam
   * `cleanupUploadSessions` diretamente). Default: 15 min.
   */
  cleanupIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Helpers de disco
// ---------------------------------------------------------------------------

/** Diretório da sessão — só ids do banco, nunca texto do cliente. */
function sessionDir(uploadTmpDir: string, tenantId: string, uploadId: string): string {
  return path.join(uploadTmpDir, tenantId, uploadId);
}

function partPath(dir: string, n: number): string {
  return path.join(dir, `${n}.part`);
}

/** Tamanho esperado da parte n (a última leva o resto). */
function expectedPartSize(declaredSize: number, chunkSize: number, totalParts: number, n: number): number {
  if (n < totalParts) return chunkSize;
  return declaredSize - chunkSize * (totalParts - 1);
}

/** Erro interno do contador de bytes — vira 422 na rota. */
class PartSizeMismatchError extends Error {}

/**
 * Transform que deixa passar no máximo `limit` bytes e conta o total. Passar do
 * limite aborta o pipeline cedo, sem gravar o excedente nem esperar o fim do
 * corpo.
 */
class ByteCounter extends Transform {
  bytes = 0;

  constructor(private readonly limit: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) {
      callback(new PartSizeMismatchError(`parte maior que o esperado (${this.limit} bytes)`));
      return;
    }
    callback(null, chunk);
  }
}

/** Códigos de erro de socket/stream quando o cliente some no meio do corpo. */
const CLIENT_ABORT_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE']);

/**
 * O corpo da requisição foi interrompido pelo cliente? Só vale enquanto o
 * corpo não chegou inteiro — depois disso qualquer erro é do servidor.
 */
function isClientAbort(request: FastifyRequest, err: unknown): boolean {
  if (request.raw.complete) return false;
  const code = (err as { code?: string } | null)?.code;
  return request.raw.destroyed || (code !== undefined && CLIENT_ABORT_CODES.has(code));
}

async function removeDir(dir: string, log: FastifyBaseLogger, context: Record<string, unknown>): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    log.error({ err, ...context }, 'falha ao apagar diretório temporário do upload em partes');
  }
}

// ---------------------------------------------------------------------------
// Montagem do arquivo
// ---------------------------------------------------------------------------

interface AssembledFile {
  path: string;
  sizeBytes: number;
  contentHash: string;
}

/**
 * Concatena as partes 1..totalParts num único arquivo, por stream, calculando
 * o SHA-256 e o tamanho real no caminho. Memória constante (buffers do stream),
 * qualquer que seja o tamanho do arquivo.
 *
 * Cada parte é apagada logo depois de anexada: o pico de disco da sessão fica
 * em ~1× o arquivo (+ uma parte), não 2×. A sessão já está em COMPLETING e não
 * volta a OPEN, então as partes não seriam reaproveitadas de qualquer jeito.
 */
async function assembleParts(dir: string, totalParts: number): Promise<AssembledFile> {
  const target = path.join(dir, ASSEMBLED_FILENAME);
  const hash = crypto.createHash('sha256');
  let sizeBytes = 0;
  const out = createWriteStream(target);

  try {
    for (let n = 1; n <= totalParts; n += 1) {
      const input = createReadStream(partPath(dir, n));
      for await (const chunk of input as AsyncIterable<Buffer>) {
        hash.update(chunk);
        sizeBytes += chunk.length;
        if (!out.write(chunk)) {
          await new Promise<void>((resolve) => out.once('drain', resolve));
        }
      }
      await rm(partPath(dir, n), { force: true });
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }

  return { path: target, sizeBytes, contentHash: hash.digest('hex') };
}

// ---------------------------------------------------------------------------
// Limpeza periódica
// ---------------------------------------------------------------------------

export interface CleanupUploadSessionsDeps {
  sql: Sql;
  uploadTmpDir: string;
  log: FastifyBaseLogger;
  /** TTL da conclusão presa em COMPLETING. Default: `UPLOAD_SESSION_TTL_MS`. */
  completingTtlMs?: number;
}

export interface CleanupUploadSessionsResult {
  expired: number;
  failed: number;
  orphanDirs: number;
}

/**
 * Um ciclo da limpeza de sessões (ADR 0004):
 *  - OPEN com `expires_at` vencido → EXPIRED;
 *  - COMPLETING há mais que o TTL (API reiniciada no meio da conclusão) → FAILED;
 *  - apaga o diretório de cada uma dessas e os diretórios órfãos (sessão
 *    inexistente ou já encerrada — ex.: empresa purgada).
 *
 * Roda para todas as empresas (rotina de sistema); cada diretório é derivado de
 * `(tenant_id, id)` da própria linha.
 */
export async function cleanupUploadSessions(deps: CleanupUploadSessionsDeps): Promise<CleanupUploadSessionsResult> {
  const { sql, uploadTmpDir, log } = deps;
  const completingTtlMs = deps.completingTtlMs ?? UPLOAD_SESSION_TTL_MS;

  const expired = await sql<Array<{ id: string; tenant_id: string; user_id: string }>>`
    UPDATE upload_sessions
       SET status = 'EXPIRED', updated_at = now()
     WHERE status = 'OPEN'
       AND expires_at <= now()
    RETURNING id, tenant_id, user_id
  `;
  const stuck = await sql<Array<{ id: string; tenant_id: string; user_id: string }>>`
    UPDATE upload_sessions
       SET status = 'FAILED',
           error_code = 'COMPLETION_INTERRUPTED',
           error_message = 'A conclusão do upload foi interrompida. Envie o arquivo novamente.',
           updated_at = now()
     WHERE status = 'COMPLETING'
       AND completing_started_at <= now() - make_interval(secs => ${completingTtlMs / 1000})
    RETURNING id, tenant_id, user_id
  `;

  for (const row of [...expired, ...stuck]) {
    await removeDir(sessionDir(uploadTmpDir, row.tenant_id, row.id), log, {
      tenantId: row.tenant_id,
      userId: row.user_id,
      uploadId: row.id,
    });
  }

  // Diretórios órfãos: só nomes que são UUID (o que este módulo cria).
  let orphanDirs = 0;
  let tenantDirs: string[] = [];
  try {
    tenantDirs = (await readdir(uploadTmpDir)).filter((name) => UUID_RE.test(name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  for (const tenantId of tenantDirs) {
    const uploadIds = (await readdir(path.join(uploadTmpDir, tenantId))).filter((name) => UUID_RE.test(name));
    if (uploadIds.length === 0) continue;
    const alive = await sql<Array<{ id: string }>>`
      SELECT id FROM upload_sessions
       WHERE tenant_id = ${tenantId}
         AND id = ANY(${uploadIds}::uuid[])
         AND status IN ('OPEN', 'COMPLETING')
    `;
    const aliveIds = new Set(alive.map((r) => r.id));
    for (const uploadId of uploadIds) {
      if (aliveIds.has(uploadId)) continue;
      await removeDir(path.join(uploadTmpDir, tenantId, uploadId), log, { tenantId, uploadId });
      orphanDirs += 1;
    }
  }
  // Diretórios de empresa que ficaram vazios. `rmdir` falha (e é ignorado) se
  // um PUT acabou de criar uma sessão nova ali — nunca apaga conteúdo.
  for (const tenantId of tenantDirs) {
    await rmdir(path.join(uploadTmpDir, tenantId)).catch(() => undefined);
  }

  if (expired.length > 0 || stuck.length > 0 || orphanDirs > 0) {
    log.info(
      { expired: expired.length, failed: stuck.length, orphanDirs },
      'limpeza de sessões de upload em partes'
    );
  }
  return { expired: expired.length, failed: stuck.length, orphanDirs };
}

// ---------------------------------------------------------------------------
// Plugin de rotas
// ---------------------------------------------------------------------------

export const documentUploadsRoutes: FastifyPluginAsync<DocumentUploadsRoutesOptions> = async (app, options) => {
  const { config } = options;
  const uploadTmpDir = config.UPLOAD_TMP_DIR;
  const sql = app.db;

  /** Conclusões em andamento neste processo — aguardadas no shutdown. */
  const inFlight = new Set<Promise<void>>();

  // Corpo `application/octet-stream` entregue como STREAM (não bufferizado):
  // a rota grava direto em disco. Escopo deste plugin apenas (sem fastify-plugin).
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    done(null, payload);
  });

  // -------------------------------------------------------------------------
  // Helpers com acesso à request
  // -------------------------------------------------------------------------

  /** Gate de papel — roda antes de qualquer leitura (403 não revela nada). */
  function assertUploadRole(request: FastifyRequest): void {
    const role = request.user?.role;
    if (!role || !UPLOAD_ROLES.includes(role)) {
      throw new ForbiddenError();
    }
  }

  /** Empresas em que o usuário pode ter sessões. */
  function scopeTenantIds(request: FastifyRequest): string[] {
    if (request.user!.role === 'MULTI_TENANT_ADMIN') {
      return request.user!.allowedTenantIds ?? [];
    }
    return request.tenantId ? [request.tenantId] : [];
  }

  /**
   * Carrega a sessão do PRÓPRIO usuário, numa empresa a que ele tem acesso.
   * Qualquer outra coisa (id malformado, outra empresa, outro usuário) → 404.
   */
  async function loadSession(request: FastifyRequest, id: string): Promise<UploadSessionRow> {
    const tenantIds = scopeTenantIds(request);
    if (!UUID_RE.test(id) || tenantIds.length === 0) {
      throw new NotFoundError('Upload não encontrado');
    }
    const rows = await sql<UploadSessionRow[]>`
      SELECT *
        FROM upload_sessions
       WHERE id = ${id}
         AND user_id = ${request.user!.sub}
         AND tenant_id = ANY(${tenantIds}::uuid[])
       LIMIT 1
    `;
    const session = rows[0];
    if (!session) {
      throw new NotFoundError('Upload não encontrado');
    }
    return session;
  }

  function isOpen(session: UploadSessionRow): boolean {
    return session.status === 'OPEN' && session.expires_at.getTime() > Date.now();
  }

  /** Relê o status da sessão (ela pode ter sido encerrada durante o PUT). */
  async function isStillOpen(session: UploadSessionRow): Promise<boolean> {
    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM upload_sessions
       WHERE id = ${session.id}
         AND tenant_id = ${session.tenant_id}
         AND status = 'OPEN'
         AND expires_at > now()
    `;
    return rows.length > 0;
  }

  // -------------------------------------------------------------------------
  // Conclusão em segundo plano
  // -------------------------------------------------------------------------

  interface CompletionContext {
    session: UploadSessionRow;
    role: string;
    log: FastifyBaseLogger;
    storage: StorageResolver;
    queue: Queue | null;
  }

  async function runCompletion(ctx: CompletionContext): Promise<void> {
    const { session, log } = ctx;
    const tenantId = session.tenant_id;
    const userId = session.user_id;
    const dir = sessionDir(uploadTmpDir, tenantId, session.id);
    const logContext = { tenantId, userId, uploadId: session.id };

    try {
      const assembled = await assembleParts(dir, session.total_parts);
      const declared = Number(session.declared_size_bytes);
      if (assembled.sizeBytes !== declared) {
        throw new ValidationError(
          `Tamanho montado (${assembled.sizeBytes} bytes) diferente do declarado (${declared} bytes)`
        );
      }

      // Permissão revalidada na conclusão: o departamento pode ter sido
      // excluído ou o acesso revogado desde a abertura.
      await assertCanUploadToDepartment(sql, userId, tenantId, session.department_id, ctx.role);

      // `ingestDocument` refaz a cota com o tamanho REAL antes de gravar no
      // storage — recusa não grava objeto nem gera evento.
      const { document, deduplicated } = await ingestDocument({
        sql,
        storage: ctx.storage,
        queue: ctx.queue,
        log,
        tenantId,
        userId,
        departmentId: session.department_id,
        documentTypeId: session.document_type_id ?? undefined,
        indexValues: session.index_values,
        originalPath: session.original_path,
        originalFilename: session.filename,
        mimeType: session.mime_type,
        contentHash: assembled.contentHash,
        sizeBytes: assembled.sizeBytes,
        content: { kind: 'file', path: assembled.path },
      });

      await sql`
        UPDATE upload_sessions
           SET status = 'COMPLETED',
               document_id = ${document.id},
               deduplicated = ${deduplicated},
               error_code = NULL,
               error_message = NULL,
               updated_at = now()
         WHERE id = ${session.id}
           AND tenant_id = ${tenantId}
      `;
      log.info(
        { ...logContext, documentId: document.id, deduplicated, sizeBytes: assembled.sizeBytes },
        'upload em partes concluído'
      );
    } catch (err) {
      const isDomain = err instanceof AppError;
      const code = isDomain ? err.code : 'INTERNAL_ERROR';
      const message = isDomain ? err.message : 'Erro interno ao concluir o upload';
      if (isDomain) {
        log.info({ err, ...logContext, code }, 'upload em partes recusado na conclusão');
      } else {
        log.error({ err, ...logContext }, 'falha ao concluir upload em partes');
      }
      await sql`
        UPDATE upload_sessions
           SET status = 'FAILED',
               error_code = ${code},
               error_message = ${message},
               updated_at = now()
         WHERE id = ${session.id}
           AND tenant_id = ${tenantId}
      `.catch((updateErr: unknown) => {
        log.error({ err: updateErr, ...logContext }, 'falha ao gravar FAILED na sessão de upload');
      });
    } finally {
      // Partes e arquivo montado saem em qualquer desfecho.
      await removeDir(dir, log, logContext);
    }
  }

  // -------------------------------------------------------------------------
  // POST /documents/uploads — abre a sessão
  // -------------------------------------------------------------------------
  app.post('/documents/uploads', { preHandler: app.authenticate }, async (request, reply) => {
    assertUploadRole(request);

    const parsed = InitBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new BadRequestError(first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Dados inválidos');
    }
    const body = parsed.data;
    const userId = request.user!.sub;

    // Resolução de tenantId — mesmo critério do `POST /documents`.
    let tenantId: string;
    if (request.user!.role === 'MULTI_TENANT_ADMIN') {
      if (!body.tenantId) {
        throw new NotFoundError('MULTI_TENANT_ADMIN deve informar tenantId no upload');
      }
      if (!(request.user!.allowedTenantIds ?? []).includes(body.tenantId)) {
        throw new NotFoundError('Empresa não encontrada');
      }
      tenantId = body.tenantId;
    } else {
      tenantId = request.tenantId as string;
    }

    if (body.sizeBytes > app.uploadMaxBytes) {
      throw new PayloadTooLargeError(
        `Arquivo excede o tamanho máximo permitido (${config.MAX_UPLOAD_MB} MB)`
      );
    }

    await assertCanUploadToDepartment(sql, userId, tenantId, body.departmentId, request.user!.role);
    await assertDocumentTypeAvailable(sql, tenantId, body.documentTypeId);
    // Cota pelo tamanho DECLARADO: só para recusar cedo. A conclusão refaz com
    // o tamanho real.
    await assertDiskQuota(sql, tenantId, body.sizeBytes);

    const totalParts = Math.ceil(body.sizeBytes / UPLOAD_CHUNK_SIZE_BYTES);
    const expiresAt = new Date(Date.now() + UPLOAD_SESSION_TTL_MS);
    const indexValues = body.indexValues ?? {};

    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO upload_sessions (
        tenant_id, user_id, department_id, document_type_id, index_values,
        original_path, filename, mime_type, declared_size_bytes, chunk_size_bytes,
        total_parts, expires_at
      ) VALUES (
        ${tenantId}, ${userId}, ${body.departmentId}, ${body.documentTypeId ?? null},
        ${sql.json(indexValues)}, ${body.originalPath ?? null}, ${body.filename},
        ${body.mimeType}, ${body.sizeBytes}, ${UPLOAD_CHUNK_SIZE_BYTES},
        ${totalParts}, ${expiresAt}
      )
      RETURNING id
    `;
    const uploadId = rows[0]!.id;

    request.log.info(
      { tenantId, userId, uploadId, sizeBytes: body.sizeBytes, totalParts },
      'sessão de upload em partes aberta'
    );
    return reply.status(201).send({
      uploadId,
      chunkSizeBytes: UPLOAD_CHUNK_SIZE_BYTES,
      totalParts,
      expiresAt: expiresAt.toISOString(),
    });
  });

  // -------------------------------------------------------------------------
  // PUT /documents/uploads/:id/parts/:n — recebe uma parte
  // -------------------------------------------------------------------------
  app.put(
    '/documents/uploads/:id/parts/:n',
    {
      preHandler: app.authenticate,
      // Documenta o teto da rota; como o parser entrega o stream cru, o limite
      // efetivo é aplicado byte a byte pelo `ByteCounter` (tamanho exato da parte).
      bodyLimit: UPLOAD_CHUNK_SIZE_BYTES + 64 * 1024,
    },
    async (request, reply) => {
      assertUploadRole(request);
      const params = PartParamsSchema.parse(request.params);
      const session = await loadSession(request, params.id);

      if (!isOpen(session)) {
        throw new ConflictError(`Upload não está aberto (status ${session.status})`);
      }
      const n = /^\d+$/.test(params.n) ? Number(params.n) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > session.total_parts) {
        throw new BadRequestError(`Número de parte inválido: use de 1 a ${session.total_parts}`);
      }

      const expected = expectedPartSize(
        Number(session.declared_size_bytes),
        session.chunk_size_bytes,
        session.total_parts,
        n
      );
      const sizeError = (): ValidationError =>
        new ValidationError(`Tamanho da parte ${n} diferente do esperado (${expected} bytes)`);

      const declaredLength = request.headers['content-length'];
      if (declaredLength !== undefined && Number(declaredLength) !== expected) {
        throw sizeError();
      }
      const body = request.body as Readable | undefined;
      if (!body || typeof (body as Readable).pipe !== 'function') {
        throw sizeError();
      }

      const dir = sessionDir(uploadTmpDir, session.tenant_id, session.id);
      const logContext = { tenantId: session.tenant_id, userId: session.user_id, uploadId: session.id, part: n };
      // Grava num temporário e renomeia: reenviar a mesma parte sobrescreve de
      // forma atômica, e uma parte interrompida nunca fica com o nome final.
      const tmp = path.join(dir, `${n}.part.${crypto.randomUUID()}.tmp`);
      const counter = new ByteCounter(expected);
      try {
        await mkdir(dir, { recursive: true });
        await pipeline(body, counter, createWriteStream(tmp));
        if (counter.bytes !== expected) {
          throw new PartSizeMismatchError('parte menor que o esperado');
        }
        await rename(tmp, partPath(dir, n));
      } catch (err) {
        await rm(tmp, { force: true });
        if (err instanceof PartSizeMismatchError) throw sizeError();
        // Cancelamento pelo cliente (aborto da UI, queda de rede): evento
        // normal, não erro do servidor. O parcial já foi apagado acima.
        if (isClientAbort(request, err)) {
          request.log.info(logContext, 'envio de parte interrompido pelo cliente');
          throw new ClientClosedRequestError();
        }
        // A sessão foi encerrada enquanto a parte chegava (DELETE ou limpeza
        // apagaram o diretório): o `rename`/escrita falha com ENOENT. Para o
        // cliente é "sessão fora de OPEN", não falha interna.
        if (!(await isStillOpen(session))) {
          await removeDir(dir, request.log, logContext);
          throw new ConflictError('Upload não está mais aberto');
        }
        throw err;
      }

      const updated = await sql`
        UPDATE upload_sessions
           SET received_parts = ARRAY(
                 SELECT DISTINCT p FROM unnest(received_parts || ${n}::integer) AS p ORDER BY p
               ),
               updated_at = now()
         WHERE id = ${session.id}
           AND tenant_id = ${session.tenant_id}
           AND status = 'OPEN'
        RETURNING id
      `;
      if (updated.length === 0) {
        // Encerrada entre a escrita e o registro: a parte não serve mais.
        await removeDir(dir, request.log, logContext);
        throw new ConflictError('Upload não está mais aberto');
      }
      return reply.status(204).send();
    }
  );

  // -------------------------------------------------------------------------
  // GET /documents/uploads/:id — estado da sessão
  // -------------------------------------------------------------------------
  app.get('/documents/uploads/:id', { preHandler: app.authenticate }, async (request, reply) => {
    assertUploadRole(request);
    const { id } = UploadIdParamsSchema.parse(request.params);
    const session = await loadSession(request, id);

    // Sessão OPEN vencida que a limpeza ainda não pegou já é EXPIRED para o cliente.
    const status: UploadSessionStatus =
      session.status === 'OPEN' && !isOpen(session) ? 'EXPIRED' : session.status;

    const response: Record<string, unknown> = {
      uploadId: session.id,
      status,
      totalParts: session.total_parts,
      receivedParts: session.received_parts,
      chunkSizeBytes: session.chunk_size_bytes,
      expiresAt: session.expires_at.toISOString(),
    };

    if (status === 'COMPLETED' && session.document_id !== null) {
      const docs = await sql<DocumentRow[]>`
        SELECT * FROM documents
         WHERE id = ${session.document_id}
           AND tenant_id = ${session.tenant_id}
         LIMIT 1
      `;
      if (docs[0]) response['document'] = rowToDocument(docs[0]);
      response['deduplicated'] = session.deduplicated ?? false;
    }
    if (status === 'FAILED') {
      response['error'] = {
        code: session.error_code ?? 'INTERNAL_ERROR',
        message: session.error_message ?? 'Falha ao concluir o upload',
      };
    }
    return reply.status(200).send(response);
  });

  // -------------------------------------------------------------------------
  // POST /documents/uploads/:id/complete — inicia a conclusão (202)
  // -------------------------------------------------------------------------
  app.post('/documents/uploads/:id/complete', { preHandler: app.authenticate }, async (request, reply) => {
    assertUploadRole(request);
    const { id } = UploadIdParamsSchema.parse(request.params);
    const session = await loadSession(request, id);

    if (!isOpen(session)) {
      throw new ConflictError(`Upload não está aberto (status ${session.status})`);
    }
    const received = new Set(session.received_parts);
    const missing: number[] = [];
    for (let n = 1; n <= session.total_parts; n += 1) {
      if (!received.has(n)) missing.push(n);
    }
    if (missing.length > 0) {
      const preview = missing.slice(0, 20).join(', ');
      throw new ConflictError(
        `Faltam partes: ${preview}${missing.length > 20 ? ` (+${missing.length - 20})` : ''}`
      );
    }

    // Troca atômica OPEN → COMPLETING: de dois `complete` simultâneos, só um
    // atualiza a linha; o outro recebe 409.
    const claimed = await sql<UploadSessionRow[]>`
      UPDATE upload_sessions
         SET status = 'COMPLETING',
             completing_started_at = now(),
             updated_at = now()
       WHERE id = ${session.id}
         AND tenant_id = ${session.tenant_id}
         AND user_id = ${session.user_id}
         AND status = 'OPEN'
         AND expires_at > now()
         AND cardinality(received_parts) = total_parts
      RETURNING *
    `;
    const claimedSession = claimed[0];
    if (!claimedSession) {
      throw new ConflictError('Upload já está em conclusão ou não está mais aberto');
    }

    const completion = runCompletion({
      session: claimedSession,
      role: request.user!.role,
      log: request.log.child({ tenantId: session.tenant_id, userId: session.user_id, uploadId: session.id }),
      storage: app.storage,
      queue: app.queue,
    });
    inFlight.add(completion);
    void completion.finally(() => inFlight.delete(completion));

    return reply.status(202).send({ uploadId: session.id, status: 'COMPLETING' });
  });

  // -------------------------------------------------------------------------
  // DELETE /documents/uploads/:id — cancela
  // -------------------------------------------------------------------------
  app.delete('/documents/uploads/:id', { preHandler: app.authenticate }, async (request, reply) => {
    assertUploadRole(request);
    const { id } = UploadIdParamsSchema.parse(request.params);
    const session = await loadSession(request, id);
    const dir = sessionDir(uploadTmpDir, session.tenant_id, session.id);

    if (session.status === 'OPEN') {
      const aborted = await sql`
        UPDATE upload_sessions
           SET status = 'ABORTED', updated_at = now()
         WHERE id = ${session.id}
           AND tenant_id = ${session.tenant_id}
           AND status = 'OPEN'
        RETURNING id
      `;
      if (aborted.length === 0) {
        // Perdeu a corrida para um `complete`.
        throw new ConflictError('Upload já está em conclusão');
      }
      await removeDir(dir, request.log, { tenantId: session.tenant_id, userId: session.user_id, uploadId: session.id });
      request.log.info(
        { tenantId: session.tenant_id, userId: session.user_id, uploadId: session.id },
        'sessão de upload em partes cancelada'
      );
      return reply.status(204).send();
    }

    if (session.status === 'COMPLETING' || session.status === 'COMPLETED') {
      throw new ConflictError(`Upload não pode ser cancelado (status ${session.status})`);
    }

    // Já encerrada (ABORTED/EXPIRED/FAILED): idempotente, garante o disco limpo.
    await removeDir(dir, request.log, { tenantId: session.tenant_id, userId: session.user_id, uploadId: session.id });
    return reply.status(204).send();
  });

  // -------------------------------------------------------------------------
  // Limpeza periódica e shutdown
  // -------------------------------------------------------------------------
  const intervalMs = options.cleanupIntervalMs ?? UPLOAD_CLEANUP_INTERVAL_MS;
  let timer: NodeJS.Timeout | null = null;
  if (intervalMs > 0) {
    timer = setInterval(() => {
      cleanupUploadSessions({ sql, uploadTmpDir, log: app.log }).catch((err: unknown) => {
        app.log.error({ err }, 'falha na limpeza de sessões de upload em partes');
      });
    }, intervalMs);
    timer.unref();
  }

  app.addHook('onClose', async () => {
    if (timer !== null) clearInterval(timer);
    // Não derruba conclusões no meio: aguarda as que estão rodando.
    await Promise.allSettled([...inFlight]);
  });

  // Garante o diretório base no boot (falha cedo se o volume não estiver montado
  // com permissão de escrita).
  await mkdir(uploadTmpDir, { recursive: true });
  await stat(uploadTmpDir);
};
