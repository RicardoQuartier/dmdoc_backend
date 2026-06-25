import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ConflictError, NotFoundError } from '../../errors/index.js';
import { requireRole } from '../../auth/role-guard.js';

/**
 * Formato seguro de tenant para respostas.
 */
interface TenantSummary {
  id: string;
  name: string;
  active: boolean;
}

const UserIdParamsSchema = z.object({
  userId: z.string().uuid(),
});

const UserTenantParamsSchema = z.object({
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
});

const PutTenantsBodySchema = z.object({
  tenantIds: z
    .array(z.string().uuid())
    .min(1, 'A lista de tenants não pode ser vazia')
    .max(20, 'MULTI_TENANT_ADMIN suporta no máximo 20 tenants'),
});

/**
 * Rotas de gestão de tenants atribuídos a um MULTI_TENANT_ADMIN.
 * Acesso exclusivo: SUPER_ADMIN.
 *
 * Endpoints:
 *   GET    /admin/multi-tenant-admins/:userId/tenants
 *   PUT    /admin/multi-tenant-admins/:userId/tenants
 *   POST   /admin/multi-tenant-admins/:userId/tenants/:tenantId
 *   DELETE /admin/multi-tenant-admins/:userId/tenants/:tenantId
 *
 * Invariantes:
 *   - Usuário deve existir e ter role MULTI_TENANT_ADMIN (404 caso contrário).
 *   - Todos os tenantIds devem existir na tabela `tenants` (404 com mensagem
 *     indicando qual ID não existe).
 *   - Máximo de 20 tenants por MTA (409 se lista estiver cheia).
 *   - Lista não pode ficar vazia (409 ao tentar remover o último tenant).
 */
