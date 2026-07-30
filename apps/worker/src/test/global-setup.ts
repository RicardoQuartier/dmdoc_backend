/**
 * globalSetup do Vitest para a suíte de `apps/worker`.
 *
 * Roda UMA vez, antes de qualquer arquivo, e dá a esta execução um banco
 * EXCLUSIVO — `dmdoc_test_<chave>` — criado do zero, migrado e dropado no
 * teardown. É o mesmo mecanismo já usado por `@dmdoc/db-pg` e por `apps/api`;
 * reusar (em vez de reimplementar) mantém uma única definição de como um banco
 * de teste nasce e morre.
 *
 * ## Por que o worker passou a precisar de banco
 *
 * A migração de acervo (E-11 / T-141) é, na sua parte mais perigosa, uma
 * CONSULTA: `storage_config_id IS DISTINCT FROM <destino>`. Um dublê de `Sql`
 * responderia o que o teste mandasse responder e provaria exatamente nada —
 * inclusive o modo de falha que a ADR-1 corrigiu (seleção vazia com aparência de
 * sucesso) passaria verde num mock. Só o PostgreSQL de verdade distingue
 * `IS DISTINCT FROM` de `<>` na presença de `NULL`.
 *
 * Os testes que não tocam o banco (pipeline, chunking, embeddings) continuam
 * como estavam: nenhum deles abre conexão, só pagam o custo do setup uma vez.
 */
export { setup } from '../../../../packages/db-pg/src/test-global-setup.js';
