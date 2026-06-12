import { z } from 'zod';
import { RoleSchema } from './role.js';

/**
 * Identidade autenticada carregada no access token e exposta nas respostas de
 * autenticação. É a projeção PÚBLICA do usuário — nunca inclui `passwordHash`.
 *
 * `tenantId` é `null` para SUPER_ADMIN e MULTI_TENANT_ADMIN, que não pertencem
 * a nenhuma empresa fixa (spec §10, invariante 3). Para os demais papéis é
 * sempre uma empresa concreta.
 *
 * `allowedTenantIds` é significativo apenas para MULTI_TENANT_ADMIN (lista os
 * tenants que o MTA pode acessar, máx 20 no MVP). Para os demais papéis é
 * sempre um array vazio.
 */
export const AuthUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().min(1).max(200),
  role: RoleSchema,
  tenantId: z.string().uuid().nullable(),
  allowedTenantIds: z.array(z.string().uuid()).default([]),
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
 * Resumo de empresa retornado no login do MULTI_TENANT_ADMIN para que o cliente
 * possa apresentar o seletor de contexto sem precisar de um request adicional.
 */
export const AllowedTenantSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});

export type AllowedTenantSummary = z.infer<typeof AllowedTenantSummarySchema>;

/**
 * Resposta de `POST /auth/login`: o par de tokens + os dados básicos do usuário.
 *
 * `allowedTenants` é preenchido apenas quando o role é MULTI_TENANT_ADMIN —
 * contém nome + id dos tenants da lista para evitar roundtrips adicionais no
 * frontend.
 */
export const LoginResponseSchema = TokenPairSchema.extend({
  user: AuthUserSchema,
  allowedTenants: z.array(AllowedTenantSummarySchema).optional(),
});

export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/**
 * Corpo de `POST /auth/refresh`.
 */
export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});

export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;
