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
export const ADMIN_ROLES = ['SUPER_ADMIN', 'MULTI_TENANT_ADMIN', 'TENANT_ADMIN'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/**
 * Hierarquia de papéis por nível numérico. Quanto maior o número, mais
 * privilégios. Usado pela regra de gestão "inferior ou igual": um solicitante
 * só pode criar/editar/promover/rebaixar/excluir um usuário cujo nível seja
 * MENOR OU IGUAL ao seu (pares do mesmo nível são permitidos; acima nunca).
 *
 * - SUPER_ADMIN (100): GLOBAL — tenantId DEVE ser null.
 * - MULTI_TENANT_ADMIN (80): GLOBAL — tenantId DEVE ser null; opera via allowedTenantIds.
 * - TENANT_ADMIN (60): LOCAL — tenantId obrigatório.
 * - UPLOADER (40): LOCAL — escreve documentos. Acima de USER.
 * - USER (20): LOCAL — apenas leitura/busca.
 *
 * Ver spec §5.1.
 */
export const ROLE_LEVEL: Record<Role, number> = {
  SUPER_ADMIN: 100,
  MULTI_TENANT_ADMIN: 80,
  TENANT_ADMIN: 60,
  UPLOADER: 40,
  USER: 20,
};

/**
 * Papéis GLOBAIS — não pertencem a nenhuma empresa fixa e, por invariante de
 * escopo, têm `tenantId === null`. Os demais papéis são LOCAIS (tenantId
 * obrigatório).
 */
export function isGlobalRole(role: Role): boolean {
  return role === 'SUPER_ADMIN' || role === 'MULTI_TENANT_ADMIN';
}

/**
 * Regra de gestão "inferior ou igual": o solicitante (`actorRole`) pode gerir
 * um usuário de papel `targetRole` somente se seu nível for maior ou igual ao
 * do alvo. NUNCA permite gerir um papel acima do próprio nível.
 *
 * Esta é uma checagem ADICIONAL ao gate base de `ADMIN_ROLES` (apenas
 * SUPER_ADMIN, MULTI_TENANT_ADMIN e TENANT_ADMIN acessam a gestão de usuários).
 */
export function canManageRole(actorRole: Role, targetRole: Role): boolean {
  return ROLE_LEVEL[actorRole] >= ROLE_LEVEL[targetRole];
}
