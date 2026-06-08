import { z } from 'zod';

/**
 * Departamento de uma empresa. Organizado em árvore de até 4 níveis
 * (level 0 = raiz, level 3 = folha).
 *
 * Spec §5.3 (coleção `departments`).
 */
export const DepartmentSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  name: z.string().min(1).max(200),
  level: z.number().int().min(0).max(3),
  tags: z.array(z.string()),
  deleted: z.boolean(),
  createdAt: z.date(),
});

export type Department = z.infer<typeof DepartmentSchema>;

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
