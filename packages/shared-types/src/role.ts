import { z } from 'zod';

/**
 * Papéis de acesso do DMDoc.
 *
 * - SUPER_ADMIN: acesso total à plataforma, gerencia todas as empresas. Único papel sem empresa fixa.
 * - TENANT_ADMIN: administra uma empresa (usuários, departamentos, tipos de documento, permissões).
 * - UPLOADER: faz upload e edita documentos, não administra estrutura.
 * - USER: leitura/busca, restrito pelas permissões de departamento.
 *
 * Ver wiki "Papéis de acesso (roles)" e spec §5.1.
 */
export const RoleSchema = z.enum(['SUPER_ADMIN', 'TENANT_ADMIN', 'UPLOADER', 'USER']);

export type Role = z.infer<typeof RoleSchema>;
