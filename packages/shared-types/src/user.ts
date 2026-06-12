import { z } from 'zod';
import { RoleSchema } from './role.js';

/**
 * Usuário de uma empresa. Tem exatamente um papel (role).
 *
 * Unicidade `(tenantId, email)` é garantida por índice no Mongo.
 * `passwordHash` é um hash argon2 — nunca a senha em texto puro.
 *
 * `allowedTenantIds` é relevante apenas para MULTI_TENANT_ADMIN: lista os
 * tenants que esse usuário pode acessar (máx 20 no MVP). Para os demais papéis
 * o campo é omitido do documento ou presente como array vazio.
 *
 * Spec §5.3 (coleção `users`).
 */
export const UserSchema = z
  .object({
    id: z.string().uuid(),
    // SUPER_ADMIN e MULTI_TENANT_ADMIN não pertencem a nenhuma empresa fixa.
    // Os demais papéis sempre têm uma empresa. Regra reforçada pelo refine abaixo.
    tenantId: z.string().uuid().nullable(),
    email: z.string().email(),
    passwordHash: z.string().min(1),
    name: z.string().min(1).max(200),
    role: RoleSchema,
    active: z.boolean(),
    createdAt: z.date(),
    allowedTenantIds: z.array(z.string().uuid()).optional(),
  })
  .refine(
    (u) => u.role === 'SUPER_ADMIN' || u.role === 'MULTI_TENANT_ADMIN' || u.tenantId !== null,
    {
      message: 'Apenas SUPER_ADMIN e MULTI_TENANT_ADMIN podem ter tenantId null',
      path: ['tenantId'],
    },
  );

export type User = z.infer<typeof UserSchema>;
