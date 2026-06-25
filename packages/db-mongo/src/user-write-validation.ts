import { z } from 'zod';
import { UserSchema, isGlobalRole, type Role } from '@dmdoc/shared-types';

/**
 * Defesa em profundidade na camada de dados (spec §5.3): nenhum caminho de
 * escrita pode persistir um usuário com escopo de tenant inválido.
 *
 * A invariante de escopo é BIDIRECIONAL:
 *   - role GLOBAL (SUPER_ADMIN, MULTI_TENANT_ADMIN) ⇒ tenantId === null
 *   - role LOCAL  (TENANT_ADMIN, UPLOADER, USER)     ⇒ tenantId !== null
 *
 * Esta validação roda ANTES de qualquer insert/update na coleção `users`,
 * independentemente da rota ou do guard que a precedeu. É a última linha de
 * defesa contra a classe de bug onde, por exemplo, um TENANT_ADMIN consegue
 * gravar um SUPER_ADMIN atrelado a um tenant.
 *
 * O documento persistido tem `tenantId` como `string | null`; o `UserSchema`
 * (que descreve a forma canônica do usuário) é a fonte de verdade. Aqui
 * validamos apenas os campos relevantes ao escopo + role, pois um update pode
 * tocar só um subconjunto do documento — a checagem de invariante de escopo,
 * porém, é SEMPRE feita sobre o par (role, tenantId) final.
 */

/**
 * Forma mínima necessária para validar a invariante de escopo de um usuário.
 * Reflete o subconjunto de `UserSchema` que governa role × tenantId.
 */
export interface UserScopeCandidate {
  role: Role;
  tenantId: string | null;
}

/**
 * Erro lançado quando uma escrita de usuário violaria a invariante de escopo.
 * É um erro de PROGRAMAÇÃO/segurança (a rota deveria ter barrado antes), por
 * isso é um `Error` puro — o error handler central o mapeia para 500, mas na
 * prática ele nunca deve chegar ao cliente: serve para falhar fechado.
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
 * inserção. Reaproveita o `.refine` bidirecional do schema (escopo) e garante
 * que todos os campos obrigatórios estejam presentes e bem formados.
 *
 * Retorna o documento validado (mesma referência lógica) para encadeamento.
 * Lança `z.ZodError` se inválido — o caller (rota) decide como mapear.
 */
export function validateUserDocument(doc: unknown): z.infer<typeof UserSchema> {
  return UserSchema.parse(doc);
}
