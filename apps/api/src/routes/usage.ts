import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/role-guard.js';
import { resolveTenantContext } from '../auth/resolve-tenant.js';
import { NotFoundError } from '../errors/index.js';

interface TenantDoc {
  id: string;
  name: string;
  diskQuotaBytes: number;
  userQuota: number;
  active: boolean;
}

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
 *     (404 se não constar). Não há acesso a métricas agregadas de todos os tenants.
 *
 * Spec §7 (Admin), entregável 37 da Fase 5.
 */
export const usageRoutes: FastifyPluginAsync = async (app) => {
  app.get('/usage', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN', 'MULTI_TENANT_ADMIN');

    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);

    // resolveTenantContext em modo write=true força tenantId explícito para SA e MTA.
    // Para TENANT_ADMIN retorna mode:'single' com o tenantId do token.
    // Nos demais casos (SA/MTA sem explicitTenantId) lança ConflictError/NotFoundError
    // antes de chegar aqui — portanto ctx.mode é sempre 'single' após esta linha.
    const ctx = resolveTenantContext(request, { explicitTenantId: tenantIdParam, write: true });
    if (ctx.mode !== 'single') {
      // Ramo defensivo: write:true garante que never chegamos aqui, mas o
      // TypeScript não infere o narrowing via throw do resolveTenantContext.
      throw new NotFoundError('tenantId é obrigatório para esta operação');
    }
    const tenantId = ctx.tenantId;

    const db = app.db;

    // Buscar tenant para obter as cotas configuradas
    const tenant = await db.collection<TenantDoc>('tenants').findOne({ id: tenantId });
    if (!tenant) {
      throw new NotFoundError('Tenant não encontrado');
    }

    // 1. Uso de disco: soma de sizeBytes de documentos não deletados
    const diskAgg = await db
      .collection('documents')
      .aggregate<{ diskUsedBytes: number }>([
        { $match: { tenantId, deleted: false } },
        { $group: { _id: null, diskUsedBytes: { $sum: '$sizeBytes' } } },
      ])
      .toArray();

    const diskUsedBytes = diskAgg[0]?.diskUsedBytes ?? 0;

    // 2. Usuários ativos: contagem de usuários não deletados e ativos
    const activeUserCount = await db
      .collection('users')
      .countDocuments({ tenantId, deleted: false, active: true });

    // 3. Custo IA: soma de costUsdCents em todos os documentos do tenant
    //    Inclui documentos deletados (custo já foi incorrido)
    const costAgg = await db
      .collection('documents')
      .aggregate<{ totalCostUsdCents: number }>([
        { $match: { tenantId } },
        { $group: { _id: null, totalCostUsdCents: { $sum: '$costUsdCents' } } },
      ])
      .toArray();

    const totalAiCostUsdCents = costAgg[0]?.totalCostUsdCents ?? 0;

    // 4. Métricas de documentos por status
    const docStatusAgg = await db
      .collection('documents')
      .aggregate<{ status: string; count: number }>([
        { $match: { tenantId, deleted: false } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
        { $project: { status: '$_id', count: 1, _id: 0 } },
      ])
      .toArray();

    const documentsByStatus = docStatusAgg.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = row.count;
      return acc;
    }, {});

    const totalDocuments = Object.values(documentsByStatus).reduce((a, b) => a + b, 0);

    request.log.info(
      { tenantId, diskUsedBytes, activeUserCount, totalAiCostUsdCents },
      'métricas de uso consultadas'
    );

    return reply.status(200).send({
      tenantId,
      disk: {
        usedBytes: diskUsedBytes,
        quotaBytes: tenant.diskQuotaBytes,
        usedPercent:
          tenant.diskQuotaBytes > 0
            ? Math.round((diskUsedBytes / tenant.diskQuotaBytes) * 10000) / 100
            : 0,
      },
      users: {
        active: activeUserCount,
        quota: tenant.userQuota,
        usedPercent:
          tenant.userQuota > 0
            ? Math.round((activeUserCount / tenant.userQuota) * 10000) / 100
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
