import { z } from 'zod';
import { RoleSchema } from './role.js';

/**
 * Usuário de uma empresa. Tem exatamente um papel (role).
 *
 * Unicidade `(tenantId, email)` é garantida por índice no Mongo.
 * `passwordHash` é um hash argon2 — nunca a senha em texto puro.
 *
 * Spec §5.3 (coleção `users`).
 */
export const UserSchema = z
  .object({
    id: z.string().uuid(),
    // SUPER_ADMIN não pertence a nenhuma empresa, logo tenantId é nulo para ele.
    // Os demais papéis sempre têm uma empresa. Regra reforçada pelo refine abaixo.
    tenantId: z.string().uuid().nullable(),
    email: z.string().email(),
    passwordHash: z.string().min(1),
    name: z.string().min(1).max(200),
    role: RoleSchema,
    active: z.boolean(),
    createdAt: z.date(),
  })
  .refine((u) => u.role === 'SUPER_ADMIN' || u.tenantId !== null, {
    message: 'Apenas SUPER_ADMIN pode ter tenantId null',
    path: ['tenantId'],
  });

export type User = z.infer<typeof UserSchema>;
