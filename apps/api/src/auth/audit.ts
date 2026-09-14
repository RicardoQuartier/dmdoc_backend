import type { EvaluatedDocumentEntriesSql, JSONValue } from '@dmdoc/db-pg';
import { newId } from '@dmdoc/db-pg';

/**
 * Conexão aceita pelo audit: o pool (`Sql`) OU o `tx` de um `sql.begin`
 * (`TransactionSql`). Com `tx`, o INSERT do audit entra na MESMA transação da
 * operação auditada — se o audit falhar, a operação é desfeita junto.
 *
 * O `@dmdoc/db-pg` não reexporta `TransactionSql` do postgres.js (e a api não
 * depende de `postgres` diretamente); `EvaluatedDocumentEntriesSql` é
 * exatamente `Sql | TransactionSql` e é reaproveitado aqui só como alias.
 */
export type AuditSql = EvaluatedDocumentEntriesSql;

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
  private readonly sql: AuditSql;

  constructor(sql: AuditSql) {
    this.sql = sql;
  }

  /**
   * Insere um registro de auditoria. Lança se a escrita falhar: cabe ao
   * chamador decidir. Rotas cujo audit é "melhor esforço" capturam e só
   * logam; rotas em que o audit é parte da operação (ex.: a justificativa de
   * uma correção só existe aqui) chamam dentro de `sql.begin` com o `tx`, e a
   * falha desfaz a operação inteira.
   */
  async record(entry: Omit<AuditLogDocument, 'createdAt'>): Promise<void> {
    const id = newId();
    // `metadata` é jsonb — `sql.json()`, NUNCA `JSON.stringify()`. Este cliente
    // postgres.js infere o tipo do parâmetro pelo destino (coluna jsonb) e
    // aplica seu PRÓPRIO serializador (JSON.stringify) sobre o valor recebido.
    // Passar uma string já serializada fazia esse serializador rodar de novo
    // em cima do texto, gravando uma string double-encoded (jsonb_typeof
    // retornava 'string', não 'object') — defeito que já mordeu em
    // `routes/admin/department-templates.ts`. `sql.json()` entrega o valor
    // já marcado para o driver serializar uma ÚNICA vez, gravando o objeto de
    // verdade — o que os consumidores (`GET /audit-logs`, `GET
    // /reports/deletions`) esperam ao ler `metadata` como jsonb OBJECT.
    await this.sql`
      INSERT INTO audit_logs (id, tenant_id, user_id, action, resource, metadata, created_at)
      VALUES (
        ${id},
        ${entry.tenantId},
        ${entry.userId},
        ${entry.action},
        ${entry.resource},
        ${this.sql.json(entry.metadata as unknown as JSONValue)},
        NOW()
      )
    `;
  }
}
