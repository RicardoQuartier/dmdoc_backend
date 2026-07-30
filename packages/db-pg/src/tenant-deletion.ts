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
   * Remove os objetos sob `prefix` em **TODOS os destinos de armazenamento que
   * esta empresa já usou** — não apenas no destino ativo (épico E-11 / T-142).
   *
   * Desde o storage por empresa, uma mesma empresa pode ter arquivos em mais de
   * um lugar ao mesmo tempo: migração parcial ou cancelada (parte no bucket
   * antigo, parte no novo) e migração concluída sem `cleanup-source` (a origem é
   * preservada de propósito, como cópia de segurança até o cliente validar).
   * Apagar só o destino corrente deixaria arquivo de cliente para trás,
   * indefinidamente e sem nenhum registro apontando para ele.
   *
   * ## O que este pacote entrega, e o que ele deliberadamente NÃO decide
   *
   * O contrato passa só `{ tenantId, prefix }`. A **lista de destinos não entra
   * aqui de propósito**: enumerá-los exige saber o que é um "lugar físico" —
   * endpoint + bucket no S3, site + drive + pasta raiz no SharePoint —, e
   * deduplicá-los exige comparar essa identidade **ignorando credenciais**
   * (rotação de chave cria uma configuração nova apontando para o MESMO bucket;
   * ver `storageLocationKey` em `apps/api/src/lib/storage-admin.ts`). Isso é
   * conhecimento de storage, e é exatamente o que este callback existe para
   * manter fora do `@dmdoc/db-pg`. Devolver uma lista de `tenant_storage_configs`
   * crua só empurraria a mesma decisão para o mesmo lugar, com menos informação.
   *
   * Quem implementa (o worker) levanta os destinos consultando, com o `tenantId`
   * recebido: TODAS as linhas de `tenant_storage_configs` do tenant (ativas e
   * aposentadas) mais o destino da plataforma quando existir documento com
   * `storage_config_id IS NULL` — as duas tabelas ainda estão intactas quando o
   * callback roda (ver "Ordem de execução" abaixo).
   *
   * Não-transacional: chamado FORA da transação de banco. Falhas são logadas,
   * mas não abortam a purga do PostgreSQL — e, dentro da implementação, a falha
   * em um destino não pode impedir a limpeza dos demais (uma credencial de
   * SharePoint revogada não pode blindar o bucket do MinIO).
   */
  deleteStoragePrefix: (target: { tenantId: string; prefix: string }) => Promise<void>;
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
  | 'users'
  | 'tenantStorageConfigs'
  | 'storageMigrations',
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
 * - **Nenhuma credencial de cliente sobrevive.** `tenant_storage_configs`
 *   (`encrypted_secret` = secret key da AWS ou client secret do Azure, DO
 *   CLIENTE) e `storage_migrations` também são purgadas. Item de segurança, não
 *   de limpeza: o tenant sofre soft-delete, então nenhuma FK obrigaria essas
 *   linhas a cair — o segredo ficaria no banco depois de a empresa ser excluída.
 * - **Idempotente.** Re-executar não quebra: todos os deletes são
 *   `WHERE tenant_id = $1` (afetam 0 linhas na segunda vez) e o soft-delete do
 *   tenant usa `AND deleted = false`.
 *
 * Ordem de execução:
 *
 * 1. Purga dos objetos no storage sob `tenants/{id}/`, em TODOS os destinos que
 *    a empresa já usou (FORA da transação; falha é logada e não aborta a purga
 *    do banco).
 * 2. Anular ponteiros nas tabelas preservadas (`document_events`, `audit_logs`).
 * 3. Hard-delete em cascata (filhos → pais), respeitando as FKs `NO ACTION`.
 * 4. Soft-delete do tenant + rename do `name` (libera o índice único de nome,
 *    mesmo padrão da anonimização de email em `users`).
 *    → Passos 2–4 rodam numa única transação (`sql.begin`).
 * 5. Registro de auditoria `tenant.delete`.
 *
 * ⚠️ **O storage vem ANTES do banco, e a inversão é deliberada (T-142).** Até o
 * E-11 a ordem era a inversa, e ela deixou de funcionar por dois motivos, cada
 * um suficiente sozinho:
 *
 * - **As credenciais moram no banco.** `tenant_storage_configs.encrypted_secret`
 *   é o que permite alcançar o bucket ou o SharePoint do cliente. Apagar a linha
 *   primeiro tornaria os arquivos inalcançáveis para sempre — purga que não
 *   purga. (A FK COMPOSTA `documents_storage_config_fk`, `ON DELETE NO ACTION`,
 *   já impede apagar a configuração antes dos documentos; ela não diz nada sobre
 *   os arquivos, que não estão no Postgres.)
 * - **O inventário de destinos mora no banco.** Saber se o acervo da plataforma
 *   entra na varredura é `EXISTS (SELECT 1 FROM documents WHERE tenant_id = $1
 *   AND storage_config_id IS NULL)` — sem filtro de `deleted`, a purga é física.
 *   Com os documentos já apagados, essa consulta responde `false` e o bucket da
 *   plataforma ficaria de fora justamente no caso mais comum.
 *
 * O que a inversão custa: se o banco falhar depois do storage, sobra uma janela
 * com os arquivos apagados e as linhas ainda de pé. É aceitável — a empresa já
 * foi soft-deletada e renomeada pela rota `DELETE /admin/tenants/:id` ANTES de o
 * job ser enfileirado (ninguém autentica nem a enxerga em listagem), e o retry
 * do BullMQ reexecuta tudo: apagar prefixo inexistente é no-op nos dois drivers.
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
  // --- Passo 1: purga de storage (não-transacional, ANTES do banco) ---------
  // Roda primeiro porque o callback precisa das credenciais (ainda em
  // `tenant_storage_configs`) e do inventário de destinos (ainda em
  // `documents`) — ver o bloco "⚠️ O storage vem ANTES do banco" acima.
  const prefix = `tenants/${tenantId}/`;
  try {
    await deps.deleteStoragePrefix({ tenantId, prefix });
  } catch (err) {
    // Falha de storage não impede a purga do banco — a exclusão da empresa foi
    // pedida e o conteúdo lógico tem de sair. Logamos para reconciliação.
    deps.logger.error({ err, tenantId, prefix }, 'falha ao purgar objetos de storage do tenant');
  }

  const counts = await sql.begin(async (tx): Promise<PurgeCounts> => {
    // --- Passo 2: anular ponteiros nas tabelas preservadas (auditoria) -------
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

    // --- Passo 3: hard-delete em cascata (filhos → pais) ---------------------
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

    // Destinos de armazenamento da empresa (E-11): TODAS as linhas, ativas e
    // aposentadas. É item de SEGURANÇA — `encrypted_secret` guarda a secret key
    // da AWS ou o client secret do Azure DO CLIENTE, e como o tenant só sofre
    // soft-delete nenhuma FK obrigaria essas linhas a cair: o segredo
    // sobreviveria à exclusão da empresa, sem dono e sem prazo.
    //
    // ⚠️ Só AGORA, depois de `documents` (acima) e depois do passo 1: a FK
    // COMPOSTA `documents_storage_config_fk` é `ON DELETE NO ACTION` e recusaria
    // o delete enquanto houvesse documento apontando para a configuração, e o
    // callback de storage precisa das credenciais que estão nestas linhas.
    const tenantStorageConfigs = (
      await tx`DELETE FROM tenant_storage_configs WHERE tenant_id = ${tenantId}`
    ).count;
    // Histórico de migrações de acervo: só metadado (contadores e rótulos), mas
    // é dado da empresa e não tem por que sobreviver a ela.
    const storageMigrations = (
      await tx`DELETE FROM storage_migrations WHERE tenant_id = ${tenantId}`
    ).count;

    // --- Passo 4: soft-delete do tenant + rename para liberar índice único ---
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
      tenantStorageConfigs,
      storageMigrations,
    };
  });

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
