import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/role-guard.js';
import { resolveTenantId } from '../auth/resolve-tenant.js';
import { AUDIT_LOGS_COLLECTION } from '../auth/audit.js';
import type { AuditLogDocument } from '../auth/audit.js';

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

/**
 * Decode de cursor opaco (base64 → ISO date string).
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

function encodeCursor(doc: Pick<AuditLogDocument, 'createdAt'>): string {
  return Buffer.from((doc.createdAt as Date).toISOString()).toString('base64');
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

    const db = app.db;
    const collection = db.collection<AuditLogDocument>(AUDIT_LOGS_COLLECTION);

    // Filtro base — tipado como Record para evitar conflito do driver com
    // exactOptionalPropertyTypes no tsconfig strict do projeto.
    const baseFilter: Record<string, unknown> = { tenantId };

    if (rawQuery.action !== undefined) {
      baseFilter['action'] = rawQuery.action;
    }

    if (rawQuery.userId !== undefined) {
      baseFilter['userId'] = rawQuery.userId;
    }

    // Intervalo de datas
    if (rawQuery.from !== undefined || rawQuery.to !== undefined) {
      const dateFilter: Record<string, Date> = {};
      if (rawQuery.from !== undefined) {
        dateFilter['$gte'] = new Date(rawQuery.from);
      }
      if (rawQuery.to !== undefined) {
        dateFilter['$lte'] = new Date(rawQuery.to);
      }
      baseFilter['createdAt'] = dateFilter;
    }

    const limit = rawQuery.limit;

    // Paginação por cursor simples: createdAt < cursor (DESC)
    const pageFilter: Record<string, unknown> = { ...baseFilter };
    if (rawQuery.cursor !== undefined) {
      const cursorDate = decodeCursor(rawQuery.cursor);
      if (cursorDate !== null) {
        pageFilter['createdAt'] = { $lt: cursorDate };
      }
    }

    // O driver MongoDB aceita Record<string, unknown> como Filter<T> na prática —
    // o cast é necessário porque os tipos gerados do @types/mongodb com
    // exactOptionalPropertyTypes são excessivamente restritivos neste padrão.
    type DocFilter = Parameters<typeof collection.find>[0];

    const docs = await collection
      .find(pageFilter as DocFilter)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .toArray();

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;
    const lastDoc = page.at(-1);
    const nextCursor = hasMore && lastDoc ? encodeCursor(lastDoc) : null;

    // Remove _id antes de serializar
    const items = page.map(({ _id: _ignored, ...rest }) => rest);

    const total = await collection.countDocuments(baseFilter as DocFilter);

    request.log.info(
      { tenantId, returned: items.length, total },
      'listagem de audit logs'
    );

    return reply.status(200).send({ items, nextCursor, total });
  });
};
