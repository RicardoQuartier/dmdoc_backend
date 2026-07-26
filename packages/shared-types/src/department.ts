import { z } from 'zod';

/**
 * Departamento de uma empresa. Organizado em árvore de profundidade ilimitada
 * (level 0 = raiz). Os níveis 0-3 têm nomes semânticos
 * (Empresa → Departamento → Categoria → Pasta de Tipo); níveis mais profundos
 * são genéricos.
 *
 * Spec §5.3 (coleção `departments`).
 */
export const DepartmentSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  name: z.string().min(1).max(200),
  level: z.number().int().min(0),
  tags: z.array(z.string()),
  deleted: z.boolean(),
  createdAt: z.date(),
});

export type Department = z.infer<typeof DepartmentSchema>;

/**
 * Body de `PATCH /departments/:id/move` — troca o pai do departamento
 * (reparent), recalculando `level` do nó e de toda a sua subárvore.
 *
 * `parentId` é sempre um uuid: o move **não** promove departamento a raiz
 * (a ACL concede acesso só por raiz — ver artigo de wiki
 * "Permissões por departamento (ACL)"). Raízes são criadas, não promovidas.
 *
 * Também não existe reordenação entre irmãos: `departments` não tem coluna
 * de ordem e a listagem ordena por `level ASC, name ASC`.
 *
 * O schema **não** é `.strict()`, por decisão: o react-arborist envia um
 * `index` (posição de drop) junto do payload, e ele é descartado em silêncio —
 * coerente com "reordenação entre irmãos é no-op". Tornar o schema estrito
 * quebraria o front.
 *
 * Spec §7 (Departamentos).
 */
export const MoveDepartmentBodySchema = z.object({
  parentId: z.string().uuid(),
});

export type MoveDepartmentBody = z.infer<typeof MoveDepartmentBodySchema>;

/**
 * Permissão de acesso de um usuário a um departamento.
 * Substituição completa via PUT — ver spec §7.
 *
 * Spec §5.3 (coleção `department_permissions`).
 */
export const DepartmentPermissionSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  departmentId: z.string().uuid(),
  canRead: z.boolean(),
  canWrite: z.boolean(),
  deleted: z.boolean(),
});

export type DepartmentPermission = z.infer<typeof DepartmentPermissionSchema>;
