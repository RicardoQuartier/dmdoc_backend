import type { Sql } from '@dmdoc/db-pg';
import { ROLE_LEVEL, RoleSchema } from '@dmdoc/shared-types';
import { NotFoundError } from '../errors/index.js';

/**
 * Resolução de acesso a departamentos (ACL por raiz com herança dinâmica).
 *
 * Modelo de produto (Fase 6):
 *   - O acesso é concedido por DEPARTAMENTO RAIZ (nível 0, `parentId: null`).
 *   - Conceder uma raiz dá acesso de LEITURA a toda a subárvore. A CAPACIDADE
 *     de escrita é adicionalmente limitada pelo PAPEL do usuário: USER é
 *     somente leitura (nunca escreve, mesmo com raiz concedida), enquanto a
 *     escrita exige nível >= UPLOADER. Esse gate por papel vive em
 *     `assertCanWriteDepartment` (abaixo) — este resolvedor apenas
 *     computa o conjunto acessível para LEITURA, reaproveitado pela checagem de
 *     escrita de UPLOADER+ para restringir o departamento à subárvore concedida.
 *   - A herança é DINÂMICA: os filhos NÃO são materializados em
 *     `department_permissions`. A raiz é expandida para a subárvore em tempo
 *     de leitura/escrita (BFS in-memory sobre os departamentos do tenant).
 *
 * Armazenamento: cada row de `department_permissions` representa a concessão de
 * uma raiz, com `department_id` = id da raiz e `can_read = can_write = true`.
 *
 * Convenção de roles (mantida): TENANT_ADMIN / SUPER_ADMIN / MULTI_TENANT_ADMIN
 * não têm restrição de ACL — o helper retorna `null` (sem filtro de departamento).
 */

const ADMIN_ROLES_WITHOUT_ACL = ['TENANT_ADMIN', 'SUPER_ADMIN', 'MULTI_TENANT_ADMIN'];

/**
 * Resolve o conjunto de departmentIds acessíveis a um usuário para LEITURA
 * (subárvore expandida das raízes concedidas). A capacidade de ESCRITA NÃO é
 * decidida aqui: ela é gated por PAPEL em `assertCanWriteDepartment` (USER é
 * somente leitura; escrita exige >= UPLOADER). Para UPLOADER+ com ACL, o
 * conjunto retornado aqui também delimita em quais departamentos a escrita é
 * permitida.
 *
 * - TENANT_ADMIN / SUPER_ADMIN / MULTI_TENANT_ADMIN: retorna `null`
 *   (sem restrição de ACL por departamento).
 * - UPLOADER / USER: lê as raízes concedidas (`can_read: true`) e expande cada
 *   raiz para toda a subárvore de departamentos do tenant.
 *
 * `tenantId` pode ser `null` apenas para roles admin (que retornam cedo). Para
 * roles normais o `tenantId` vem do JWT e nunca é `null`.
 */
export async function resolveAccessibleDepartmentIds(
  sql: Sql,
  userId: string,
  tenantId: string | null,
  role: string
): Promise<string[] | null> {
  if (ADMIN_ROLES_WITHOUT_ACL.includes(role)) {
    return null;
  }

  // Roles normais sempre têm tenantId (vem do JWT).
  const effectiveTenantId = tenantId as string;

  // 1. Raízes concedidas ao usuário.
  //    Filtra `deleted = false` para ignorar CONCESSÕES REVOGADAS (soft-delete
  //    da row de `department_permissions`). Uma concessão revogada não dá mais
  //    acesso — consistente com `GET /users/:id/permissions`. NÃO confundir com
  //    o `deleted` de `departments` (passo 2), que é deliberadamente ignorado.
  const grants = await sql<Array<{ department_id: string }>>`
    SELECT department_id
    FROM department_permissions
    WHERE user_id = ${userId}
      AND tenant_id = ${effectiveTenantId}
      AND can_read = true
      AND deleted = false
  `;

  const rootIds = grants.map((g) => g.department_id);
  if (rootIds.length === 0) {
    return [];
  }

  // 2. Carrega os departamentos do tenant (apenas id + parent_id).
  //    Não filtra por `deleted` — um departamento soft-deletado ainda mantém
  //    os documentos vinculados acessíveis (wiki "Exclusão de departamento
  //    preserva documentos e permissões").
  const departments = await sql<Array<{ id: string; parent_id: string | null }>>`
    SELECT id, parent_id
    FROM departments
    WHERE tenant_id = ${effectiveTenantId}
  `;

  // 3. Índice parentId → filhos para expansão por BFS.
  const childrenByParent = new Map<string, string[]>();
  for (const dept of departments) {
    if (dept.parent_id !== null) {
      const siblings = childrenByParent.get(dept.parent_id);
      if (siblings) {
        siblings.push(dept.id);
      } else {
        childrenByParent.set(dept.parent_id, [dept.id]);
      }
    }
  }

  // 4. Expande cada raiz concedida para toda a sua subárvore.
  const accessible = new Set<string>();
  const queue: string[] = [...rootIds];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (accessible.has(current)) continue;
    accessible.add(current);
    const children = childrenByParent.get(current);
    if (children) {
      for (const child of children) {
        if (!accessible.has(child)) queue.push(child);
      }
    }
  }

  return [...accessible];
}

/**
 * Valida se o usuário pode ESCREVER em um departamento específico.
 *
 * Duas camadas de controle, nesta ordem:
 *   1. GATE POR PAPEL — a CAPACIDADE de escrita exige nível >= UPLOADER (40).
 *      USER (20) é somente leitura por definição (wiki "Papéis de acesso
 *      (roles)"): mesmo com uma raiz concedida ativa (que lhe dá leitura da
 *      subárvore), NUNCA pode escrever. Papel desconhecido/inválido cai como
 *      SEM escrita (fail-closed). Cobre uniformemente PATCH/DELETE/reprocess/
 *      suggest-indexes — todos passam por este choke point.
 *   2. ACL POR DEPARTAMENTO — para papéis com capacidade de escrita, o
 *      departamento precisa estar no conjunto acessível (subárvore concedida)
 *      ou o papel ser admin (sem restrição de ACL).
 *
 * Lança `NotFoundError` (nunca 403 — spec §10, invariante 4) se sem permissão,
 * com a mesma mensagem em ambas as camadas para não vazar a existência do
 * recurso a quem não pode escrever nele.
 */
export async function assertCanWriteDepartment(
  sql: Sql,
  userId: string,
  tenantId: string,
  departmentId: string,
  role: string
): Promise<void> {
  // Camada 1: gate por nível de papel (fail-closed).
  // O role vem do JWT já validado, mas mantemos a checagem type-safe: um papel
  // não reconhecido resolve para nível 0 e é negado, nunca liberado.
  const parsedRole = RoleSchema.safeParse(role);
  const roleLevel = parsedRole.success ? ROLE_LEVEL[parsedRole.data] : 0;
  if (roleLevel < ROLE_LEVEL.UPLOADER) {
    throw new NotFoundError('Departamento não encontrado ou sem permissão de escrita');
  }

  const accessible = await resolveAccessibleDepartmentIds(sql, userId, tenantId, role);
  if (accessible === null) {
    // Admin sem restrição de ACL: verifica apenas que o dept pertence ao tenant.
    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM departments WHERE id = ${departmentId} AND tenant_id = ${tenantId} LIMIT 1
    `;
    if (rows.length === 0) {
      throw new NotFoundError('Departamento não encontrado');
    }
    return;
  }
  if (!accessible.includes(departmentId)) {
    throw new NotFoundError('Departamento não encontrado ou sem permissão de escrita');
  }
}
