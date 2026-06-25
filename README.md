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

---

### MongoDB (`@dmdoc/db-mongo`)

#### Índices

Os índices MongoDB **não estão nas migrations** — precisam ser criados separadamente após o primeiro deploy ou migrate:fresh.

```bash
# Cria todos os índices (regulares + Atlas Search + Vector Search) — recomendado
pnpm --filter @dmdoc/db-mongo setup-indexes

# Apenas índices regulares (compound, unique, etc.)
pnpm --filter @dmdoc/db-mongo create-indexes

# Apenas Atlas Search (lexical) e Vector Search (embeddings)
pnpm --filter @dmdoc/db-mongo create-atlas-indexes
```

> Todos os comandos são idempotentes — podem ser rodados múltiplas vezes sem efeito colateral.

> Em produção passe `MONGO_URI` explicitamente:
> ```bash
> MONGO_URI="mongodb+srv://..." pnpm --filter @dmdoc/db-mongo setup-indexes
> ```

#### Seed e reset

```bash
# Popula o banco com dados iniciais de desenvolvimento
pnpm --filter @dmdoc/db-mongo seed

# Apaga todas as coleções e recria (equivalente ao db:fresh da raiz)
pnpm --filter @dmdoc/db-mongo db:fresh
```

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

### `@dmdoc/db-mongo`

```bash
pnpm --filter @dmdoc/db-mongo build      # compila para dist/
pnpm --filter @dmdoc/db-mongo typecheck  # verificação de tipos
pnpm --filter @dmdoc/db-mongo lint       # ESLint
pnpm --filter @dmdoc/db-mongo test       # testes (Vitest)
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
| `MONGO_URI` | `mongodb://localhost:27017` | Connection string MongoDB |
| `MONGO_DB` | `dmdoc` | Nome do banco |
| `REDIS_URL` | `redis://localhost:5052` | URL do Redis (BullMQ) |
| `AWS_S3_BUCKET` | `dmdoc-documents` | Bucket S3/MinIO |
| `S3_ENDPOINT` | `http://localhost:5054` | Endpoint MinIO local |
| `EXTRACTOR` | `python` | Motor de extração (`python`) |
| `EXTRACTOR_URL` | `http://localhost:5056/extract` | URL do microserviço extractor |
| `LLM_PROVIDER` | `openrouter` | Provedor LLM (`openai` ou `openrouter`) |
| `OPENAI_API_KEY` | — | Chave OpenAI (embeddings) |
