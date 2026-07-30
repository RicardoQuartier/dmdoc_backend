# dmdoc-backend

Monorepo Node.js/TypeScript do backend do DMDoc — Fastify API + BullMQ worker + pacotes compartilhados.

## Pré-requisitos

- Node.js >= 22
- pnpm >= 9

## Setup inicial

```bash
pnpm install
```

## Comandos raiz

Executados na raiz do monorepo (`dmdoc_backend/`).

| Comando | Descrição |
|---|---|
| `pnpm dev` | Inicia API e worker em paralelo com hot-reload |
| `pnpm build` | Compila todos os pacotes |
| `pnpm typecheck` | Verificação de tipos em todos os pacotes |
| `pnpm lint` | ESLint em todos os pacotes (falha em warnings) |
| `pnpm lint:fix` | ESLint com correção automática |
| `pnpm format` | Prettier — formata todos os arquivos |
| `pnpm format:check` | Prettier — verifica formatação sem alterar |
| `pnpm test` | Roda todos os testes |
| `pnpm db:fresh` | Apaga e recria o banco de dados de desenvolvimento |

## Banco de dados

### PostgreSQL (`@dmdoc/db-pg`)

#### Migrations

```bash
# Aplica todas as migrations pendentes
pnpm --filter db-pg migrate

# Drop completo do schema + re-aplica migrations do zero (apenas dev)
pnpm --filter db-pg migrate:fresh
```

> **Banco criado fora do drizzle-kit** (sem histórico de migrations): rode o bootstrap uma vez antes do `migrate`.
> ```bash
> pnpm --filter db-pg tsx src/bootstrap-migrations.ts
> ```

#### Seed e reset

```bash
# Popula com dados iniciais de desenvolvimento
pnpm --filter db-pg seed

# Trunca todas as tabelas e re-popula com seed (mantém schema)
pnpm --filter db-pg db:fresh
```

#### Testes

```bash
pnpm --filter @dmdoc/db-pg test
```

Batem em PostgreSQL real. Cada execução cria e dropa um banco próprio
(`dmdoc_test_<chave>`), então duas suítes concorrentes não se atrapalham e
**não é preciso passar `TEST_DATABASE_URL`** — ver `packages/db-pg/README.md`.

> **Não existe mais `@dmdoc/db-mongo`.** O projeto migrou de MongoDB Atlas para
> PostgreSQL 16 + pgvector: os índices lexical (GIN sobre `tsvector`) e vetorial
> (HNSW do `pgvector`) são criados **pelas migrations**, e não por um passo
> separado como no Atlas. Tudo de banco está em `@dmdoc/db-pg`.

## Apps

### API (`@dmdoc/api`)

```bash
pnpm --filter @dmdoc/api dev        # dev com hot-reload (tsx watch)
pnpm --filter @dmdoc/api build      # compila para dist/
pnpm --filter @dmdoc/api start      # inicia a build compilada
pnpm --filter @dmdoc/api typecheck  # verificação de tipos
pnpm --filter @dmdoc/api lint       # ESLint
pnpm --filter @dmdoc/api test       # testes (Vitest)
```

Os testes batem em PostgreSQL real. Cada execução **cria e dropa um banco
próprio** (`dmdoc_test_<chave>`) — duas suítes concorrentes não se atrapalham e
**não é preciso passar `TEST_DATABASE_URL`**: a URL base é derivada do
`DATABASE_URL` do ambiente, trocando só o nome do banco. Mesmo mecanismo do
`@dmdoc/db-pg` — detalhes em `packages/db-pg/README.md`.

### Worker (`@dmdoc/worker`)

```bash
pnpm --filter @dmdoc/worker dev        # dev com hot-reload (tsx watch)
pnpm --filter @dmdoc/worker build      # compila para dist/
pnpm --filter @dmdoc/worker start      # inicia a build compilada
pnpm --filter @dmdoc/worker typecheck  # verificação de tipos
pnpm --filter @dmdoc/worker lint       # ESLint
pnpm --filter @dmdoc/worker test       # testes (Vitest)
```

## Pacotes