export const multiTenantAdminsRoutes: FastifyPluginAsync = async (app) => {
  const sql = app.db;

  /**
   * Busca e valida que o usuário existe e tem role MULTI_TENANT_ADMIN.
   * Lança NotFoundError se não existir, estiver deletado ou tiver outro role.
   */
  async function getMtaUserOrThrow(userId: string): Promise<{
    id: string;
    role: string;
    allowedTenantIds: string[];
  }> {
    const rows = await sql<Array<{
      id: string;
      role: string;
      allowed_tenant_ids: string[] | null;
    }>>`
      SELECT id, role, allowed_tenant_ids
      FROM users
      WHERE id = ${userId}
        AND deleted = false
      LIMIT 1
    `;
    const user = rows[0];

    if (!user) {
      throw new NotFoundError('Usuário não encontrado');
    }
    if (user.role !== 'MULTI_TENANT_ADMIN') {
      throw new NotFoundError('Usuário não é MULTI_TENANT_ADMIN');
    }

    return {
      id: user.id,
      role: user.role,
      allowedTenantIds: user.allowed_tenant_ids ?? [],
    };
  }

  /**
   * Valida que todos os tenantIds existem na tabela `tenants`.
   * Lança NotFoundError com o primeiro ID ausente caso algum não exista.
   */
  async function validateAndFetchTenants(tenantIds: string[]): Promise<TenantSummary[]> {
    const docs = await sql<Array<{ id: string; name: string; active: boolean }>>`
      SELECT id, name, active
      FROM tenants
      WHERE id = ANY(${tenantIds}::uuid[])
    `;

    const foundIds = new Set(docs.map((t) => t.id));
    const missing = tenantIds.find((id) => !foundIds.has(id));
    if (missing !== undefined) {
      throw new NotFoundError(`Empresa não encontrada: ${missing}`);
    }

    // Mantém a ordem de tenantIds
    const byId = new Map(docs.map((t) => [t.id, t]));
    return tenantIds.map((id) => {
      const t = byId.get(id)!;
      return { id: t.id, name: t.name, active: t.active };
    });
  }

  /**
   * Busca os tenants de um MTA e retorna como TenantSummary[].
   * Tenants que foram deletados/inexistentes são filtrados silenciosamente.
   */
  async function fetchAllowedTenants(allowedTenantIds: string[]): Promise<TenantSummary[]> {
    if (allowedTenantIds.length === 0) return [];

    const docs = await sql<Array<{ id: string; name: string; active: boolean }>>`
      SELECT id, name, active
      FROM tenants
      WHERE id = ANY(${allowedTenantIds}::uuid[])
    `;

    const byId = new Map(docs.map((t) => [t.id, t]));
    return allowedTenantIds
      .filter((id) => byId.has(id))
      .map((id) => {
        const t = byId.get(id)!;
        return { id: t.id, name: t.name, active: t.active };
      });
  }

  /**
   * GET /admin/multi-tenant-admins/:userId/tenants
   */
  app.get(
    '/admin/multi-tenant-admins/:userId/tenants',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, 'SUPER_ADMIN');

      const { userId } = UserIdParamsSchema.parse(request.params);
      const user = await getMtaUserOrThrow(userId);
      const tenants = await fetchAllowedTenants(user.allowedTenantIds);

      request.log.info({ userId }, 'tenants do MTA consultados');
      return reply.status(200).send({ tenants });
    },
  );

  /**
   * PUT /admin/multi-tenant-admins/:userId/tenants
   */
  app.put(
    '/admin/multi-tenant-admins/:userId/tenants',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, 'SUPER_ADMIN');

      const { userId } = UserIdParamsSchema.parse(request.params);
      const { tenantIds } = PutTenantsBodySchema.parse(request.body);

      await getMtaUserOrThrow(userId);
      const tenants = await validateAndFetchTenants(tenantIds);

      await sql`
        UPDATE users
        SET allowed_tenant_ids = ${tenantIds}::uuid[]
        WHERE id = ${userId}
      `;

      request.log.info({ userId, tenantIds }, 'allowedTenantIds do MTA substituídos');
      return reply.status(200).send({ tenants });
    },
  );

  /**
   * POST /admin/multi-tenant-admins/:userId/tenants/:tenantId
   *
   * Adiciona um tenant à lista do MTA.
   */
  app.post(
    '/admin/multi-tenant-admins/:userId/tenants/:tenantId',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, 'SUPER_ADMIN');

      const { userId, tenantId } = UserTenantParamsSchema.parse(request.params);
      const user = await getMtaUserOrThrow(userId);

      // Verifica limite apenas para adições reais (não duplicatas)
      if (!user.allowedTenantIds.includes(tenantId) && user.allowedTenantIds.length >= 20) {
        throw new ConflictError(
          'MULTI_TENANT_ADMIN já atingiu o limite de 20 tenants atribuídos',
        );
      }

      await validateAndFetchTenants([tenantId]);

      // Adiciona sem duplicar (array_append + DISTINCT via ARRAY)
      await sql`
        UPDATE users
        SET allowed_tenant_ids = (
          SELECT ARRAY(
            SELECT DISTINCT unnest(COALESCE(allowed_tenant_ids, '{}'::uuid[]) || ARRAY[${tenantId}::uuid])
          )
        )
        WHERE id = ${userId}
      `;

      const updatedRows = await sql<Array<{ allowed_tenant_ids: string[] | null }>>`
        SELECT allowed_tenant_ids FROM users WHERE id = ${userId} LIMIT 1
      `;
      const updatedAllowed = updatedRows[0]?.allowed_tenant_ids ?? [];
      const tenants = await fetchAllowedTenants(updatedAllowed);

      request.log.info({ userId, tenantId }, 'tenant adicionado ao MTA');
      return reply.status(200).send({ tenants });
    },
  );

  /**
   * DELETE /admin/multi-tenant-admins/:userId/tenants/:tenantId
   */
  app.delete(
    '/admin/multi-tenant-admins/:userId/tenants/:tenantId',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, 'SUPER_ADMIN');

      const { userId, tenantId } = UserTenantParamsSchema.parse(request.params);
      const user = await getMtaUserOrThrow(userId);

      // Impede que a lista fique vazia
      if (user.allowedTenantIds.includes(tenantId) && user.allowedTenantIds.length === 1) {
        throw new ConflictError(
          'Não é possível remover o único tenant atribuído ao MULTI_TENANT_ADMIN. ' +
            'Atribua outro tenant antes de remover este.',
        );
      }

      // Remove o tenantId do array
      await sql`
        UPDATE users
        SET allowed_tenant_ids = (
          SELECT ARRAY(
            SELECT unnest(COALESCE(allowed_tenant_ids, '{}'::uuid[]))
            EXCEPT SELECT ${tenantId}::uuid
          )
        )
        WHERE id = ${userId}
      `;

      const updatedRows = await sql<Array<{ allowed_tenant_ids: string[] | null }>>`
        SELECT allowed_tenant_ids FROM users WHERE id = ${userId} LIMIT 1
      `;
      const updatedAllowed = updatedRows[0]?.allowed_tenant_ids ?? [];
      const tenants = await fetchAllowedTenants(updatedAllowed);

      request.log.info({ userId, tenantId }, 'tenant removido do MTA');
      return reply.status(200).send({ tenants });
    },
  );
};
