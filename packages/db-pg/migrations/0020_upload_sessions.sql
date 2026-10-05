-- Sessões de upload em partes (épico E-16 / ADR 0004 / T-172).
--
-- Registro desta migration criado por `drizzle-kit generate --custom` (o
-- repositório não guarda snapshots, então o `generate` comum recriaria o schema
-- inteiro). O DDL abaixo é o que o `drizzle-kit generate` produz para
-- `uploadSessions` de `src/schema.ts`, copiado sem edição de conteúdo.
--
-- Impacto: tabela NOVA e aditiva. Nenhuma tabela existente muda, nada precisa
-- ser reprocessado, nenhum dado é reescrito. Reversível com
-- `DROP TABLE upload_sessions` (perde só sessões em andamento/histórico de
-- sessões; os documentos criados por elas ficam em `documents`).
--
-- Decisões:
-- - Dado operacional, sem soft delete (`deleted`): a linha registra o desfecho
--   (`status` + `document_id`/`deduplicated`/`error_*`) e as partes em disco são
--   apagadas em qualquer desfecho.
-- - `status` validado por CHECK nomeado (mesmo padrão de texto + CHECK do
--   restante do schema, sem enum nativo do Postgres).
-- - FKs simples, ON DELETE NO ACTION: a purga de empresa apaga as sessões da
--   empresa explicitamente antes de `documents`/`departments`/`users`.
--
-- Índices:
-- - `upload_sessions_by_tenant_user_status`: toda rota lê a sessão filtrando
--   tenant + usuário.
-- - `upload_sessions_open_expires_at` (PARCIAL, status = 'OPEN'): varredura da
--   limpeza periódica de sessões vencidas; sessões encerradas não ocupam o índice.

CREATE TABLE "upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"document_type_id" uuid,
	"index_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"original_path" text,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"declared_size_bytes" bigint NOT NULL,
	"chunk_size_bytes" integer NOT NULL,
	"total_parts" integer NOT NULL,
	"received_parts" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"document_id" uuid,
	"deduplicated" boolean,
	"error_code" text,
	"error_message" text,
	"expires_at" timestamp with time zone NOT NULL,
	"completing_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_sessions_status_valid" CHECK ("upload_sessions"."status" IN ('OPEN', 'COMPLETING', 'COMPLETED', 'FAILED', 'ABORTED', 'EXPIRED'))
);
--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_document_type_id_document_types_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."document_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "upload_sessions_by_tenant_user_status" ON "upload_sessions" USING btree ("tenant_id","user_id","status");--> statement-breakpoint
CREATE INDEX "upload_sessions_open_expires_at" ON "upload_sessions" USING btree ("expires_at") WHERE status = 'OPEN';
