import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { TenantRepository } from '@dmdoc/db-pg';
import type { TenantDocument } from '@dmdoc/db-pg';
import { MoveDepartmentBodySchema, RoleSchema, ROLE_LEVEL } from '@dmdoc/shared-types';
import { ConflictError, NotFoundError, ValidationError } from '../errors/index.js';
import { requireRole } from '../auth/role-guard.js';
import { resolveTenantId, resolveTenantContext } from '../auth/resolve-tenant.js';
import { resolveAccessibleDepartmentIds } from '../auth/department-access.js';
import { AuditLogger } from '../auth/audit.js';

interface DepartmentDoc extends TenantDocument {
  parentId: string | null;
  name: string;
  level: number;
  tags: string[];
  createdAt: Date;
}

type DeptRow = {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  name: string;
  level: number;
  tags: string[];
  created_at: Date;
  deleted: boolean;
};

function rowToDept(r: DeptRow): DepartmentDoc {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    parentId: r.parent_id,
    name: r.name,
    level: r.level,
    tags: r.tags,
    createdAt: r.created_at,
    deleted: r.deleted,
  };
}

const ListDepartmentsQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
  writable: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

const CreateDepartmentBodySchema = z.object({
  name: z.string().min(1).max(200),
  parentId: z.string().uuid().nullable().default(null),
  tags: z.array(z.string()).default([]),
  tenantId: z.string().uuid().optional(),
});

const PatchDepartmentBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  tags: z.array(z.string()).optional(),
});

const TenantIdQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
});

/**
 * Params de `PATCH /departments/:id/move`.
 *
 * O `:id` é validado como uuid aqui de propósito: as demais rotas usam
 * `z.string()` puro, e por isso um id não-uuid vira erro `22P02` do Postgres e
 * retorna 500. Com `.uuid()` a resposta é 422 (`VALIDATION_ERROR`), como a
 * spec §7 promete.
 */
const MoveDepartmentParamsSchema = z.object({
  id: z.string().uuid(),
});

/**
 * Namespace fixo do advisory lock de `departments.move` — a segunda chave é o
 * hash do tenant, então moves de empresas diferentes não se serializam entre si.
 */
const MOVE_LOCK_NAMESPACE = 4242;

/**
 * Rotas de CRUD de departamentos — PostgreSQL.
 */
