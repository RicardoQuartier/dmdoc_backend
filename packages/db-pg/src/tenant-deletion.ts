import type { Sql } from 'postgres';

/**
 * Dependências externas injetadas na purga de uma empresa (tenant).
 *
 * O pacote `@dmdoc/db-pg` NÃO conhece o S3 nem o logger concreto da aplicação —
 * ambos os apps (api e worker) dependem deste pacote, mas não o contrário. Para
 * evitar acoplamento, a remoção dos objetos no storage é injetada por callback
 * e o logger é uma interface mínima estrutural (compatível com Pino).
 */
export interface PurgeTenantDeps {
  /**
   * Remove todos os objetos sob um prefixo no storage (ex.: `tenants/{id}/`).
   * Não-transacional: chamado FORA da transação de banco. Falhas são logadas,
   * mas não revertem o que já foi purgado no PostgreSQL.
   */
  deleteS3Prefix: (prefix: string) => Promise<void>;
  /** Logger mínimo estrutural — compatível com Pino (`app.log` / `request.log`). */
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}

/**
 * Resumo das contagens de linhas removidas por tabela. Vira metadado do audit
 * log. Usa índice de string (em vez de interface fechada) para ser aceito
 * diretamente como payload JSON pelo `sql.json`.
 */
type PurgeCounts = Record<
  | 'chunks'
  | 'documentContent'
  | 'documents'
  | 'departmentPermissions'
  | 'documentTypeIndexFields'
  | 'globalTypeTenantDepts'
  | 'documentTypes'
  | 'departments'
  | 'users',
  number
>;

/**
 * Purga TODO o conteúdo de uma empresa (tenant) e seus arquivos, preservando a
 * trilha de auditoria. É o núcleo da exclusão de empresa (spec §14, fase 6).
 *
 * Invariantes (multi-tenancy inegociável):
 *
 * - **Toda query filtra por `tenant_id`.** Nenhuma linha de outra empresa é
 *   tocada — o isolamento é absoluto, inclusive na purga.
 * - **Auditoria preservada.** `document_events` (append-only) e `audit_logs`
 *   permanecem; apenas seus ponteiros para linhas que serão apagadas
 *   (`document_id`, `document_type_id`, `uploaded_by_id`, `user_id`) são
 *   anulados, mantendo `tenant_id` para rastreabilidade.
 * - **Tipos globais intocados.** `document_types` com `tenant_id IS NULL` são
 *   compartilhados entre empresas e nunca são apagados aqui.
 * - **Idempotente.** Re-executar não quebra: todos os deletes são
 *   `WHERE tenant_id = $1` (afetam 0 linhas na segunda vez) e o soft-delete do
 *   tenant usa `AND deleted = false`.
 *
 * Ordem de execução:
 *
 * 1. Anular ponteiros nas tabelas preservadas (`document_events`, `audit_logs`).
 * 2. Hard-delete em cascata (filhos → pais), respeitando as FKs `NO ACTION`.
 * 3. Soft-delete do tenant + rename do `name` (libera o índice único de nome,
 *    mesmo padrão da anonimização de email em `users`).
 *    → Passos 1–3 rodam numa única transação (`sql.begin`).
 * 4. Purga dos objetos no storage sob `tenants/{id}/` (FORA da transação;
 *    falha é logada, não aborta o que já foi feito no banco).
 * 5. Registro de auditoria `tenant.delete` (após a purga de storage).
 *
 * @param sql       Cliente postgres.js (pool de conexões).
 * @param tenantId  UUID da empresa a purgar.
 * @param deps      Callback de storage + logger.
 */
