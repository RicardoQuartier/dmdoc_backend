import type { Sql } from '@dmdoc/db-pg';
import { newId } from '@dmdoc/db-pg';

/**
 * Documento de auditoria como armazenado na tabela `audit_logs` (spec §5.3).
 * `userId`/`tenantId` podem ser `null` (ex.: login de SUPER_ADMIN não tem
 * empresa). O registro é append-only e somente leitura para fins operacionais.
 */
export interface AuditLogDocument {
  tenantId: string | null;
  userId: string | null;
  action: string;
  resource: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export const AUDIT_LOGS_COLLECTION = 'audit_logs';

/**
 * Registro mínimo de auditoria. A spec (§10, invariante 7) exige AuditLog em
 * login, upload, delete, mudança de permissão e reprocessamento.
 */
export class AuditLogger {
  private readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  /**
   * Insere um registro de auditoria. Não lança em caso de falha de escrita do
   * log — auditoria nunca deve derrubar a operação principal. A falha é apenas
   * logada pelo chamador.
   */
  async record(entry: Omit<AuditLogDocument, 'createdAt'>): Promise<void> {
    const id = newId();
    await this.sql`
      INSERT INTO audit_logs (id, tenant_id, user_id, action, resource, metadata, created_at)
      VALUES (
        ${id},
        ${entry.tenantId},
        ${entry.userId},
        ${entry.action},
        ${entry.resource},
        ${JSON.stringify(entry.metadata)},
        NOW()
      )
    `;
  }
}
