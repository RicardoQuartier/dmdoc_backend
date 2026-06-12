import type { Db } from 'mongodb';
import type { AuthUser } from '@dmdoc/shared-types';

/**
 * Documento de usuário como ARMAZENADO na coleção `users` (spec §5.3).
 *
 * `tenantId` é nullable para SUPER_ADMIN e MULTI_TENANT_ADMIN, que não
 * pertencem a nenhuma empresa fixa (spec §10). Inclui `passwordHash`, que NUNCA
 * sai desta camada para fora (a projeção pública é `AuthUser`).
 *
 * `allowedTenantIds` é populado apenas para MULTI_TENANT_ADMIN. Para os demais
 * papéis o campo está ausente do documento Mongo (tratado como []).
 */
export interface UserDocument {
  id: string;
  tenantId: string | null;
  email: string;
  passwordHash: string;
  name: string;
  role: AuthUser['role'];
  active: boolean;
  createdAt: Date;
  allowedTenantIds?: string[];
}

export const USERS_COLLECTION = 'users';

/**
 * Acesso à coleção `users` para o fluxo de autenticação.
 *
 * IMPORTANTE: o login e o refresh acontecem ANTES de existir contexto de tenant
 * — por isso NÃO usam o `TenantRepository` (que exige escopo de empresa). São
 * os únicos pontos legítimos de lookup global na coleção `users`. Todo CRUD de
 * usuário pós-login (Fase 2) usará o `TenantRepository` normalmente.
 */
export class UserStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Busca usuários (não excluídos) por email, em TODAS as empresas.
   *
   * O índice único é `(tenantId, email)`, então o mesmo email pode existir em
   * empresas diferentes — esta busca pode retornar mais de um usuário. A
   * resolução dessa ambiguidade é responsabilidade do chamador (ver
   * `findActiveUserByEmail`). Excluídos logicamente (`deleted: true`) ficam de
   * fora; documentos sem o campo `deleted` (ex.: seed legado) são considerados
   * ativos.
   */
  async findByEmail(email: string): Promise<UserDocument[]> {
    const docs = await this.db
      .collection<UserDocument & { deleted?: boolean }>(USERS_COLLECTION)
      .find({ email, deleted: { $ne: true } })
      .toArray();
    return docs.map(stripMongoId);
  }

  /**
   * Busca um usuário ativo pelo `id` (subject do token). Usado no /auth/refresh
   * e no /auth/me para refletir o estado ATUAL do usuário (role/tenant/active).
   * Retorna `null` se não existir, estiver excluído ou inativo.
   */
  async findActiveById(id: string): Promise<UserDocument | null> {
    const doc = await this.db
      .collection<UserDocument & { deleted?: boolean }>(USERS_COLLECTION)
      .findOne({ id, active: true, deleted: { $ne: true } });
    return doc ? stripMongoId(doc) : null;
  }
}

function stripMongoId(doc: UserDocument & { _id?: unknown; deleted?: boolean }): UserDocument {
  const { _id: _ignoredId, deleted: _ignoredDeleted, ...rest } = doc;
  return rest;
}

/**
 * Projeta um `UserDocument` na identidade pública `AuthUser` (sem passwordHash).
 *
 * `allowedTenantIds` é repassado para MTA; para os demais papéis o campo está
 * ausente no documento e é normalizado para [].
 */
export function toAuthUser(user: UserDocument): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId,
    allowedTenantIds: user.allowedTenantIds ?? [],
  };
}
