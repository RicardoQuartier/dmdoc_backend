import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/role-guard.js';
import { resolveTenantContext } from '../auth/resolve-tenant.js';
import { NotFoundError } from '../errors/index.js';

const TenantIdQuerySchema = z.object({
  tenantId: z.string().uuid().optional(), // SUPER_ADMIN apenas
});

/**
 * Rotas de uso por tenant — Fase 5, entregável 37.
 *
 * GET /usage — retorna métricas de uso para o tenant autenticado:
 *   - disco: bytes usados vs cota
 *   - usuários: contagem ativa vs cota
 *   - IA: custo acumulado em centavos USD (soma de `costUsdCents` em documents)
 *
 * Acesso:
 *   - TENANT_ADMIN: usa o tenantId do JWT
 *   - SUPER_ADMIN: exige ?tenantId explícito
 *   - MULTI_TENANT_ADMIN: exige ?tenantId explícito, validado contra allowedTenantIds
 *
 * Spec §7 (Admin), entregável 37 da Fase 5.
 */
export const usageRoutes: FastifyPluginAsync = async (app) => {
  app.get('/usage', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN', 'MULTI_TENANT_ADMIN');

    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);

    const ctx = resolveTenantContext(request, { explicitTenantId: tenantIdParam, write: true });
    if (ctx.mode !== 'single') {
      throw new NotFoundError('tenantId é obrigatório para esta operação');
    }
    const tenantId = ctx.tenantId;

    const sql = app.db;

    // Buscar tenant para obter as cotas configuradas
    const tenantRows = await sql<Array<{
      id: string;
      name: string;
      disk_quota_bytes: bigint;
      user_quota: number;
    }>>`
      SELECT id, name, disk_quota_bytes, user_quota
      FROM tenants
      WHERE id = ${tenantId}
      LIMIT 1
    `;
    const tenant = tenantRows[0];
    if (!tenant) {
      throw new NotFoundError('Tenant não encontrado');
    }

    // 1. Uso de disco: soma de size_bytes de documentos não deletados
    const diskRows = await sql<Array<{ disk_used_bytes: string }>>`
      SELECT COALESCE(SUM(size_bytes), 0)::text AS disk_used_bytes
      FROM documents
      WHERE tenant_id = ${tenantId}
        AND deleted = false
    `;
    const diskUsedBytes = Number(diskRows[0]?.disk_used_bytes ?? '0');
    const diskQuotaBytes = Number(tenant.disk_quota_bytes);

    // 2. Usuários ativos: contagem de usuários não deletados e ativos
    const userCountRows = await sql<Array<{ count: string }>>`
      SELECT COUNT(*)::text AS count
      FROM users
      WHERE tenant_id = ${tenantId}
        AND deleted = false
        AND active = true
    `;
    const activeUserCount = parseInt(userCountRows[0]?.count ?? '0', 10);

    // 3. Custo IA: soma de cost_usd_cents em todos os documentos do tenant
    //    Inclui documentos deletados (custo já foi incorrido)
    const costRows = await sql<Array<{ total_cost: string }>>`
      SELECT COALESCE(SUM(cost_usd_cents), 0)::text AS total_cost
      FROM documents
      WHERE tenant_id = ${tenantId}
    `;
    const totalAiCostUsdCents = parseInt(costRows[0]?.total_cost ?? '0', 10);

    // 4. Métricas de documentos por status
    const statusRows = await sql<Array<{ status: string; count: string }>>`
      SELECT status, COUNT(*)::text AS count
      FROM documents
      WHERE tenant_id = ${tenantId}
        AND deleted = false
      GROUP BY status
    `;

    const documentsByStatus: Record<string, number> = {};
    for (const row of statusRows) {
      documentsByStatus[row.status] = parseInt(row.count, 10);
    }

    const totalDocuments = Object.values(documentsByStatus).reduce((a, b) => a + b, 0);

    request.log.info(
      { tenantId, diskUsedBytes, activeUserCount, totalAiCostUsdCents },
      'métricas de uso consultadas'
    );

    return reply.status(200).send({
      tenantId,
      disk: {
        usedBytes: diskUsedBytes,
        quotaBytes: diskQuotaBytes,
        usedPercent:
          diskQuotaBytes > 0
            ? Math.round((diskUsedBytes / diskQuotaBytes) * 10000) / 100
            : 0,
      },
      users: {
        active: activeUserCount,
        quota: tenant.user_quota,
        usedPercent:
          tenant.user_quota > 0
            ? Math.round((activeUserCount / tenant.user_quota) * 10000) / 100
            : 0,
      },
      ai: {
        costUsdCents: totalAiCostUsdCents,
        costUsd: totalAiCostUsdCents / 100,
      },
      documents: {
        total: totalDocuments,
        byStatus: documentsByStatus,
      },
    });
  });
};