export async function purgeTenantData(
  sql: Sql,
  tenantId: string,
  deps: PurgeTenantDeps,
): Promise<void> {
  const counts = await sql.begin(async (tx): Promise<PurgeCounts> => {
    // --- Passo 1: anular ponteiros nas tabelas preservadas (auditoria) -------
    // document_events é append-only (sem coluna `deleted`); preservamos a linha
    // e anulamos os FKs para as linhas que serão removidas a seguir.
    // `uploaded_by_id` só é anulado quando aponta para um usuário DO tenant (que
    // será removido). Uploaders globais (SUPER_ADMIN/MULTI_TENANT_ADMIN, que NÃO
    // são removidos) são preservados — não são "dados removidos".
    await tx`
      UPDATE document_events
         SET document_id = NULL,
             document_type_id = NULL,
             uploaded_by_id = CASE
               WHEN uploaded_by_id IN (SELECT id FROM users WHERE tenant_id = ${tenantId})
                 THEN NULL
               ELSE uploaded_by_id
             END
       WHERE tenant_id = ${tenantId}
    `;
    // audit_logs mantém tenant_id (rastreabilidade) e só anula o user_id de
    // usuários DO tenant. O ator da própria exclusão (SUPER_ADMIN, usuário global
    // que não é removido) é preservado — invariante "audit guarda quem fez".
    await tx`
      UPDATE audit_logs
         SET user_id = NULL
       WHERE tenant_id = ${tenantId}
         AND user_id IN (SELECT id FROM users WHERE tenant_id = ${tenantId})
    `;

    // --- Passo 2: hard-delete em cascata (filhos → pais) ---------------------
    const chunks = (await tx`DELETE FROM chunks WHERE tenant_id = ${tenantId}`).count;
    const documentContent = (
      await tx`DELETE FROM document_content WHERE tenant_id = ${tenantId}`
    ).count;
    const documents = (await tx`DELETE FROM documents WHERE tenant_id = ${tenantId}`).count;
    const departmentPermissions = (
      await tx`DELETE FROM department_permissions WHERE tenant_id = ${tenantId}`
    ).count;
    // Index fields não têm tenant_id próprio — filtram pelos tipos do tenant.
    const documentTypeIndexFields = (
      await tx`
        DELETE FROM document_type_index_fields
         WHERE document_type_id IN (
           SELECT id FROM document_types WHERE tenant_id = ${tenantId}
         )
      `
    ).count;
    const globalTypeTenantDepts = (
      await tx`DELETE FROM global_type_tenant_depts WHERE tenant_id = ${tenantId}`
    ).count;
    // Só tipos DO tenant; tipos globais (tenant_id IS NULL) NÃO são tocados.
    const documentTypes = (
      await tx`DELETE FROM document_types WHERE tenant_id = ${tenantId}`
    ).count;
    const departments = (
      await tx`DELETE FROM departments WHERE tenant_id = ${tenantId}`
    ).count;
    const users = (await tx`DELETE FROM users WHERE tenant_id = ${tenantId}`).count;

    // --- Passo 3: soft-delete do tenant + rename para liberar índice único ---
    await tx`
      UPDATE tenants
         SET active = false,
             deleted = true,
             deleted_at = now(),
             name = '[EXCLUÍDA-' || extract(epoch from now())::bigint || '] ' || name
       WHERE id = ${tenantId}
         AND deleted = false
    `;

    return {
      chunks,
      documentContent,
      documents,
      departmentPermissions,
      documentTypeIndexFields,
      globalTypeTenantDepts,
      documentTypes,
      departments,
      users,
    };
  });

  // --- Passo 4: purga de storage (não-transacional) -------------------------
  const prefix = `tenants/${tenantId}/`;
  try {
    await deps.deleteS3Prefix(prefix);
  } catch (err) {
    // Falha de storage não reverte o banco — o conteúdo lógico já foi removido.
    // Logamos para reconciliação posterior.
    deps.logger.error({ err, tenantId, prefix }, 'falha ao purgar objetos de storage do tenant');
  }

  // --- Passo 5: registro de auditoria 'tenant.delete' -----------------------
  // user_id NULL (ação de plataforma); tenant_id preservado para rastreio.
  await sql`
    INSERT INTO audit_logs (tenant_id, user_id, action, resource, metadata)
    VALUES (
      ${tenantId},
      NULL,
      'tenant.delete',
      ${`tenants/${tenantId}`},
      ${sql.json({ counts })}
    )
  `;

  deps.logger.info({ tenantId, counts }, 'purga de tenant concluída');
}
