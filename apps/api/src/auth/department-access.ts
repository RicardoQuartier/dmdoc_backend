import type { Db } from 'mongodb';

/**
 * Resolução de acesso a departamentos (ACL por raiz com herança dinâmica).
 *
 * Modelo de produto (Fase 6):
 *   - O acesso é concedido por DEPARTAMENTO RAIZ (nível 0, `parentId: null`).
 *   - Conceder uma raiz dá acesso de LEITURA E ESCRITA a toda a subárvore.
 *   - A herança é DINÂMICA: os filhos NÃO são materializados em
 *     `department_permissions`. A raiz é expandida para a subárvore em tempo
 *     de leitura/escrita (BFS in-memory sobre os departamentos do tenant).
 *
 * Armazenamento: cada doc de `department_permissions` representa a concessão de
 * uma raiz, com `departmentId` = id da raiz e `canRead = canWrite = true`.
 *
 * Convenção de roles (mantida): TENANT_ADMIN / SUPER_ADMIN / MULTI_TENANT_ADMIN
 * não têm restrição de ACL — o helper retorna `null` (sem filtro de departamento).
 */

const ADMIN_ROLES_WITHOUT_ACL = ['TENANT_ADMIN', 'SUPER_ADMIN', 'MULTI_TENANT_ADMIN'];

interface DepartmentPermissionDoc {
  userId: string;
  departmentId: string;
  tenantId: string;
  canRead: boolean;
}

interface DepartmentNode {
  id: string;
  parentId: string | null;
}

/**
 * Resolve o conjunto de departmentIds acessíveis a um usuário (leitura == escrita,
 * pois conceder uma raiz dá acesso total à subárvore).
 *
 * - TENANT_ADMIN / SUPER_ADMIN / MULTI_TENANT_ADMIN: retorna `null`
 *   (sem restrição de ACL por departamento).
 * - UPLOADER / USER: lê as raízes concedidas (`canRead: true`) e expande cada
 *   raiz para toda a subárvore de departamentos do tenant.
 *
 * `tenantId` pode ser `null` apenas para roles admin (que retornam cedo). Para
 * roles normais o `tenantId` vem do JWT e nunca é `null`.
 */
export async function resolveAccessibleDepartmentIds(
  db: Db,
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
  const grants = await db
    .collection<DepartmentPermissionDoc>('department_permissions')
    .find({ userId, tenantId: effectiveTenantId, canRead: true })
    .toArray();

  const rootIds = grants.map((g) => g.departmentId);
  if (rootIds.length === 0) {
    return [];
  }

  // 2. Carrega os departamentos do tenant (apenas id + parentId).
  //    Não filtra por `deleted` — um departamento soft-deletado ainda mantém
  //    os documentos vinculados acessíveis (wiki "Exclusão de departamento
  //    preserva documentos e permissões").
  const departments = await db
    .collection('departments')
    .find({ tenantId: effectiveTenantId })
    .project<DepartmentNode>({ _id: 0, id: 1, parentId: 1 })
    .toArray();

  // 3. Índice parentId → filhos para expansão por BFS.
  const childrenByParent = new Map<string, string[]>();
  for (const dept of departments) {
    if (dept.parentId !== null) {
      const siblings = childrenByParent.get(dept.parentId);
      if (siblings) {
        siblings.push(dept.id);
      } else {
        childrenByParent.set(dept.parentId, [dept.id]);
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