Os apps resolvem os pacotes pelo `dist/`. Depois de editar o `src/` de qualquer
`packages/*`, rode o `build` do pacote e reinicie api/worker — sem isso o runtime
continua executando a versão anterior. A ordem de build é
`shared-types` → `extractor` → `logger` → `llm-provider` → `db-pg` (serviço
`backend-install` do `docker-compose.yml` da raiz).

### `@dmdoc/db-pg`

```bash
pnpm --filter @dmdoc/db-pg build      # compila para dist/
pnpm --filter @dmdoc/db-pg typecheck  # verificação de tipos
pnpm --filter @dmdoc/db-pg lint       # ESLint
pnpm --filter @dmdoc/db-pg test       # testes (Vitest, PostgreSQL real)
```

### `@dmdoc/storage`

Armazenamento de arquivos por empresa: interface `StorageDriver`, driver S3
(AWS/R2/MinIO), driver SharePoint (Microsoft Graph, app-only), cripto
AES-256-GCM do segredo e resolução do destino por documento. Ver spec §6.3.

```bash
pnpm --filter @dmdoc/storage build      # compila para dist/
pnpm --filter @dmdoc/storage typecheck  # verificação de tipos
pnpm --filter @dmdoc/storage lint       # ESLint
pnpm --filter @dmdoc/storage test       # testes (Vitest, com mocks de HTTP/SDK)
```

### `@dmdoc/extractor`

```bash
pnpm --filter @dmdoc/extractor build      # compila para dist/
pnpm --filter @dmdoc/extractor dev        # compila em modo watch
pnpm --filter @dmdoc/extractor typecheck  # verificação de tipos
pnpm --filter @dmdoc/extractor lint       # ESLint
pnpm --filter @dmdoc/extractor test       # testes (Vitest)
```

### `@dmdoc/llm-provider`

```bash
pnpm --filter @dmdoc/llm-provider build      # compila para dist/
pnpm --filter @dmdoc/llm-provider dev        # compila em modo watch
pnpm --filter @dmdoc/llm-provider typecheck  # verificação de tipos
pnpm --filter @dmdoc/llm-provider lint       # ESLint
pnpm --filter @dmdoc/llm-provider test       # testes (Vitest)
```

### `@dmdoc/shared-types`

```bash
pnpm --filter @dmdoc/shared-types build      # compila para dist/
pnpm --filter @dmdoc/shared-types typecheck  # verificação de tipos
pnpm --filter @dmdoc/shared-types lint       # ESLint
pnpm --filter @dmdoc/shared-types test       # testes (Vitest)
```

## Variáveis de ambiente

Copie `.env.example` para `.env` e ajuste os valores:

```bash
cp .env.example .env
```

Principais variáveis:

| Variável | Padrão dev | Descrição |
|---|---|---|
| `DATABASE_URL` | `postgresql://dmdoc:dmdoc@localhost:5432/dmdoc` | Connection string PostgreSQL |
| `REDIS_URL` | `redis://localhost:5052` | URL do Redis (BullMQ) |
| `AWS_S3_BUCKET` | `dmdoc-documents` | Bucket S3/MinIO **da plataforma** (destino default) |
| `S3_ENDPOINT` | `http://minio:9000` | Endpoint interno do MinIO |
| `S3_PUBLIC_ENDPOINT` | `http://localhost:5054` | Endpoint publicado, usado só ao assinar URL para o navegador |
| `STORAGE_SECRET_KEY` | — | **Obrigatória** (api e worker). 32 bytes hex (`openssl rand -hex 32`) que cifram o segredo de storage de cada empresa. Trocá-la torna ilegível todo segredo já cifrado |
| `EXTRACT_URL_TTL_SECS` | `1800` | Validade da URL temporária entregue ao extractor |
| `EXTRACTOR` | `python` | Motor de extração (`python`) |
| `EXTRACTOR_URL` | `http://localhost:5056/extract` | URL do microserviço extractor |
| `LLM_PROVIDER` | `openrouter` | Provedor LLM (`openai` ou `openrouter`) |
| `OPENAI_API_KEY` | — | Chave OpenAI (embeddings) |
