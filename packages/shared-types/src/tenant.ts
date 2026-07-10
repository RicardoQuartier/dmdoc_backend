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
  // Toggles por empresa das features de IA de sugestão (Fases 7/8/8.1),
  // geridos pelo TENANT_ADMIN via `PATCH /tenant/ai-settings`. Valor efetivo
  // de cada feature = platformSettings.<feature> AND tenant.<feature> — ver
  // `PlatformSettingsSchema` (Fase 6.9).
  aiClassificationEnabled: z.boolean().default(true),
  aiTitleSuggestionEnabled: z.boolean().default(true),
  aiIndexSuggestionEnabled: z.boolean().default(true),
});

export type Tenant = z.infer<typeof TenantSchema>;

/**
 * Configuração global de plataforma — registro SINGLETON (sem tenantId),
 * gerido exclusivamente pelo SUPER_ADMIN via `PATCH /admin/platform-settings`.
 * Kill switch das mesmas 3 features de IA de sugestão presentes em `Tenant`:
 * quando desligada aqui, nenhum tenant consegue usá-la, independente da
 * própria configuração. Spec §5.3 (coleção `platform_settings`, Fase 6.9).
 */
export const PlatformSettingsSchema = z.object({
  id: z.string().uuid(),
  aiClassificationEnabled: z.boolean().default(true),
  aiTitleSuggestionEnabled: z.boolean().default(true),
  aiIndexSuggestionEnabled: z.boolean().default(true),
  updatedAt: z.date(),
});

export type PlatformSettings = z.infer<typeof PlatformSettingsSchema>;
