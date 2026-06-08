import { z } from 'zod';

/**
 * Empresa (tenant). A raiz do isolamento multi-tenant — todo recurso
 * (exceto a própria coleção `tenants`) pertence a exatamente uma empresa.
 *
 * Cotas (`diskQuotaBytes`, `userQuota`) são validadas antes de aceitar
 * upload ou criar usuário. Ver wiki "Cotas de disco e de usuários por empresa".
 *
 * Spec §5.3 (coleção `tenants`).
 */
export const TenantSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  diskQuotaBytes: z.number().int().nonnegative(),
  userQuota: z.number().int().nonnegative(),
  active: z.boolean(),
  createdAt: z.date(),
});

export type Tenant = z.infer<typeof TenantSchema>;
