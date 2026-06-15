import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MongoServerError } from 'mongodb';
import type { Db } from 'mongodb';
import { TenantRepository, assertUserScopeInvariant, validateUserDocument } from '@dmdoc/db-mongo';
import type { User, Role } from '@dmdoc/shared-types';
import { ADMIN_ROLES, isGlobalRole } from '@dmdoc/shared-types';
import type { TenantDocument } from '@dmdoc/db-mongo';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors/index.js';
import { requireRole, requireCanManageRole } from '../auth/role-guard.js';
import { hashPassword } from '../auth/password.js';
import { resolveTenantContext, resolveTenantId } from '../auth/resolve-tenant.js';

interface UserDoc extends TenantDocument {
  email: string;
  passwordHash: string;
  name: string;
  role: User['role'];
  active: boolean;
  createdAt: Date;
  /**
   * Lista de tenants atribuídos. Presente apenas em documentos de
   * MULTI_TENANT_ADMIN; ausente (undefined) nos demais.
   */
  allowedTenantIds?: string[];
}

const CreateUserBodySchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200),
  // SUPER_ADMIN está no enum mas é protegido pela regra de nível
  // (`requireCanManageRole`): só um SUPER_ADMIN — único level 100 — consegue
  // criar outro SUPER_ADMIN. SUPER_ADMIN criado é sempre global (tenantId null).
  role: z.enum(['SUPER_ADMIN', 'MULTI_TENANT_ADMIN', 'TENANT_ADMIN', 'UPLOADER', 'USER']),
  password: z.string().min(8),
  active: z.boolean().default(true),
  tenantId: z.string().uuid().optional(), // SUPER_ADMIN apenas; null para MTA
  /**
   * Lista de tenants que o MULTI_TENANT_ADMIN pode acessar.
   * Máximo 20 no MVP. Ignorado para outros roles.
   */
  allowedTenantIds: z
    .array(z.string().uuid())
    .max(20, 'MULTI_TENANT_ADMIN suporta no máximo 20 tenants no MVP')
    .optional(),
});

const PatchUserBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  // SUPER_ADMIN no enum, protegido pela regra de nível no handler.
  role: z
    .enum(['SUPER_ADMIN', 'MULTI_TENANT_ADMIN', 'TENANT_ADMIN', 'UPLOADER', 'USER'])
    .optional(),
  active: z.boolean().optional(),
  /**
   * Usado quando `role` é alterado para MULTI_TENANT_ADMIN.
   * Ignorado nos demais casos.
   */
  allowedTenantIds: z
    .array(z.string().uuid())
    .max(20, 'MULTI_TENANT_ADMIN suporta no máximo 20 tenants no MVP')
    .optional(),
});

const ListUsersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  tenantId: z.string().uuid().optional(),
});

const TenantIdQuerySchema = z.object({
  tenantId: z.string().uuid().optional(), // SUPER_ADMIN apenas
});

/**
 * Rotas de CRUD de usuários. O `tenantId` vem sempre de `request.tenantId`
 * para roles normais; SUPER_ADMIN o informa via body (POST) ou query param
 * (PATCH, DELETE).
 *
 * `passwordHash` NUNCA é devolvido em nenhum response.
 */
