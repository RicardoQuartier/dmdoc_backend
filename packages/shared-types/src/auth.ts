import { z } from 'zod';
import { RoleSchema } from './role.js';

/**
 * Identidade autenticada carregada no access token e exposta nas respostas de
 * autenticação. É a projeção PÚBLICA do usuário — nunca inclui `passwordHash`.
 *
 * `tenantId` é `null` apenas para SUPER_ADMIN, que não pertence a nenhuma
 * empresa fixa (spec §10, invariante 3). Para os demais papéis é sempre uma
 * empresa concreta.
 */
export const AuthUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().min(1).max(200),
  role: RoleSchema,
  tenantId: z.string().uuid().nullable(),
});

export type AuthUser = z.infer<typeof AuthUserSchema>;

/**
 * Corpo de `POST /auth/login`. Login é PRÉ-contexto de tenant: o usuário se
 * identifica apenas por email + senha, sem informar a empresa.
 */
export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/**
 * Par de tokens emitido por login/refresh. Ambos são JWT assinados, retornados
 * no corpo da resposta (sem cookie — decisão de produto: tokens stateless no
 * body, cliente os guarda e descarta no logout).
 */
export const TokenPairSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
});

export type TokenPair = z.infer<typeof TokenPairSchema>;

/**
 * Resposta de `POST /auth/login`: o par de tokens + os dados básicos do usuário.
 */
export const LoginResponseSchema = TokenPairSchema.extend({
  user: AuthUserSchema,
});

export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/**
 * Corpo de `POST /auth/refresh`.
 */
export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});

export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;
