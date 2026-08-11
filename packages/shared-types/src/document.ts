import { z } from 'zod';

/**
 * Status do processamento de um documento.
 *
 * Transições esperadas:
 *   PENDING → PROCESSING → READY
 *   PENDING → PROCESSING → FAILED
 *
 * Spec §5.3 (coleção `documents`, campo `status`).
 */
export const DocumentStatusSchema = z.enum(['PENDING', 'PROCESSING', 'READY', 'FAILED']);

export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

/**
 * Documento. Entidade central do sistema — representa um arquivo enviado por um
 * usuário de uma empresa.
 *
 * Invariantes:
 * - `(tenantId, contentHash)` é único (deduplicação por SHA-256 do arquivo).
 * - `documentTypeId` é nulo quando o usuário não classificou o documento ainda.
 * - `title` é o título de exibição CONFIRMADO/editado pelo usuário (Fase 8.1).
 *   Nulo até haver confirmação; enquanto nulo, listagens e telas exibem
 *   `originalFilename` como fallback. Independente de `originalFilename`.
 * - `suggestedTitle` é a sugestão BRUTA de título gerada pela IA — consultiva,
 *   nunca exibida como título oficial. Reprocessar sobrescreve `suggestedTitle`,
 *   mas NUNCA toca o `title` já confirmado. `originalFilename` permanece
 *   imutável (atrelado ao arquivo físico) e nenhuma sugestão de IA o substitui.
 * - `storageKey` é a chave do arquivo no destino de armazenamento da empresa e
 *   é OPACA: só o driver de storage resolvido para o tenant sabe interpretá-la
 *   (objeto em bucket S3, item no SharePoint etc.). Nenhuma camada acima pode
 *   assumir que ela é uma chave S3 nem derivar URL a partir dela.
 * - `mongoContentId` aponta para o `_id` do documento na coleção
 *   `document_content` — preenchido após a extração de texto pelo worker.
 * - `indexValues` é um mapa aberto: chaves correspondem ao `name` dos campos
 *   de índice do `DocumentType` associado.
 * - `processedAt` é nulo enquanto o documento ainda não saiu do estado PENDING.
 * - `costUsdCents` acumula o custo de embeddings + LLM em centavos de dólar.
 *
 * Segue exclusão lógica (`deleted`). Spec §5.3 (coleção `documents`).
 */
export const DocumentSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  departmentId: z.string().uuid(),
  documentTypeId: z.string().uuid().nullable(),
  filename: z.string().min(1).max(500),
  originalFilename: z.string().min(1).max(500),
  // Path relativo do arquivo dentro da pasta enviada (`webkitRelativePath` do
  // browser) — só preenchido quando o upload veio de seleção/arrasto de
  // PASTA. Nulo em upload de arquivo avulso; nunca inventado. Ver
  // `packages/db-pg/src/schema.ts` (coluna `original_path`).
  originalPath: z.string().nullable(),
  title: z.string().nullable(),
  suggestedTitle: z.string().nullable(),
  contentHash: z.string().length(64), // SHA-256 hex
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string().min(1).max(200),
  storageKey: z.string().min(1).max(1000),
  status: DocumentStatusSchema,
  failureReason: z.string().nullable(),
  tags: z.array(z.string()),
  mongoContentId: z.string().nullable(), // ObjectId hex do document_content
  indexValues: z.record(z.union([z.string(), z.number(), z.date(), z.null()])),
  uploadedById: z.string().uuid(),
  uploadedAt: z.date(),
  processedAt: z.date().nullable(),
  costUsdCents: z.number().int().nonnegative(),
  deleted: z.boolean(),
});

export type Document = z.infer<typeof DocumentSchema>;

/**
 * Body de `PATCH /documents/:id/move` — troca o departamento de um documento já
 * enviado.
 *
 * Por que uma rota própria em vez de um campo no `PATCH /documents/:id`: mover
 * é uma mudança ESTRUTURAL com efeito em ACL. A busca lexical/vetorial/híbrida
 * filtra acesso por `chunks.department_id` (coluna denormalizada), não por
 * `documents.department_id` — então o move precisa atualizar as duas tabelas na
 * MESMA transação, sob pena de vazar conteúdo para quem perdeu o acesso. O
 * PATCH comum roda fora de transação e ainda dispara uma chamada de LLM no
 * meio, o que abriria exatamente essa janela.
 *
 * `departmentId` é sempre um uuid de departamento ATIVO do mesmo tenant — a
 * rota valida existência, tenant e `deleted = false` além da ACL.
 *
 * Não é `.strict()`, pela mesma razão de `MoveDepartmentBodySchema`: campos
 * extras enviados pelo cliente são descartados em silêncio, sem quebrar o front.
 */
export const MoveDocumentBodySchema = z.object({
  departmentId: z.string().uuid(),
});

export type MoveDocumentBody = z.infer<typeof MoveDocumentBodySchema>;

/**
 * Teto de documentos por operação de move em massa.
 *
 * Deliberadamente MENOR que os demais `BULK_*_MAX` da API (500): mover exige um
 * `UPDATE` em `chunks`, e cada linha de chunk carrega um `vector(1536)` (~6 KB).
 * Como `department_id` é indexado (`chunks_by_tenant_department` e o GIN
 * `chunks_fts_tenant_gin`), o HOT update é impossível — cada linha atualizada
 * gera nova entrada no HNSW e no GIN. 100 documentos já são ~5 mil chunks
 * reescritos numa única transação; 500 seriam ~150 MB de WAL.
 */
export const BULK_MOVE_MAX = 100;

/**
 * Body de `POST /documents/bulk-move` — move vários documentos para um mesmo
 * departamento de destino, numa única transação.
 *
 * Semântica all-or-nothing: se qualquer id estiver fora do escopo do ator ou
 * faltar ACL em algum departamento envolvido, nada é escrito (404).
 */
export const BulkMoveDocumentsBodySchema = z.object({
  documentIds: z.array(z.string().uuid()).min(1).max(BULK_MOVE_MAX),
  departmentId: z.string().uuid(),
});

export type BulkMoveDocumentsBody = z.infer<typeof BulkMoveDocumentsBodySchema>;