export const departmentsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /departments — retorna departamentos em array plano ordenado.
   */
  app.get('/departments', { preHandler: app.authenticate }, async (request, reply) => {
    const { tenantId: tenantIdParam, writable } = ListDepartmentsQuerySchema.parse(request.query);
    const sql = app.db;
    const role = request.user?.role;

    const aclTenantId =
      role === 'SUPER_ADMIN' || role === 'MULTI_TENANT_ADMIN'
        ? tenantIdParam ?? null
        : (request.tenantId as string | null) ?? null;

    let rows: DeptRow[];

    if (role === 'SUPER_ADMIN') {
      if (tenantIdParam !== undefined) {
        rows = await sql<DeptRow[]>`
          SELECT id, tenant_id, parent_id, name, level, tags, created_at, deleted
          FROM departments
          WHERE tenant_id = ${tenantIdParam}
            AND deleted = false
          ORDER BY level ASC, name ASC
          LIMIT 1000
        `;
      } else {
        rows = await sql<DeptRow[]>`
          SELECT id, tenant_id, parent_id, name, level, tags, created_at, deleted
          FROM departments
          WHERE deleted = false
          ORDER BY level ASC, name ASC
          LIMIT 1000
        `;
      }
    } else if (role === 'MULTI_TENANT_ADMIN') {
      const context = resolveTenantContext(request, { explicitTenantId: tenantIdParam, write: false });

      if (context.mode === 'single') {
        rows = await sql<DeptRow[]>`
          SELECT id, tenant_id, parent_id, name, level, tags, created_at, deleted
          FROM departments
          WHERE tenant_id = ${context.tenantId}
            AND deleted = false
          ORDER BY level ASC, name ASC
          LIMIT 1000
        `;
      } else {
        const allowedTenantIds = request.user?.allowedTenantIds ?? [];
        rows = await sql<DeptRow[]>`
          SELECT id, tenant_id, parent_id, name, level, tags, created_at, deleted
          FROM departments
          WHERE tenant_id = ANY(${allowedTenantIds}::uuid[])
            AND deleted = false
          ORDER BY level ASC, name ASC
          LIMIT 1000
        `;
      }
    } else {
      const tenantId = request.tenantId;
      if (typeof tenantId !== 'string') {
        throw new Error('tenantId ausente no contexto da request');
      }
      rows = await sql<DeptRow[]>`
        SELECT id, tenant_id, parent_id, name, level, tags, created_at, deleted
        FROM departments
        WHERE tenant_id = ${tenantId}
          AND deleted = false
        ORDER BY level ASC, name ASC
        LIMIT 1000
      `;
    }

    let items = rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      parentId: r.parent_id,
      name: r.name,
      level: r.level,
      tags: r.tags,
      createdAt: r.created_at,
      deleted: r.deleted,
    })) as (DepartmentDoc & { documentCount?: number })[];

    // Filtro de ESCRITA — precisa espelhar EXATAMENTE o gate de escrita real
    // (`assertCanWriteDepartment`, documents.ts:517-547), senão o front oferece
    // destinos que o backend recusa com 404.
    if (writable) {
      const userId = request.user?.sub;
      if (typeof userId !== 'string') {
        throw new Error('userId ausente no contexto da request');
      }

      // Camada 1 — gate por NÍVEL DE PAPEL (fail-closed). Papel abaixo de
      // UPLOADER não escreve em lugar nenhum, mesmo com raiz concedida ativa:
      // a concessão dá leitura, o papel é que habilita a escrita (wiki
      // "Permissões por departamento (ACL)"). Papel desconhecido resolve para
      // nível 0 e também recebe lista vazia, nunca liberado.
      const parsedRole = RoleSchema.safeParse(role);
      const roleLevel = parsedRole.success ? ROLE_LEVEL[parsedRole.data] : 0;
      if (roleLevel < ROLE_LEVEL.UPLOADER) {
        request.log.debug(
          { tenantId: aclTenantId, userId, role },
          'writable=true com papel sem capacidade de escrita; devolvendo lista vazia',
        );
        return reply.status(200).send([]);
      }

      // Camada 2 — ACL por raiz concedida (`null` = admin sem restrição).
      const accessible = await resolveAccessibleDepartmentIds(
        sql,
        userId,
        aclTenantId,
        role ?? ''
      );
      if (accessible !== null) {
        const accessibleSet = new Set(accessible);
        items = items.filter((dept) => accessibleSet.has(dept.id));
      }
    }

    // Contagem de documentos por departamento
    const departmentIds = items.map((d) => d.id);
    const countMap = new Map<string, number>();

    if (departmentIds.length > 0) {
      const counts = await sql<Array<{ department_id: string; count: string }>>`
        SELECT department_id, COUNT(*) AS count
        FROM documents
        WHERE department_id = ANY(${departmentIds}::uuid[])
          AND deleted = false
        GROUP BY department_id
      `;
      for (const { department_id, count } of counts) {
        countMap.set(department_id, parseInt(count, 10));
      }
    }

    const itemsWithCount = items.map((dept) => ({
      ...dept,
      documentCount: countMap.get(dept.id) ?? 0,
    }));

    return reply.status(200).send(itemsWithCount);
  });

  /**
   * POST /departments — cria departamento.
   */
  app.post('/departments', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN', 'MULTI_TENANT_ADMIN');

    const body = CreateDepartmentBodySchema.parse(request.body);
    const effectiveTenantId = resolveTenantId(request, body.tenantId, true);
    const tenantId = effectiveTenantId as string;

    const { name, parentId, tags } = body;
    const sql = app.db;

    const repo = new TenantRepository<DepartmentDoc>(sql, 'departments', { tenantId });

    let level = 0;

    if (parentId !== null) {
      const parent = await repo.findById(parentId);
      if (!parent) throw new NotFoundError('Departamento pai não encontrado');
      level = parent.level + 1;
    }

    const dept = await repo.insertOne({
      parentId,
      name,
      level,
      tags,
      createdAt: new Date(),
    });

    request.log.info({ tenantId, departmentId: dept.id }, 'departamento criado');
    return reply.status(201).send(rowToDept(dept as unknown as DeptRow));
  });

  /**
   * PATCH /departments/:id — atualiza nome ou tags do departamento.
   */
  app.patch('/departments/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN', 'MULTI_TENANT_ADMIN');

    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
    const effectiveTenantId = resolveTenantId(request, tenantIdParam, true);
    const tenantId = effectiveTenantId as string;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const updates = PatchDepartmentBodySchema.parse(request.body);
    const sql = app.db;

    const repo = new TenantRepository<DepartmentDoc>(sql, 'departments', { tenantId });
    const updated = await repo.updateById(
      id,
      removeUndefined(updates) as Parameters<typeof repo.updateById>[1]
    );
    if (!updated) throw new NotFoundError();

    request.log.info({ tenantId, departmentId: id }, 'departamento atualizado');
    return reply.status(200).send(rowToDept(updated as unknown as DeptRow));
  });

  /**
   * PATCH /departments/:id/move — troca o pai do departamento (reparent).
   *
   * Recalcula o `level` materializado do nó e de toda a sua subárvore em uma
   * única transação. Recusa ciclo (409), nó com concessão ativa (409) e nó ou
   * destino fora do tenant (404 — nunca 403). Contrato completo na spec §7.
   */
  app.patch('/departments/:id/move', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN', 'MULTI_TENANT_ADMIN');

    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
    const effectiveTenantId = resolveTenantId(request, tenantIdParam, true);
    const tenantId = effectiveTenantId as string;

    const { id } = MoveDepartmentParamsSchema.parse(request.params);
    const { parentId } = MoveDepartmentBodySchema.parse(request.body);

    // Regra que o Zod do body não expressa (não conhece o `:id`): mover para
    // dentro de si mesmo é entrada inválida (422), não conflito de estado.
    if (parentId === id) {
      throw new ValidationError('Um departamento não pode ser movido para dentro de si mesmo');
    }

    const sql = app.db;

    const outcome = await sql.begin(async (tx) => {
      const trx = tx as unknown as typeof sql;

      // Serializa os moves da mesma empresa ANTES de qualquer SELECT: sem isso,
      // duas transações concorrentes validam contra snapshots pré-estado e
      // conseguem fechar um ciclo (A sob B e B sob A). `FOR UPDATE` sozinho não
      // resolve — a validação percorre a cadeia inteira de ancestrais, que não
      // está travada, e a ordem invertida de aquisição daria deadlock (40P01).
      // O lock é liberado no commit/rollback.
      await trx`SELECT pg_advisory_xact_lock(${MOVE_LOCK_NAMESPACE}, hashtext(${tenantId}::text))`;

      const nodeRows = await trx<DeptRow[]>`
        SELECT id, tenant_id, parent_id, name, level, tags, created_at, deleted
        FROM departments
        WHERE id = ${id}
          AND tenant_id = ${tenantId}
          AND deleted = false
        FOR UPDATE
      `;
      const node = nodeRows[0];
      if (!node) throw new NotFoundError('Departamento não encontrado');

      const parentRows = await trx<DeptRow[]>`
        SELECT id, tenant_id, parent_id, name, level, tags, created_at, deleted
        FROM departments
        WHERE id = ${parentId}
          AND tenant_id = ${tenantId}
          AND deleted = false
        FOR UPDATE
      `;
      const parent = parentRows[0];
      if (!parent) throw new NotFoundError('Departamento de destino não encontrado');

      // Idempotência: destino já é o pai atual — 200 sem escrita e sem audit.
      if (node.parent_id === parentId) {
        return { moved: false as const, dept: node };
      }

      // Concessão ativa bloqueia. Checado pelo id do nó movido, sem condicionar
      // a `parent_id IS NULL`: como o destino é sempre um nó real, o nó movido
      // deixa de ser raiz — é exatamente a pergunta "o move quebraria a
      // invariante 'concessão só existe em raiz'?". Checar pelo id também pega
      // concessão legada em nó não-raiz.
      const grantRows = await trx<Array<{ user_count: number }>>`
        SELECT COUNT(DISTINCT user_id)::int AS user_count
        FROM department_permissions
        WHERE department_id = ${id}
          AND tenant_id = ${tenantId}
          AND deleted = false
      `;
      const userCount = grantRows[0]?.user_count ?? 0;
      if (userCount > 0) {
        throw new ConflictError(
          `Este departamento-raiz tem acesso concedido a ${userCount} usuário(s). ` +
            'Revogue as permissões em Permissões antes de movê-lo.',
        );
      }

      // Ciclo + profundidade REAL do destino em uma query só.
      //
      // A recursão NÃO filtra `deleted = false` de propósito: um ancestral
      // soft-deletado continua sendo elo real da cadeia de `parent_id` (o front
      // o trata como órfão, o banco não). Filtrar abriria caminho para fechar um
      // ciclo passando por nó excluído — mesma escolha de
      // `auth/department-access.ts:76-84`.
      //
      // `CYCLE ... SET is_cycle USING path` (PG 14+; o projeto roda pg16) impede
      // loop infinito caso os dados JÁ contenham um ciclo herdado.
      //
      // `parent_depth` é a profundidade contada pela cadeia, não o `level`
      // materializado — assim `newLevel` é auto-corretivo em linhas legadas.
      const cycleRows = await trx<Array<{ creates_cycle: boolean | null; parent_depth: number | null }>>`
        WITH RECURSIVE ancestors AS (
          SELECT d.id, d.parent_id, 0 AS depth
            FROM departments d
           WHERE d.id = ${parentId} AND d.tenant_id = ${tenantId}
          UNION ALL
          SELECT p.id, p.parent_id, a.depth + 1
            FROM departments p
            JOIN ancestors a ON p.id = a.parent_id
           WHERE p.tenant_id = ${tenantId}
        ) CYCLE id SET is_cycle USING path
        SELECT bool_or(id = ${id}) AS creates_cycle, MAX(depth) AS parent_depth
          FROM ancestors
      `;

      if (cycleRows[0]?.creates_cycle === true) {
        throw new ConflictError('Não é possível mover um departamento para dentro da própria subárvore.');
      }

      const newLevel = (cycleRows[0]?.parent_depth ?? parent.level) + 1;

      await trx`
        UPDATE departments
        SET parent_id = ${parentId}
        WHERE id = ${id}
          AND tenant_id = ${tenantId}
      `;

      // Recalcula o `level` da subárvore inteira. A descida também NÃO filtra
      // `deleted`: descendentes soft-deletados têm o level corrigido, mantendo a
      // invariante `level = profundidade` caso um dia sejam restaurados.
      // `IS DISTINCT FROM` evita reescrever linhas que já estão corretas.
      const updated = await trx`
        WITH RECURSIVE subtree AS (
          SELECT d.id, ${newLevel}::int AS new_level
            FROM departments d
           WHERE d.id = ${id} AND d.tenant_id = ${tenantId}
          UNION ALL
          SELECT c.id, s.new_level + 1
            FROM departments c
            JOIN subtree s ON c.parent_id = s.id
           WHERE c.tenant_id = ${tenantId}
             AND NOT s.is_cycle
        ) CYCLE id SET is_cycle USING path
        UPDATE departments d
           SET level = s.new_level
          FROM subtree s
         WHERE d.id = s.id
           AND d.tenant_id = ${tenantId}
           AND NOT s.is_cycle
           AND d.level IS DISTINCT FROM s.new_level
      `;

      const freshRows = await trx<DeptRow[]>`
        SELECT id, tenant_id, parent_id, name, level, tags, created_at, deleted
        FROM departments
        WHERE id = ${id}
          AND tenant_id = ${tenantId}
        LIMIT 1
      `;
      const fresh = freshRows[0];
      /* c8 ignore next */
      if (!fresh) throw new NotFoundError('Departamento não encontrado');

      return {
        moved: true as const,
        dept: fresh,
        fromParentId: node.parent_id,
        previousLevel: node.level,
        newLevel,
        affectedCount: updated.count,
      };
    });

    if (!outcome.moved) {
      request.log.info(
        { tenantId, departmentId: id, userId: request.user?.sub, parentId },
        'move de departamento sem efeito (destino já é o pai atual)',
      );
      return reply.status(200).send(rowToDept(outcome.dept));
    }

    const auditLogger = new AuditLogger(sql);
    try {
      await auditLogger.record({
        tenantId,
        userId: request.user!.sub,
        action: 'department.move',
        resource: `departments/${id}`,
        metadata: {
          departmentId: id,
          fromParentId: outcome.fromParentId,
          toParentId: parentId,
          previousLevel: outcome.previousLevel,
          newLevel: outcome.newLevel,
          affectedCount: outcome.affectedCount,
        },
      });
    } catch (auditError) {
      request.log.error(
        { err: auditError, tenantId, departmentId: id, userId: request.user?.sub },
        'falha ao registrar audit log de move de departamento',
      );
    }

    request.log.info(
      {
        tenantId,
        departmentId: id,
        userId: request.user?.sub,
        fromParentId: outcome.fromParentId,
        toParentId: parentId,
        newLevel: outcome.newLevel,
        affectedCount: outcome.affectedCount,
      },
      'departamento movido',
    );
    return reply.status(200).send(rowToDept(outcome.dept));
  });

  /**
   * DELETE /departments/:id — exclusão lógica somente do departamento.
   */
  app.delete('/departments/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN', 'MULTI_TENANT_ADMIN');

    const { tenantId: tenantIdParam } = TenantIdQuerySchema.parse(request.query);
    const effectiveTenantId = resolveTenantId(request, tenantIdParam, true);
    const tenantId = effectiveTenantId as string;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const sql = app.db;

    const repo = new TenantRepository<DepartmentDoc>(sql, 'departments', { tenantId });

    const dept = await repo.findById(id);
    if (!dept) throw new NotFoundError();

    const childCount = await repo.count({ parentId: id } as Partial<DepartmentDoc>);
    if (childCount > 0) {
      throw new ConflictError('Departamento possui sub-departamentos ativos');
    }

    await repo.softDelete(id);

    request.log.info(
      { tenantId, departmentId: id },
      'departamento removido (soft delete); documentos e permissões preservados'
    );
    return reply.status(204).send();
  });
};

export type { DepartmentDoc };

function removeUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
}
