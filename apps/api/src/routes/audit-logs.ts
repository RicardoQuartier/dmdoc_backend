import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/role-guard.js';
import { resolveTenantId } from '../auth/resolve-tenant.js';

/**
 * Query params do GET /audit-logs.
 *
 * TENANT_ADMIN: acessa apenas os logs do próprio tenant (tenantId extraído do JWT).
 * SUPER_ADMIN: precisa passar ?tenantId explicitamente para filtrar por empresa.
 *
 * Filtros opcionais:
 *   - action   — ação exata (ex.: "document.upload", "auth.login")
 *   - userId   — filtrar por usuário que executou a ação
 *   - from     — ISO 8601, início do intervalo (createdAt >= from)
 *   - to       — ISO 8601, fim do intervalo (createdAt <= to)
 *   - cursor   — paginação por createdAt DESC (opaque string base64)
 *   - limit    — itens por página (1–100, default 50)
 */
const ListAuditLogsQuerySchema = z.object({
  tenantId: z.string().uuid().optional(), // SUPER_ADMIN apenas
  action: z.string().optional(),
  userId: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().optional(),
  limit: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? parseInt(v, 10) : 50))
    .pipe(z.number().min(1).max(100)),
});

type AuditLogRow = {
  id: string;
  tenant_id: string | null;
  user_id: string | null;
  action: string;
  resource: string | null;
  // O cliente postgres.js deste projeto (createPgClient) NÃO faz parse
  // automático de colunas jsonb: `metadata` volta como string JSON crua do
  // banco. O mapeamento da resposta precisa parsear (ver parseMetadata).
  metadata: string | Record<string, unknown> | null;
  created_at: Date;
};

/**
 * Normaliza o `metadata` de um audit log para objeto. postgres.js entrega
 * jsonb como string; parseamos com segurança para expor um objeto na API
 * (nunca a string crua). Em caso de valor inesperado, cai para `{}`.
 */
function parseMetadata(value: AuditLogRow['metadata']): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Encode de cursor opaco (Date ISO → base64).
 */
function encodeCursor(createdAt: Date): string {
  return Buffer.from(createdAt.toISOString()).toString('base64');
}

/**
 * Decode de cursor opaco (base64 → Date).
 */
function decodeCursor(cursor: string): Date | null {
  try {
    const iso = Buffer.from(cursor, 'base64').toString('utf8');
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/**
 * Rotas de audit log — Fase 5, entregável 36.
 *
 * GET /audit-logs — listagem paginada por tenant, ordenada por createdAt DESC.
 *
 * Acesso:
 *   - TENANT_ADMIN: acessa os logs do próprio tenant
 *   - SUPER_ADMIN: exige ?tenantId explícito (spec §10, invariante 3)
 */
export const auditLogsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/audit-logs', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN');

    const rawQuery = ListAuditLogsQuerySchema.parse(request.query);

    // SUPER_ADMIN DEVE fornecer ?tenantId explicitamente (spec §10, invariante 3).
    const effectiveTenantId = resolveTenantId(request, rawQuery.tenantId, true);
    const tenantId = effectiveTenantId as string;

    const sql = app.db;

    // Construção dinâmica de WHERE com sql.unsafe + parâmetros
    const conditions: string[] = ['a.tenant_id = $1'];
    const params: unknown[] = [tenantId];
    let paramIdx = 2;

    const addParam = (val: unknown): string => {
      params.push(val);
      return `$${paramIdx++}`;
    };

    if (rawQuery.action !== undefined) {
      conditions.push(`a.action = ${addParam(rawQuery.action)}`);
    }

    if (rawQuery.userId !== undefined) {
      conditions.push(`a.user_id = ${addParam(rawQuery.userId)}`);
    }

    if (rawQuery.from !== undefined) {
      conditions.push(`a.created_at >= ${addParam(new Date(rawQuery.from))}::timestamptz`);
    }

    if (rawQuery.to !== undefined) {
      conditions.push(`a.created_at <= ${addParam(new Date(rawQuery.to))}::timestamptz`);
    }

    const limit = rawQuery.limit;

    // Paginação por cursor: created_at < cursor (DESC)
    const pageConditions = [...conditions];
    const pageParams = [...params];
    let pageParamIdx = paramIdx;

    const addPageParam = (val: unknown): string => {
      pageParams.push(val);
      return `$${pageParamIdx++}`;
    };

    if (rawQuery.cursor !== undefined) {
      const cursorDate = decodeCursor(rawQuery.cursor);
      if (cursorDate !== null) {
        pageConditions.push(`a.created_at < ${addPageParam(cursorDate)}::timestamptz`);
      }
    }

    const limitPlaceholder = addPageParam(limit + 1);
    const pageWhereClause = pageConditions.join(' AND ');

    const pageQuery = `
      SELECT a.id, a.tenant_id, a.user_id, a.action, a.resource, a.metadata, a.created_at
      FROM audit_logs a
      WHERE ${pageWhereClause}
      ORDER BY a.created_at DESC
      LIMIT ${limitPlaceholder}
    `;

    const docs = await sql.unsafe<AuditLogRow[]>(pageQuery, pageParams as Parameters<typeof sql.unsafe>[1]);

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;
    const lastDoc = page.at(-1);
    const nextCursor = hasMore && lastDoc ? encodeCursor(lastDoc.created_at) : null;

    // Total (sem cursor)
    const countWhereClause = conditions.join(' AND ');
    const countQuery = `SELECT COUNT(*) AS count FROM audit_logs a WHERE ${countWhereClause}`;
    const countRows = await sql.unsafe<Array<{ count: string }>>(countQuery, params as Parameters<typeof sql.unsafe>[1]);
    const total = parseInt(countRows[0]?.count ?? '0', 10);

    // Serializar como camelCase para compatibilidade com respostas anteriores
    const items = page.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      action: row.action,
      resource: row.resource,
      metadata: parseMetadata(row.metadata),
      createdAt: row.created_at,
    }));

    request.log.info(
      { tenantId, returned: items.length, total },
      'listagem de audit logs'
    );

    return reply.status(200).send({ items, nextCursor, total });
  });
};
