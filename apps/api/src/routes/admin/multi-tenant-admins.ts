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

/**
 * Documento de tenant mínimo (campos usados internamente).
 */
interface TenantDoc {
  id: string;
  name: string;
  active: boolean;
}

/**
 * Documento de usuário MTA (campos mínimos usados nestas rotas).
 */
interface MtaUserDoc {
  id: string;
  role: string;
  allowedTenantIds: string[];
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
 *   - Todos os tenantIds devem existir na coleção `tenants` (404 com mensagem
 *     indicando qual ID não existe).
 *   - Máximo de 20 tenants por MTA (409 se lista estiver cheia).
 *   - Lista não pode ficar vazia (409 ao tentar remover o último tenant).
 *   - $addToSet evita duplicatas na adição.
 *   - $pull remove sem erro se elemento não existir.
 */
export const multiTenantAdminsRoutes: FastifyPluginAsync = async (app) => {
  const db = app.db;

  /**
   * Busca e valida que o usuário existe e tem role MULTI_TENANT_ADMIN.
   * Lança NotFoundError se não existir, estiver deletado ou tiver outro role.
   */
  async function getMtaUserOrThrow(userId: string): Promise<MtaUserDoc> {
    const user = (await db
      .collection('users')
      .findOne({ id: userId, deleted: false })) as unknown as MtaUserDoc | null;

    if (!user) {
      throw new NotFoundError('Usuário não encontrado');
    }
    if (user.role !== 'MULTI_TENANT_ADMIN') {
      throw new NotFoundError('Usuário não é MULTI_TENANT_ADMIN');
    }

    return user;
  }

  /**
   * Valida que todos os tenantIds existem na coleção `tenants`.
   * Lança NotFoundError com o primeiro ID ausente caso algum não exista.
   */
  async function validateAndFetchTenants(tenantIds: string[]): Promise<TenantSummary[]> {
    const docs = (await db
      .collection('tenants')
      .find({ id: { $in: tenantIds } })
      .toArray()) as unknown as TenantDoc[];

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
   * Tenants que foram deletados/inexistentes são filtrados silenciosamente
   * (a lista pode divergir se um tenant for removido da plataforma).
   */
  async function fetchAllowedTenants(allowedTenantIds: string[]): Promise<TenantSummary[]> {
    if (allowedTenantIds.length === 0) return [];

    const docs = (await db
      .collection('tenants')
      .find({ id: { $in: allowedTenantIds } })
      .toArray()) as unknown as TenantDoc[];

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
   *
   * Retorna a lista de tenants atribuídos ao MTA.
   * Response: { tenants: Array<{ id, name, active }> }
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
   *
   * Substitui a lista completa de tenants atribuídos ao MTA.
   * Body: { tenantIds: string[] } — min 1, max 20, todos UUIDs válidos existentes.
   * Response: { tenants: Array<{ id, name, active }> }
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

      await db
        .collection('users')
        .updateOne({ id: userId }, { $set: { allowedTenantIds: tenantIds } });

      request.log.info({ userId, tenantIds }, 'allowedTenantIds do MTA substituídos');
      return reply.status(200).send({ tenants });
    },
  );

  /**
   * POST /admin/multi-tenant-admins/:userId/tenants/:tenantId
   *
   * Adiciona um tenant à lista do MTA. Usa $addToSet para evitar duplicatas.
   * Lança 409 se a lista já tem 20 itens (e o tenant não é duplicata).
   * Response: { tenants: Array<{ id, name, active }> }
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

      // Valida que o tenant existe
      await validateAndFetchTenants([tenantId]);

      await db
        .collection('users')
        .updateOne({ id: userId }, { $addToSet: { allowedTenantIds: tenantId } });

      const updatedUser = (await db
        .collection('users')
        .findOne({ id: userId })) as unknown as MtaUserDoc;
      const tenants = await fetchAllowedTenants(updatedUser.allowedTenantIds);

      request.log.info({ userId, tenantId }, 'tenant adicionado ao MTA');
      return reply.status(200).send({ tenants });
    },
  );

  /**
   * DELETE /admin/multi-tenant-admins/:userId/tenants/:tenantId
   *
   * Remove um tenant da lista do MTA. Lança 409 se for o último.
   * Response: { tenants: Array<{ id, name, active }> }
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

      // O tipo de PullOperator do driver MongoDB é restritivo para arrays de
      // primitivos. Usamos cast via unknown para contornar sem perder segurança
      // operacional — a semântica de $pull com string é bem definida no Mongo.
      await db
        .collection('users')
        .updateOne(
          { id: userId },
          { $pull: { allowedTenantIds: tenantId } } as unknown as Parameters<
            ReturnType<typeof db.collection>['updateOne']
          >[1],
        );

      const updatedUser = (await db
        .collection('users')
        .findOne({ id: userId })) as unknown as MtaUserDoc;
      const tenants = await fetchAllowedTenants(updatedUser.allowedTenantIds);

      request.log.info({ userId, tenantId }, 'tenant removido do MTA');
      return reply.status(200).send({ tenants });
    },
  );
};
