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
  // Toggles por empresa das features de IA de sugestão (Fases 7/8/8.1) — plus
  // comercial por empresa, geridos EXCLUSIVAMENTE pelo SUPER_ADMIN via
  // `PATCH /admin/tenants/:id` (mesmo fluxo de edição de cotas). O
  // TENANT_ADMIN não tem acesso de leitura nem escrita a estas flags. Valor
  // efetivo de cada feature = platformSettings.<feature> AND tenant.<feature>
  // — ver `PlatformSettingsSchema` (Fase 6.9).
  aiClassificationEnabled: z.boolean().default(true),
  aiTitleSuggestionEnabled: z.boolean().default(true),
  aiIndexSuggestionEnabled: z.boolean().default(true),
  // 4ª feature de IA (Fase 9 / E-3): geração automática de tags por documento.
  aiTagGenerationEnabled: z.boolean().default(true),
  // 5ª feature de IA: aplica automaticamente as tags sugeridas em `documents.tags`
  // (sem exigir confirmação manual). Default ligado (decisão de produto).
  aiTagAutoApplyEnabled: z.boolean().default(true),
  // 6ª/7ª/8ª features de IA: aplicam automaticamente tipo, título e índices
  // sugeridos (sem exigir confirmação manual). Default ligado.
  aiClassificationAutoApplyEnabled: z.boolean().default(true),
  aiTitleAutoApplyEnabled: z.boolean().default(true),
  aiIndexAutoApplyEnabled: z.boolean().default(true),
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
  aiTagGenerationEnabled: z.boolean().default(true),
  aiTagAutoApplyEnabled: z.boolean().default(true),
  aiClassificationAutoApplyEnabled: z.boolean().default(true),
  aiTitleAutoApplyEnabled: z.boolean().default(true),
  aiIndexAutoApplyEnabled: z.boolean().default(true),
  updatedAt: z.date(),
});

export type PlatformSettings = z.infer<typeof PlatformSettingsSchema>;
