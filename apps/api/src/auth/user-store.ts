import type { Sql } from '@dmdoc/db-pg';
import type { AuthUser } from '@dmdoc/shared-types';

/**
 * Documento de usuário como ARMAZENADO na tabela `users` (spec §5.3).
 *
 * `tenantId` é nullable para SUPER_ADMIN e MULTI_TENANT_ADMIN, que não
 * pertencem a nenhuma empresa fixa (spec §10). Inclui `passwordHash`, que NUNCA
 * sai desta camada para fora (a projeção pública é `AuthUser`).
 *
 * `allowedTenantIds` é populado apenas para MULTI_TENANT_ADMIN. Para os demais
 * papéis o campo está ausente do documento (tratado como []).
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
 * Acesso à tabela `users` para o fluxo de autenticação.
 *
 * IMPORTANTE: o login e o refresh acontecem ANTES de existir contexto de tenant
 * — por isso NÃO usam o `TenantRepository` (que exige escopo de empresa). São
 * os únicos pontos legítimos de lookup global na tabela `users`. Todo CRUD de
 * usuário pós-login (Fase 2) usará o `TenantRepository` normalmente.
 */
export class UserStore {
  private readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  /**
   * Busca usuários (não excluídos) por email, em TODAS as empresas.
   *
   * O índice único é `(tenant_id, email)`, então o mesmo email pode existir em
   * empresas diferentes — esta busca pode retornar mais de um usuário. A
   * resolução dessa ambiguidade é responsabilidade do chamador (ver
   * `findActiveUserByEmail`). Excluídos logicamente (`deleted: true`) ficam de
   * fora.
   */
  async findByEmail(email: string): Promise<UserDocument[]> {
    type Row = {
      id: string;
      tenant_id: string | null;
      email: string;
      password_hash: string;
      name: string;
      role: string;
      active: boolean;
      created_at: Date;
      allowed_tenant_ids: string[] | null;
    };

    const rows = await this.sql<Row[]>`
      SELECT id, tenant_id, email, password_hash, name, role, active, created_at, allowed_tenant_ids
      FROM users
      WHERE email = ${email}
        AND deleted = false
    `;

    return rows.map(rowToUserDocument);
  }

  /**
   * Busca um usuário ativo pelo `id` (subject do token). Usado no /auth/refresh
   * e no /auth/me para refletir o estado ATUAL do usuário (role/tenant/active).
   * Retorna `null` se não existir, estiver excluído ou inativo.
   */
  async findActiveById(id: string): Promise<UserDocument | null> {
    type Row = {
      id: string;
      tenant_id: string | null;
      email: string;
      password_hash: string;
      name: string;
      role: string;
      active: boolean;
      created_at: Date;
      allowed_tenant_ids: string[] | null;
    };

    const rows = await this.sql<Row[]>`
      SELECT id, tenant_id, email, password_hash, name, role, active, created_at, allowed_tenant_ids
      FROM users
      WHERE id = ${id}
        AND active = true
        AND deleted = false
      LIMIT 1
    `;

    const row = rows[0];
    return row ? rowToUserDocument(row) : null;
  }
}

type UserRow = {
  id: string;
  tenant_id: string | null;
  email: string;
  password_hash: string;
  name: string;
  role: string;
  active: boolean;
  created_at: Date;
  allowed_tenant_ids: string[] | null;
};

function rowToUserDocument(row: UserRow): UserDocument {
  const doc: UserDocument = {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    passwordHash: row.password_hash,
    name: row.name,
    role: row.role as UserDocument['role'],
    active: row.active,
    createdAt: row.created_at,
  };
  if (row.allowed_tenant_ids !== null && row.allowed_tenant_ids.length > 0) {
    doc.allowedTenantIds = row.allowed_tenant_ids;
  }
  return doc;
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
