import { z } from 'zod';
import { UserSchema, isGlobalRole, type Role } from '@dmdoc/shared-types';

/**
 * Defesa em profundidade na camada de dados (spec §5.3): nenhum caminho de
 * escrita pode persistir um usuário com escopo de tenant inválido.
 *
 * Idêntico a packages/db-mongo/src/user-write-validation.ts — sem dependência
 * de MongoDB; copiado aqui para que o pacote db-pg seja autossuficiente.
 *
 * A invariante de escopo é BIDIRECIONAL:
 *   - role GLOBAL (SUPER_ADMIN, MULTI_TENANT_ADMIN) ⇒ tenantId === null
 *   - role LOCAL  (TENANT_ADMIN, UPLOADER, USER)     ⇒ tenantId !== null
 */

/**
 * Forma mínima necessária para validar a invariante de escopo de um usuário.
 */
export interface UserScopeCandidate {
  role: Role;
  tenantId: string | null;
}

/**
 * Erro lançado quando uma escrita de usuário violaria a invariante de escopo.
 */
export class UserScopeInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserScopeInvariantError';
  }
}

/**
 * Valida a invariante de escopo bidirecional para o par (role, tenantId) final
 * de um usuário a ser persistido. Lança `UserScopeInvariantError` se violada.
 */
export function assertUserScopeInvariant(candidate: UserScopeCandidate): void {
  const scopeValid = isGlobalRole(candidate.role)
    ? candidate.tenantId === null
    : candidate.tenantId !== null;

  if (!scopeValid) {
    throw new UserScopeInvariantError(
      isGlobalRole(candidate.role)
        ? `Escopo inválido: role global ${candidate.role} não pode ter tenantId (${String(
            candidate.tenantId,
          )})`
        : `Escopo inválido: role local ${candidate.role} exige tenantId não-nulo`,
    );
  }
}

/**
 * Valida um documento de usuário COMPLETO contra `UserSchema` antes de uma
 * inserção. Retorna o documento validado. Lança `z.ZodError` se inválido.
 */
export function validateUserDocument(doc: unknown): z.infer<typeof UserSchema> {
  return UserSchema.parse(doc);
}
