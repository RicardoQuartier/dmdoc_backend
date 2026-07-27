# `@dmdoc/db-pg`

Schema Drizzle, migrations e repositórios de dados do DMDoc (PostgreSQL 16 + pgvector).

## Testes

Os testes deste pacote batem em **PostgreSQL real** (sem mock de banco) e rodam
serializados (`fileParallelism: false`), porque vários arquivos limpam tabelas
compartilhadas (`DELETE FROM tenants` sem `WHERE`).

```bash
# de /home/rpaggi/Work/inversu/dmdoc
docker compose exec -T api sh -lc 'cd /app && pnpm --filter @dmdoc/db-pg test'
```

**Não é mais necessário passar `-e TEST_DATABASE_URL=...`.** Quando a variável
não está definida, a URL base é derivada do `DATABASE_URL` do ambiente (dentro
do container, `postgresql://dmdoc:dmdoc@postgres:5432/dmdoc`) trocando apenas o
nome do banco. Passar `TEST_DATABASE_URL` continua funcionando e tem
precedência — ela precisa apontar para o banco `dmdoc_test`.

### Um banco por execução

Cada `vitest run` deste pacote **cria um banco próprio**, `dmdoc_test_<chave>`,
aplica todas as migrations nele e o **dropa no teardown**. O banco de
desenvolvimento (`dmdoc`) nunca é alcançado: o nome é sempre reescrito para
`dmdoc_test_*`.

Por que: o `globalSetup` precisa de schema limpo e completo, e fazia isso com
`migrate:fresh` (`DROP SCHEMA public CASCADE`) no banco `dmdoc_test`
**compartilhado com a suíte de `apps/api`**. Duas execuções sobrepostas se
destruíam mutuamente — a que chegava depois dropava o schema no meio da outra,
que passava a falhar com `relation "chunks" does not exist` em arquivos
aleatórios. Reproduzível de forma determinística disparando duas suítes com 1s
de defasagem. Com banco por execução não há estado compartilhado: rodar
`db-pg` e `api` ao mesmo tempo, ou dois `db-pg` em paralelo (CI com jobs
concorrentes), é seguro.

Detalhes de implementação em `src/test-database.ts` e `src/test-global-setup.ts`.
A suíte de `apps/api` **reusa esse mesmo mecanismo**: seu `vitest.config.ts`
chama `resolveTestRunDatabaseUrl` e seu `src/test/global-setup.ts` reexporta o
`setup` daqui — então qualquer combinação de execuções sobrepostas
(`api` × `api`, `api` × `db-pg`, `db-pg` × `db-pg`) é segura.

**Bancos órfãos:** se um run for morto (SIGKILL, job de CI cancelado), o
teardown não roda e o banco fica para trás. O run seguinte faz a coleta: um
`dmdoc_test_<chave>` só é dropado quando o advisory lock daquela chave pode ser
adquirido — locks morrem com a sessão, então bancos de execuções vivas nunca
são tocados.

## Banco de dados

```bash
# Aplica as migrations pendentes
docker compose exec -T api pnpm --filter @dmdoc/db-pg migrate

# Gera migration a partir do schema.ts
docker compose exec -T api pnpm --filter @dmdoc/db-pg generate

# Drop do schema + re-aplica tudo (SÓ dev/test — nunca homologação)
docker compose exec -T api pnpm --filter @dmdoc/db-pg migrate:fresh

# Dados de desenvolvimento (senha de seed: 123qwe)
docker compose exec -T api pnpm --filter @dmdoc/db-pg seed

# Trunca + re-seed, mantendo o schema
docker compose exec -T api pnpm --filter @dmdoc/db-pg db:fresh
```

Banco criado fora do drizzle-kit (sem histórico de migrations) precisa do
bootstrap uma vez antes do `migrate`:

```bash
docker compose exec -T api pnpm --filter @dmdoc/db-pg tsx src/bootstrap-migrations.ts
```

Migration aplicada é **imutável** — mudança nova é sempre um arquivo novo
numerado.
