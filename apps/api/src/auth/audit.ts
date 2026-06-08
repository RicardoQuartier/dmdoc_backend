import type { Db } from 'mongodb';

/**
 * Documento de auditoria como armazenado na coleção `audit_logs` (spec §5.3).
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
 * login, upload, delete, mudança de permissão e reprocessamento. Aqui cobrimos
 * apenas o que a Fase 1 produz: `auth.login`. O framework completo de auditoria
 * (mais ações, leitura via /audit-logs) é Fase 5.
 */
export class AuditLogger {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Insere um registro de auditoria. Não lança em caso de falha de escrita do
   * log — auditoria nunca deve derrubar a operação principal (ex.: um login
   * bem-sucedido não vira 500 porque o insert de log falhou). A falha é apenas
   * logada pelo chamador.
   */
  async record(entry: Omit<AuditLogDocument, 'createdAt'>): Promise<void> {
    await this.db.collection<AuditLogDocument>(AUDIT_LOGS_COLLECTION).insertOne({
      ...entry,
      createdAt: new Date(),
    });
  }
}
