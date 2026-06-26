# Dockerfile de produção/homologação do backend DMDoc (monorepo pnpm).
#
# Multi-stage com targets dedicados que compartilham UM único build do monorepo
# (evita 3× pnpm install). Selecione o alvo no compose via `build.target`:
#   - api      → roda a API Fastify (node dist/server.js)
#   - worker   → roda o worker BullMQ (node dist/worker.js)
#   - migrate  → one-shot: aplica as migrations drizzle e sai
#
# Diferente do compose de DEV (que usa `pnpm dev` com tsx watch + bind mount),
# aqui o código é BUILDADO (tsc) e roda com `pnpm start` (node dist/...).
#
# syntax=docker/dockerfile:1

# ---------- build: instala deps e compila todo o monorepo ----------
FROM node:22-slim AS builder
WORKDIR /app
RUN corepack enable
COPY . .
# `mongodb-memory-server` é devDependency usada só em testes (pacote legado
# @dmdoc/db-mongo, da migração Mongo→Postgres). Seu postinstall baixaria ~82MB
# do binário do MongoDB, que a imagem nunca usa — desligamos esse download.
RUN MONGOMS_DISABLE_POSTINSTALL=1 pnpm install --frozen-lockfile
RUN pnpm --filter @dmdoc/shared-types build \
 && pnpm --filter @dmdoc/extractor build \
 && pnpm --filter @dmdoc/logger build \
 && pnpm --filter @dmdoc/llm-provider build \
 && pnpm --filter @dmdoc/db-pg build \
 && pnpm --filter @dmdoc/db-mongo build \
 && pnpm --filter @dmdoc/worker build

# ---------- api: Fastify API ----------
# A API tem `noEmit: true` no tsconfig (nunca compila para dist) — o projeto a executa
# via tsx, que resolve os aliases @dmdoc/* pelos paths do tsconfig. Aqui rodamos tsx
# SEM watch (produção), diferente do `tsx watch` do compose de dev.
FROM builder AS api
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@dmdoc/api", "exec", "tsx", "src/server.ts"]

# ---------- worker: processamento BullMQ ----------
FROM builder AS worker
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@dmdoc/worker", "start"]

# ---------- migrate: aplica migrations drizzle (one-shot) ----------
# Mantém as devDependencies do builder (drizzle-kit) + drizzle.config.ts + migrations/.
FROM builder AS migrate
CMD ["pnpm", "--filter", "@dmdoc/db-pg", "migrate"]
