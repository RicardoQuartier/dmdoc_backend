/**
 * globalSetup do Vitest para a suíte de `apps/api`.
 *
 * Roda UMA vez, antes de qualquer arquivo de teste, e dá a esta execução um
 * banco EXCLUSIVO — `dmdoc_test_<chave>` — criado do zero e migrado com todas
 * as migrations (schema limpo e COMPLETO, sem depender de um `dmdoc_test`
 * compartilhado ficar para trás em relação ao repositório). No teardown o banco
 * é dropado.
 *
 * ## Por que delega para `@dmdoc/db-pg`
 *
 * O mecanismo é exatamente o mesmo já usado pela suíte de `@dmdoc/db-pg`
 * (advisory lock como marca de "execução viva", `CREATE DATABASE`,
 * `applyMigrations`, teardown com `DROP DATABASE ... WITH (FORCE)` e coleta de
 * bancos órfãos de runs mortos). Duplicá-lo aqui só criaria duas
 * implementações para manter em sincronia — reusamos a de lá, importada por
 * caminho relativo porque é infraestrutura de teste, fora do `index.ts` público
 * do pacote.
 *
 * ## O defeito que isso corrige
 *
 * Antes, este setup chamava `migrateFresh()` (`DROP SCHEMA public CASCADE`) no
 * `dmdoc_test` compartilhado. Duas execuções sobrepostas se destruíam: a
 * segunda dropava o schema no meio da primeira, que passava a falhar com
 * `relation "tenants" does not exist` em arquivos aleatórios — sintoma que
 * parece bug do código sob teste. Com um banco por execução, rodar duas suítes
 * de `apps/api` ao mesmo tempo (ou `apps/api` junto de `db-pg`) é seguro.
 *
 * ## Segurança
 *
 * O banco de desenvolvimento `dmdoc` é inalcançável por construção: o nome do
 * banco é sempre reescrito para `dmdoc_test_<chave>` e uma `TEST_DATABASE_URL`
 * que aponte para outro banco falha na carga do `vitest.config.ts`, antes de
 * qualquer conexão. Ver `packages/db-pg/src/test-database.ts`.
 */
export { setup } from '../../../../packages/db-pg/src/test-global-setup.js';
