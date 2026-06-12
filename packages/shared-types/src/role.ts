import { z } from 'zod';

/**
 * Papéis de acesso do DMDoc.
 *
 * - SUPER_ADMIN: acesso total à plataforma, gerencia todas as empresas. Único papel sem empresa fixa.
 * - MULTI_TENANT_ADMIN (MTA): acesso transparente a múltiplos tenants atribuídos. Não pertence a
 *   nenhuma empresa fixa (tenantId null no token); opera sobre os tenants listados em
 *   `allowedTenantIds`. Leituras buscam em todos os tenants da lista; escritas exigem tenantId
 *   explícito validado contra a lista. Limite de 20 tenants por MTA no MVP.
 * - TENANT_ADMIN: administra uma empresa (usuários, departamentos, tipos de documento, permissões).
 * - UPLOADER: faz upload e edita documentos, não administra estrutura.
 * - USER: leitura/busca, restrito pelas permissões de departamento.
 *
 * Ver wiki "Papéis de acesso (roles)" e spec §5.1.
 */
export const RoleSchema = z.enum([
  'SUPER_ADMIN',
  'MULTI_TENANT_ADMIN',
  'TENANT_ADMIN',
  'UPLOADER',
  'USER',
]);

export type Role = z.infer<typeof RoleSchema>;

/**
 * Papéis com capacidade administrativa intra-tenant. Usado em guards para
 * operações que exigem nível admin (criar usuários, gerenciar departamentos,
 * etc.) mas não requerem acesso global de SUPER_ADMIN.
 */
export const ADMIN_ROLES = ['TENANT_ADMIN', 'MULTI_TENANT_ADMIN'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];