export const usersRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /users — cria usuário no tenant.
   *
   * SUPER_ADMIN: informar `tenantId` no body (obrigatório para roles com empresa).
   * SUPER_ADMIN criando MULTI_TENANT_ADMIN: `tenantId` é omitido (null); informar
   *   `allowedTenantIds` opcional.
   * TENANT_ADMIN: cria usuário no próprio tenant; `tenantId` do body ignorado.
   *
   * Valida cota antes de inserir (exceto para MULTI_TENANT_ADMIN, que não
   * pertence a nenhuma empresa e não consome cota de tenant).
   */
  app.post('/users', { preHandler: app.authenticate }, async (request, reply) => {
    // Gate base: apenas papéis administrativos (SUPER_ADMIN, MTA, TENANT_ADMIN).
    requireRole(request, ...ADMIN_ROLES);

    const body = CreateUserBodySchema.parse(request.body);
    const db = app.db;

    // Hierarquia: o solicitante só cria papéis no mesmo nível ou abaixo
    // (regra "inferior ou igual"). Isto barra, por ex., TENANT_ADMIN criando
    // SUPER_ADMIN/MTA, e é o que torna SUPER_ADMIN criável só por SUPER_ADMIN.
    requireCanManageRole(request, body.role);

    // Escalonamento de privilégio: o gate de hierarquia acima é por NÍVEL, então
    // um MULTI_TENANT_ADMIN (80 >= 80) passaria em `canManageRole` e conseguiria
    // criar OUTRO MTA — atribuindo `allowedTenantIds` arbitrário e ganhando
    // alcance a tenants fora do seu escopo. Regra de produto: apenas o
    // SUPER_ADMIN cria/atribui papéis GLOBAIS (SUPER_ADMIN, MULTI_TENANT_ADMIN)
    // e gerencia `allowedTenantIds`. Falha fechado em 403.
    if (isGlobalRole(body.role) && request.user?.role !== 'SUPER_ADMIN') {
      throw new ForbiddenError(
        'Apenas SUPER_ADMIN pode criar papéis globais (SUPER_ADMIN, MULTI_TENANT_ADMIN)',
      );
    }

    const passwordHash = await hashPassword(body.password);
    const newId = crypto.randomUUID();
    const createdAt = new Date();

    // ----------------------------------------------------------------------
    // Papéis GLOBAIS (SUPER_ADMIN, MULTI_TENANT_ADMIN): tenantId DEVE ser null.
    // Não consomem cota de empresa. Não aceitam tenantId explícito (invariante
    // de escopo — regra 5). allowedTenantIds só é relevante para MTA.
    // ----------------------------------------------------------------------
    if (isGlobalRole(body.role)) {
      const { tenantId: tenantIdQuery } = TenantIdQuerySchema.parse(request.query);
      if (tenantIdQuery !== undefined || body.tenantId !== undefined) {
        throw new ForbiddenError(
          `Papel global ${body.role} não pode ser associado a um tenantId`,
        );
      }

      const allowedTenantIds =
        body.role === 'MULTI_TENANT_ADMIN' ? (body.allowedTenantIds ?? []) : [];

      const globalDoc = {
        id: newId,
        tenantId: null as string | null,
        email: body.email,
        name: body.name,
        role: body.role,
        active: body.active,
        passwordHash,
        createdAt,
        deleted: false,
        ...(body.role === 'MULTI_TENANT_ADMIN' ? { allowedTenantIds } : {}),
      };

      // Defesa em profundidade: invariante de escopo + schema canônico.
      assertUserScopeInvariant({ role: globalDoc.role, tenantId: globalDoc.tenantId });
      validateUserDocument(globalDoc);

      try {
        await db.collection('users').insertOne(globalDoc);
      } catch (err) {
        if (err instanceof MongoServerError && err.code === 11000) {
          throw new ConflictError('E-mail já em uso');
        }
        throw err;
      }

      const { passwordHash: _ph, deleted: _d, _id: _mid, ...safeGlobal } =
        globalDoc as typeof globalDoc & { _id?: unknown };
      request.log.info({ userId: newId, role: body.role }, 'usuário global criado');
      return reply.status(201).send(safeGlobal);
    }

    // ----------------------------------------------------------------------
    // Papéis LOCAIS (TENANT_ADMIN, UPLOADER, USER): tenantId obrigatório.
    // TENANT_ADMIN: tenantId vem do token (explicit ignorado). SUPER_ADMIN/MTA
    // criando local: tenantId explícito obrigatório, validado contra escopo
    // (MTA: ∈ allowedTenantIds, senão NotFoundError). resolveTenantId cuida disso.
    // ----------------------------------------------------------------------
    const { tenantId: tenantIdQuery } = TenantIdQuerySchema.parse(request.query);
    const explicitTenantId = tenantIdQuery ?? body.tenantId;
    const effectiveTenantId = resolveTenantId(request, explicitTenantId, true);
    // effectiveTenantId nunca é null aqui (requireForSuperAdmin: true)
    const tenantId = effectiveTenantId as string;

    // Validação de cota
    const tenant = await db.collection('tenants').findOne({ id: tenantId });
    if (!tenant) throw new NotFoundError('Empresa não encontrada');

    const usersRepo = new TenantRepository<UserDoc>(db.collection('users'), { tenantId });
    const count = await usersRepo.count({ active: true });
    const userQuota = (tenant as unknown as { userQuota: number }).userQuota;
    if (count >= userQuota) {
      throw new ConflictError('Cota de usuários atingida');
    }

    const localRole = body.role as Exclude<Role, 'SUPER_ADMIN' | 'MULTI_TENANT_ADMIN'>;

    // Defesa em profundidade: monta o documento final e valida escopo + schema
    // ANTES da inserção. O TenantRepository injeta o tenantId; validamos com ele.
    assertUserScopeInvariant({ role: localRole, tenantId });
    validateUserDocument({
      id: newId,
      tenantId,
      email: body.email,
      passwordHash,
      name: body.name,
      role: localRole,
      active: body.active,
      createdAt,
    });

    let user: UserDoc;
    try {
      user = await usersRepo.insertOne({
        id: newId,
        email: body.email,
        name: body.name,
        role: localRole,
        active: body.active,
        passwordHash,
        createdAt,
      });
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) {
        throw new ConflictError('E-mail já em uso nesta empresa');
      }
      throw err;
    }

    request.log.info({ tenantId, userId: user.id }, 'usuário criado');
    return reply.status(201).send(safeUser(user));
  });

  /**
   * GET /users — lista usuários.
   *
   * SUPER_ADMIN: vê todos os tenants. `?tenantId=xxx` filtra por empresa.
   * MULTI_TENANT_ADMIN: sem `?tenantId` lista usuários de TODOS os
   *   `allowedTenantIds` ($in); com `?tenantId=X` (X ∈ allowedTenantIds) filtra
   *   só aquele tenant (fora da lista → 404 via resolveTenantContext).
   * Demais roles: sempre escopadas ao próprio tenant (param tenantId ignorado).
   *
   * `allowedTenantIds` é projetado em cada usuário retornado (o frontend exibe
   * os tenants do MTA na coluna Empresa); `safeUser` já o preserva quando presente.
   */
  app.get('/users', { preHandler: app.authenticate }, async (request, reply) => {
    const { limit, cursor, tenantId: tenantIdParam } = ListUsersQuerySchema.parse(request.query);
    const db = app.db;

    const ctx = resolveTenantContext(request, { explicitTenantId: tenantIdParam, write: false });

    let items: ReturnType<typeof safeUser>[];
    let nextCursor: string | null;

    if (ctx.mode === 'single') {
      // Roles normais, SUPER_ADMIN com ?tenantId, ou MTA com ?tenantId válido.
      const tenantId = ctx.tenantId;
      const usersRepo = new TenantRepository<UserDoc>(db.collection('users'), { tenantId });
      const pagination = cursor !== undefined ? { limit, cursor } : { limit };
      const page = await usersRepo.findMany({}, pagination);
      items = page.items.map(safeUser);
      nextCursor = page.nextCursor;
    } else {
      // ctx.mode === 'all'      → SUPER_ADMIN sem filtro de tenant.
      // ctx.mode === 'allowed'  → MTA sem ?tenantId: filtra $in allowedTenantIds.
      const filter: Record<string, unknown> = { deleted: false };
      if (ctx.mode === 'allowed') filter['tenantId'] = { $in: ctx.tenantIds };
      if (cursor !== undefined) filter['id'] = { $gt: cursor };

      const docs = await db
        .collection('users')
        .find(filter)
        .sort({ id: 1 })
        .limit(limit + 1)
        .toArray();

      const hasMore = docs.length > limit;
      const page = hasMore ? docs.slice(0, limit) : docs;
      nextCursor = hasMore && page.at(-1) ? (page.at(-1) as unknown as { id: string }).id : null;
      items = page.map((d) => safeUser(d as unknown as UserDoc));
    }

    return reply.status(200).send({ items, nextCursor });
  });

  /**
   * GET /users/:id — retorna um único usuário pelo ID.
   * TENANT_ADMIN: escopado ao próprio tenant.
   * MULTI_TENANT_ADMIN: escopado a `allowedTenantIds` ($in); fora da lista → 404.
   * SUPER_ADMIN: busca global (IDs são UUIDs globalmente únicos).
   */
  app.get('/users/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, ...ADMIN_ROLES);

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const db = app.db;
    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);

    const user = await findUserInScope(db, request, id, tenantIdParam);
    if (!user) throw new NotFoundError();

    return reply.status(200).send(safeUser(user));
  });

  /**
   * PATCH /users/:id — atualiza usuário do tenant.
   * SUPER_ADMIN: informar `?tenantId=xxx` (obrigatório).
   *
   * Transições de role:
   *   - De MTA para outro role: zera `allowedTenantIds`.
   *   - Para MTA: aceita `allowedTenantIds` no body (aplicado na atualização);
   *     a rota usa query direto no driver pois MTA não tem tenantId.
   *   - Para demais roles: `allowedTenantIds` do body é ignorado.
   */
  app.patch('/users/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, ...ADMIN_ROLES);

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const updates = PatchUserBodySchema.parse(request.body);
    const db = app.db;

    // Busca o usuário atual para determinar role original e validar escopo.
    // SUPER_ADMIN: busca global; demais roles: escopam ao próprio tenant.
    const isSuperAdmin = request.user?.role === 'SUPER_ADMIN';

    const existingDoc = isSuperAdmin
      ? ((await db.collection('users').findOne({ id, deleted: false })) as unknown as UserDoc | null)
      : null;

    // Para SUPER_ADMIN buscamos o usuário direto; para outros roles usamos
    // TenantRepository (que injeta o tenantId correto).
    if (isSuperAdmin) {
      if (!existingDoc) throw new NotFoundError();

      const currentRole = existingDoc.role as Role;
      const newRole = updates.role;

      // Hierarquia (regra 3): para modificar um usuário existente exigir AMBOS
      // os níveis cobertos — role ATUAL e novo role. SUPER_ADMIN cobre tudo,
      // mas a checagem é mantida por simetria e para falhar fechado.
      requireCanManageRole(request, currentRole);
      if (newRole !== undefined) requireCanManageRole(request, newRole);

      const setFields: Record<string, unknown> = {};

      if (updates.name !== undefined) setFields['name'] = updates.name;
      if (updates.active !== undefined) setFields['active'] = updates.active;

      // tenantId final do documento após o update (para validar escopo).
      let finalTenantId: string | null = existingDoc.tenantId;
      const finalRole: Role = newRole ?? currentRole;

      if (newRole !== undefined) {
        setFields['role'] = newRole;

        if (isGlobalRole(newRole)) {
          // Promoção/transição para papel GLOBAL: tenantId DEVE ser null.
          setFields['tenantId'] = null;
          finalTenantId = null;
          if (newRole === 'MULTI_TENANT_ADMIN') {
            setFields['allowedTenantIds'] =
              updates.allowedTenantIds ?? existingDoc.allowedTenantIds ?? [];
          } else {
            // SUPER_ADMIN não tem allowedTenantIds.
            setFields['allowedTenantIds'] = [];
          }
        } else {
          // Transição para papel LOCAL: tenantId obrigatório. Se o usuário era
          // global (tenantId null), SUPER_ADMIN deve informar ?tenantId destino.
          if (existingDoc.tenantId === null) {
            const { tenantId: targetTenantId } = TenantIdQuerySchema.parse(request.query);
            if (targetTenantId === undefined) {
              throw new ConflictError(
                'Rebaixar papel global para local exige ?tenantId de destino',
              );
            }
            const tenant = await db.collection('tenants').findOne({ id: targetTenantId });
            if (!tenant) throw new NotFoundError('Empresa não encontrada');
            setFields['tenantId'] = targetTenantId;
            finalTenantId = targetTenantId;
          }
          if (currentRole === 'MULTI_TENANT_ADMIN') {
            // Rebaixamento de MTA: zera lista de tenants.
            setFields['allowedTenantIds'] = [];
          }
        }
      } else if (updates.allowedTenantIds !== undefined && currentRole === 'MULTI_TENANT_ADMIN') {
        // Atualiza allowedTenantIds sem mudar role (só faz sentido para MTA).
        setFields['allowedTenantIds'] = updates.allowedTenantIds;
      }

      if (Object.keys(setFields).length === 0) {
        return reply.status(200).send(safeUser(existingDoc));
      }

      // Defesa em profundidade: invariante de escopo do par (role, tenantId) final.
      assertUserScopeInvariant({ role: finalRole, tenantId: finalTenantId });

      const updated = (await db
        .collection('users')
        .findOneAndUpdate({ id, deleted: false }, { $set: setFields }, { returnDocument: 'after' })) as unknown as UserDoc | null;
      if (!updated) throw new NotFoundError();

      request.log.info({ userId: id, role: updated.role }, 'usuário atualizado (SUPER_ADMIN)');
      return reply.status(200).send(safeUser(updated));
    }

    // Roles normais (TENANT_ADMIN, MTA): usam TenantRepository escopado ao tenant.
    // MTA: o tenant alvo precisa vir via ?tenantId (∈ allowedTenantIds). Sem ele,
    // resolveTenantId lança NotFoundError (não vaza cross-tenant). Fora da lista
    // → NotFoundError. TENANT_ADMIN: tenant vem do token.
    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
    const effectiveTenantId = resolveTenantId(request, tenantIdParam, true);
    const tenantId = effectiveTenantId as string;

    const usersRepo = new TenantRepository<UserDoc>(db.collection('users'), { tenantId });

    // Busca o alvo DENTRO do escopo de tenant: cross-tenant ou inexistente → 404
    // (nunca vaza existência). É também a fonte do role ATUAL para a hierarquia.
    const target = await usersRepo.findById(id);
    if (!target) throw new NotFoundError();

    const currentRole = target.role as Role;
    const newRole = updates.role;

    // Hierarquia (regra 3): exigir nível >= role ATUAL E >= novo role. Isto
    // impede TENANT_ADMIN de editar/rebaixar um superior e bloqueia promoção
    // acima do próprio nível (ex.: TENANT_ADMIN → MTA/SUPER_ADMIN dá 403).
    requireCanManageRole(request, currentRole);
    if (newRole !== undefined) {
      requireCanManageRole(request, newRole);
      // Num escopo de tenant não pode existir usuário com papel global: barrar
      // qualquer transição para papel global por esta rota (escopo local).
      if (isGlobalRole(newRole)) {
        throw new ForbiddenError(
          'Não é possível atribuir papel global a um usuário escopado a uma empresa por esta rota',
        );
      }
    }

    // allowedTenantIds é gerenciado somente via endpoints /admin/multi-tenant-admins
    // para roles não-SUPER_ADMIN; removemos do objeto de update.
    const { allowedTenantIds: _ignored, ...safeUpdates } = updates;

    // Defesa em profundidade: escopo do par (role final, tenant) antes de gravar.
    assertUserScopeInvariant({ role: newRole ?? currentRole, tenantId });

    const updated = await usersRepo.updateById(
      id,
      removeUndefined(safeUpdates) as Parameters<typeof usersRepo.updateById>[1],
    );
    if (!updated) throw new NotFoundError();

    request.log.info({ tenantId, userId: id }, 'usuário atualizado');
    return reply.status(200).send(safeUser(updated));
  });

  /**
   * DELETE /users/:id — soft-delete de usuário do tenant.
   * SUPER_ADMIN: informar `?tenantId=xxx` (obrigatório).
   */
  app.delete('/users/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, ...ADMIN_ROLES);

    // MTA: tenant alvo via ?tenantId (∈ allowedTenantIds). Sem ele → NotFoundError
    // (resolveTenantId write path) — não vaza cross-tenant. Fora da lista → 404.
    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
    const effectiveTenantId = resolveTenantId(request, tenantIdParam, true);
    const tenantId = effectiveTenantId as string;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const db = app.db;

    const usersRepo = new TenantRepository<UserDoc>(db.collection('users'), { tenantId });
    const deleted = await usersRepo.softDelete(id);
    if (!deleted) throw new NotFoundError();

    request.log.info({ tenantId, userId: id }, 'usuário removido (soft delete)');
    return reply.status(204).send();
  });
};

/**
 * Busca um usuário pelo ID respeitando o escopo de tenant do solicitante.
 *
 * - SUPER_ADMIN: busca global (sem filtro de tenant).
 * - SUPER_ADMIN com `?tenantId`: restringe ao tenant informado.
 * - MULTI_TENANT_ADMIN sem `?tenantId`: restringe a `{ tenantId: { $in: allowedTenantIds } }`.
 * - MULTI_TENANT_ADMIN com `?tenantId` válido (∈ allowedTenantIds): só aquele tenant;
 *   fora da lista → lança NotFoundError (404, nunca 403).
 * - Roles normais: restringe ao tenant do token.
 *
 * Retorna `null` quando o usuário não existe no escopo (caller deve mapear para 404).
 */
async function findUserInScope(
  db: Db,
  request: FastifyRequest,
  id: string,
  explicitTenantId: string | undefined,
): Promise<UserDoc | null> {
  const ctx = resolveTenantContext(request, { explicitTenantId, write: false });

  const filter: Record<string, unknown> = { id, deleted: false };
  if (ctx.mode === 'single') {
    filter['tenantId'] = ctx.tenantId;
  } else if (ctx.mode === 'allowed') {
    filter['tenantId'] = { $in: ctx.tenantIds };
  }
  // ctx.mode === 'all' (SUPER_ADMIN sem filtro): sem restrição de tenant.

  return (await db.collection('users').findOne(filter)) as unknown as UserDoc | null;
}

/**
 * Remove `passwordHash` antes de devolver ao cliente.
 */
function safeUser(user: UserDoc): Omit<UserDoc, 'passwordHash'> {
  const { passwordHash: _, ...safe } = user;
  return safe;
}

/**
 * Remove propriedades com valor `undefined` do objeto, para compatibilidade
 * com `exactOptionalPropertyTypes`.
 */
function removeUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
}
