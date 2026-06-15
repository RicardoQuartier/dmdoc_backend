import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { MultipartFile } from '@fastify/multipart';
import {
  TenantRepository,
  DocumentEventsRepository,
  DOCUMENT_EVENTS_COLLECTION,
  newId,
  normalizeLimit,
} from '@dmdoc/db-mongo';
import type { TenantDocument } from '@dmdoc/db-mongo';
import type { DocumentProcessingJobData, DocumentEvent, CreateDocumentEventInput } from '@dmdoc/shared-types';
import { DocumentProcessingJobDataSchema } from '@dmdoc/shared-types';
import { NotFoundError, QuotaExceededError } from '../errors/index.js';
import { requireRole } from '../auth/role-guard.js';
import { AuditLogger } from '../auth/audit.js';
import { resolveTenantContext } from '../auth/resolve-tenant.js';
import { resolveAccessibleDepartmentIds } from '../auth/department-access.js';
import { getConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Tipos locais que mapeiam as coleções do MongoDB (spec §5.3)
// ---------------------------------------------------------------------------

interface TenantMongoDoc {
  id: string;
  name: string;
  diskQuotaBytes: number;
  userQuota: number;
  active: boolean;
  createdAt: Date;
}

interface DocumentTypeDoc extends TenantDocument {
  name: string;
  description: string | null;
  isGlobal: boolean;
  indexFields: unknown[];
  createdAt: Date;
}

interface DocumentDoc extends TenantDocument {
  departmentId: string;
  documentTypeId: string | null;
  filename: string;
  originalFilename: string;
  contentHash: string;
  sizeBytes: number;
  mimeType: string;
  s3Key: string;
  status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';
  failureReason: string | null;
  tags: string[];
  mongoContentId: string | null;
  indexValues: Record<string, string | number | Date | null>;
  uploadedById: string;
  uploadedAt: Date;
  processedAt: Date | null;
  costUsdCents: number;
}

interface IndexFieldDoc {
  id: string;
  name: string;
  fieldType: 'TEXT' | 'DATE' | 'NUMBER';
  required: boolean;
  aiExtractionHint: string | null;
  order: number;
  showOnSearch: boolean;
  deleted: boolean;
}

// ---------------------------------------------------------------------------
// Schemas para novas rotas
// ---------------------------------------------------------------------------

/** Schema dos query params do GET /documents. */
const ListDocumentsQuerySchema = z.object({
  tenantId: z.string().uuid().optional(), // SUPER_ADMIN apenas — filtrar por tenant específico
  departmentId: z.string().uuid().optional(),
  documentTypeId: z.string().uuid().optional(),
  tags: z.string().optional(), // CSV de tags
  status: z.enum(['PENDING', 'PROCESSING', 'READY', 'FAILED']).optional(),
  cursor: z.string().optional(),
  limit: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? parseInt(v, 10) : 20))
    .pipe(z.number().min(1).max(100)),
});

/** Schema do body do PATCH /documents/:id. */
const PatchDocumentBodySchema = z.object({
  documentTypeId: z.string().uuid().nullable().optional(),
  indexValues: z.record(z.union([z.string(), z.number(), z.null()])).optional(),
  tags: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

/**
 * Lê todos os bytes de um Readable em um único Buffer.
 * Necessário para calcular o sha256 e enviar ao S3.
 */
async function streamToBuffer(readable: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

/**
 * Calcula o hash SHA-256 de um buffer como string hexadecimal (64 chars).
 */
function sha256hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Sanitiza o nome original do arquivo para uso seguro como chave S3.
 * Remove caracteres especiais e preserva a extensão.
 */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

/**
 * Busca um documento pelo seu id sem filtrar por tenantId.
 *
 * Usado exclusivamente para SUPER_ADMIN, que não tem um tenantId no JWT e
 * precisa abrir qualquer documento diretamente (ex: a partir dos resultados
 * de busca). O tenant é resolvido a partir do próprio documento encontrado —
 * os checks de permissão subsequentes usam esse tenantId.
 *
 * Retorna null se o documento não existir ou estiver soft-deleted.
 */
async function findDocumentGlobally(
  db: import('mongodb').Db,
  id: string
): Promise<DocumentDoc | null> {
  const raw = await db
    .collection<DocumentDoc>('documents')
    .findOne({ id, deleted: false });
  if (!raw) return null;
  const { _id: _ignored, ...doc } = raw;
  return doc as DocumentDoc;
}

/**
 * Busca um documento pelo seu id restrito a uma lista de tenants permitidos.
 *
 * Usado exclusivamente para MULTI_TENANT_ADMIN em leitura sem tenantId explícito.
 * O filtro `tenantId: { $in: allowedTenantIds }` garante que o MTA só acessa
 * documentos de empresas da sua lista — nunca de empresas externas.
 *
 * Retorna null se o documento não existir, estiver soft-deleted ou o tenantId
 * do documento não estiver na lista (tratado como inexistente — spec §10, inv. 4).
 */
async function findDocumentInTenants(
  db: import('mongodb').Db,
  id: string,
  allowedTenantIds: string[]
): Promise<DocumentDoc | null> {
  const raw = await db
    .collection<DocumentDoc>('documents')
    .findOne({ id, tenantId: { $in: allowedTenantIds }, deleted: false });
  if (!raw) return null;
  const { _id: _ignored, ...doc } = raw;
  return doc as DocumentDoc;
}

/**
 * Valida se o usuário pode LER um departamento específico.
 *
 * Modelo de ACL por raiz com herança dinâmica (Fase 6): o usuário tem acesso a
 * um departamento quando ele pertence à subárvore de alguma raiz concedida. A
 * checagem de acesso (leitura == escrita) usa o set expandido de
 * `resolveAccessibleDepartmentIds`.
 *
 * - TENANT_ADMIN / SUPER_ADMIN / MULTI_TENANT_ADMIN: sempre permitido (desde
 *   que o dept exista no tenant). Para MTA o isolamento já foi feito ao buscar
 *   o documento com `findDocumentInTenants` — o tenantId aqui é o do documento.
 * - UPLOADER / USER: o departamento deve pertencer ao set expandido.
 *
 * IMPORTANTE: o departamento NÃO é filtrado por `deleted: false`. A exclusão de
 * departamento preserva os documentos vinculados (eles seguem `deleted: false`),
 * apenas o próprio departamento vira `deleted: true`. Portanto, admins precisam
 * conseguir ler documentos órfãos cujo departamento foi soft-deletado — basta
 * que o departamento exista (e pertença ao tenant, quando aplicável).
 *
 * Lança `NotFoundError` se sem permissão (spec §10, invariante 4 — nunca 403).
 */
async function assertCanReadDepartment(
  db: import('mongodb').Db,
  userId: string,
  tenantId: string | null,
  departmentId: string,
  role: string
): Promise<void> {
  const accessible = await resolveAccessibleDepartmentIds(db, userId, tenantId, role);
  if (accessible === null) {
    // Admin sem restrição de ACL: aceita qualquer departamento existente.
    // Sem `deleted: false`: departamento soft-deletado ainda dá acesso aos docs preservados.
    const deptFilter: Record<string, unknown> = { id: departmentId };
    if (tenantId !== null) {
      deptFilter['tenantId'] = tenantId;
    }
    const dept = await db.collection('departments').findOne(deptFilter);
    if (!dept) {
      throw new NotFoundError('Departamento não encontrado');
    }
    return;
  }
  if (!accessible.includes(departmentId)) {
    throw new NotFoundError('Departamento não encontrado ou sem permissão de leitura');
  }
}

/**
 * Valida se o usuário pode ESCREVER em um departamento específico.
 *
 * Modelo de ACL por raiz com herança dinâmica (Fase 6): conceder uma raiz dá
 * acesso total (leitura == escrita) a toda a subárvore. O departamento é
 * gravável quando pertence ao set expandido de `resolveAccessibleDepartmentIds`.
 *
 * IMPORTANTE: o departamento NÃO é filtrado por `deleted: false`. Como a exclusão
 * de departamento preserva os documentos (eles seguem `deleted: false`), admins
 * precisam conseguir editar/excluir/reprocessar documentos órfãos cujo departamento
 * foi soft-deletado. O isolamento por `tenantId` continua sendo aplicado.
 *
 * Lança `NotFoundError` se sem permissão.
 */
async function assertCanWriteDepartment(
  db: import('mongodb').Db,
  userId: string,
  tenantId: string,
  departmentId: string,
  role: string
): Promise<void> {
  const accessible = await resolveAccessibleDepartmentIds(db, userId, tenantId, role);
  if (accessible === null) {
    // Admin sem restrição de ACL: verifica apenas que o dept pertence ao tenant.
    // Sem `deleted: false`: departamento soft-deletado ainda permite operar nos docs preservados.
    const dept = await db
      .collection('departments')
      .findOne({ id: departmentId, tenantId });
    if (!dept) {
      throw new NotFoundError('Departamento não encontrado');
    }
    return;
  }
  if (!accessible.includes(departmentId)) {
    throw new NotFoundError('Departamento não encontrado ou sem permissão de escrita');
  }
}

/**
 * Valida os valores de `indexValues` contra os `indexFields` do tipo de documento.
 *
 * Regras por fieldType (spec §5.3 + wiki "Tipos de índice"):
 *   - TEXT: string não vazia, máx 500 chars
 *   - DATE: string no formato ISO 8601 (date-only ou datetime)
 *   - NUMBER: parseável como float finito
 *
 * Retorna lista de erros (vazia = válido). Também verifica campos `required`
 * não fornecidos.
 */
function validateIndexValues(
  indexValues: Record<string, string | number | null>,
  indexFields: IndexFieldDoc[]
): string[] {
  const activeFields = indexFields.filter((f) => !f.deleted);
  const errors: string[] = [];

  for (const field of activeFields) {
    const value = indexValues[field.name];

    // Campo obrigatório ausente ou nulo
    if (field.required && (value === undefined || value === null || value === '')) {
      errors.push(`Campo obrigatório ausente: "${field.name}"`);
      continue;
    }

    // Pular validação de tipo para campos opcionais não fornecidos
    if (value === undefined || value === null) {
      continue;
    }

    switch (field.fieldType) {
      case 'TEXT': {
        if (typeof value !== 'string' || value.trim() === '') {
          errors.push(`Campo "${field.name}" deve ser texto não vazio`);
        } else if (value.length > 500) {
          errors.push(`Campo "${field.name}" excede 500 caracteres`);
        }
        break;
      }
      case 'DATE': {
        const dateStr = String(value);
        // ISO 8601: aceita YYYY-MM-DD ou YYYY-MM-DDTHH:mm:ss...
        if (!/^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/.test(dateStr) || isNaN(Date.parse(dateStr))) {
          errors.push(`Campo "${field.name}" deve ser uma data válida no formato ISO 8601`);
        }
        break;
      }
      case 'NUMBER': {
        const num = typeof value === 'number' ? value : parseFloat(String(value));
        if (!isFinite(num)) {
          errors.push(`Campo "${field.name}" deve ser um número válido`);
        }
        break;
      }
    }
  }

  return errors;
}

/**
 * Resolve o `name` de um tipo de documento (tenant OU global) para denormalizar
 * no evento de upload. Retorna `null` se o tipo não for informado ou não existir
 * (o evento congela o que era conhecido no momento — não falha por isso).
 *
 * Não filtra por `deleted` no caminho global por consistência com a validação
 * de tipo do upload; um tipo soft-deletado ainda rende o nome para o relatório.
 */
async function resolveDocumentTypeName(
  db: import('mongodb').Db,
  tenantId: string,
  documentTypeId: string | null
): Promise<string | null> {
  if (documentTypeId === null) {
    return null;
  }
  const docType = await db
    .collection<{ name?: string }>('document_types')
    .findOne(
      { id: documentTypeId, $or: [{ tenantId }, { isGlobal: true }] },
      { projection: { name: 1 } }
    );
  return typeof docType?.name === 'string' ? docType.name : null;
}

/**
 * Emite um evento de upload na coleção append-only `document_events`.
 *
 * Falha de emissão NUNCA derruba a operação de upload (mesmo padrão do
 * AuditLog): em erro, loga com Pino (tenantId/documentId/userId) e segue. Mas
 * loga como ERRO — perder um evento distorce o relatório de cobrança.
 */
async function emitUploadEvent(
  db: import('mongodb').Db,
  log: FastifyBaseLogger,
  tenantId: string,
  input: CreateDocumentEventInput
): Promise<void> {
  try {
    const eventsRepo = new DocumentEventsRepository(
      db.collection<DocumentEvent>(DOCUMENT_EVENTS_COLLECTION),
      { tenantId }
    );
    await eventsRepo.insertOne(input);
  } catch (eventError) {
    log.error(
      {
        err: eventError,
        tenantId,
        documentId: input.documentId,
        userId: input.uploadedById,
        deduplicated: input.deduplicated,
      },
      'falha ao emitir evento de upload (document_events)'
    );
  }
}

// ---------------------------------------------------------------------------
// Plugin de rotas
// ---------------------------------------------------------------------------

/**
 * Rotas de documentos — Fase 3.
 *
 * `POST /documents` — upload multipart com:
 *   - validação de permissão de escrita no departamento
 *   - verificação de cota de disco do tenant
 *   - deduplicação por sha256 (retorna existente com 200 + X-Deduplicated)
 *   - validação opcional de documentTypeId (tenant ou global)
 *   - upload para S3
 *   - persistência no MongoDB com status PENDING
 *   - enfileiramento de job BullMQ
 *   - AuditLog de upload
 *
 * Necessita de `app.decorate('s3', ...)` e `app.decorate('queue', ...)` antes
 * de ser registrado (feito em `app.ts`).
 */
export const documentsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /documents — upload multipart de documento.
   *
   * Campos do formulário (multipart/form-data):
   *   - file           (Part — binário, obrigatório)
   *   - departmentId   (field — uuid, obrigatório)
   *   - documentTypeId (field — uuid, opcional)
   *   - indexValues    (field — JSON string opcional, mapa campo→valor)
   */
  app.post('/documents', { preHandler: app.authenticate }, async (request, reply) => {
    // TENANT_ADMIN e UPLOADER operam no tenant do JWT.
    // MULTI_TENANT_ADMIN envia tenantId explícito no form — validado abaixo.
    requireRole(request, 'TENANT_ADMIN', 'UPLOADER', 'MULTI_TENANT_ADMIN');

    const userId = request.user!.sub;
    const db = app.db;

    // ------------------------------------------------------------------
    // 1. Parse multipart — lê todas as partes independente da ordem
    //    request.file() só expõe fields que vêm ANTES do arquivo no stream,
    //    então usamos request.parts() e bufferizamos o arquivo dentro do loop
    //    para que campos posteriores ao arquivo também sejam lidos.
    // ------------------------------------------------------------------
    const textFields: Record<string, string> = {};
    let fileData: MultipartFile | null = null;
    let fileBuffer: Buffer | null = null;

    for await (const part of request.parts({ limits: { fileSize: app.uploadMaxBytes } })) {
      if (part.type === 'file') {
        if (fileData === null) {
          fileData = part;
          fileBuffer = await streamToBuffer(part.file);
        } else {
          part.file.resume(); // descarta arquivos extras
        }
      } else {
        textFields[part.fieldname] = part.value as string;
      }
    }

    // ------------------------------------------------------------------
    // Resolução de tenantId após leitura do form (multipart não permite
    // ler fields antes do loop). MTA envia tenantId explícito no form;
    // demais roles usam o tenantId do JWT.
    // ------------------------------------------------------------------
    let tenantId: string;
    if (request.user!.role === 'MULTI_TENANT_ADMIN') {
      const explicitTenantId = textFields['tenantId'];
      if (!explicitTenantId) {
        throw new NotFoundError('MULTI_TENANT_ADMIN deve informar tenantId no upload');
      }
      if (!(request.user!.allowedTenantIds ?? []).includes(explicitTenantId)) {
        throw new NotFoundError('Empresa não encontrada');
      }
      tenantId = explicitTenantId;
    } else {
      tenantId = request.tenantId as string;
    }

    if (!fileData || !fileBuffer) {
      return reply.status(422).send({
        error: { code: 'VALIDATION_ERROR', message: 'Campo "file" é obrigatório' },
      });
    }

    const data = fileData;
    const departmentIdRaw = textFields['departmentId'];
    const documentTypeIdRaw = textFields['documentTypeId'];
    const indexValuesRaw = textFields['indexValues'];

    // Valida campos obrigatórios
    const FieldsSchema = z.object({
      departmentId: z.string().uuid('departmentId inválido'),
      documentTypeId: z.string().uuid('documentTypeId inválido').optional(),
      indexValues: z
        .string()
        .optional()
        .transform((v) => {
          if (v === undefined || v === '') return {};
          try {
            return z.record(z.union([z.string(), z.number(), z.null()])).parse(JSON.parse(v));
          } catch {
            throw new Error('indexValues deve ser um JSON válido');
          }
        }),
    });

    const fields_ = FieldsSchema.parse({
      departmentId: departmentIdRaw,
      documentTypeId: documentTypeIdRaw,
      indexValues: indexValuesRaw,
    });

    const { departmentId, documentTypeId, indexValues } = fields_;

    // ------------------------------------------------------------------
    // 2. Verificar permissão de escrita no departamento (ACL por raiz)
    //    spec §10 invariante 5 + wiki "Permissões por departamento"
    //    ACL por raiz com herança dinâmica (Fase 6): UPLOADER/USER podem
    //    gravar em qualquer departamento cuja RAIZ foi concedida (pertencimento
    //    ao set expandido). Admins têm acesso total. Recurso inacessível → 404.
    //    Diferente de editar documentos órfãos, NÃO se pode arquivar um documento
    //    NOVO em departamento soft-deletado: exige-se departamento ativo aqui.
    // ------------------------------------------------------------------
    const userRole = request.user!.role;
    await assertCanWriteDepartment(db, userId, tenantId, departmentId, userRole);

    const activeDept = await db
      .collection('departments')
      .findOne({ id: departmentId, tenantId, deleted: false });
    if (!activeDept) {
      throw new NotFoundError('Departamento não encontrado');
    }

    // ------------------------------------------------------------------
    // 3. Calcular SHA-256 (buffer já lido no parse multipart)
    // ------------------------------------------------------------------
    const fileSize = fileBuffer.byteLength;
    const contentHash = sha256hex(fileBuffer);
    const originalFilename = data.filename;
    const mimeType = data.mimetype;
    const filename = sanitizeFilename(originalFilename);

    // ------------------------------------------------------------------
    // 4. Verificar cota de disco do tenant
    //    wiki "Cotas de disco e de usuários por empresa"
    // ------------------------------------------------------------------
    const tenant = await db.collection<TenantMongoDoc>('tenants').findOne({ id: tenantId });
    if (!tenant) {
      throw new NotFoundError('Tenant não encontrado');
    }

    // Calcular uso atual: soma de sizeBytes de todos documentos não deletados
    const usageAgg = await db
      .collection<DocumentDoc>('documents')
      .aggregate<{ total: number }>([
        { $match: { tenantId, deleted: false } },
        { $group: { _id: null, total: { $sum: '$sizeBytes' } } },
      ])
      .toArray();

    const currentUsageBytes = usageAgg[0]?.total ?? 0;

    if (currentUsageBytes + fileSize > tenant.diskQuotaBytes) {
      throw new QuotaExceededError(
        `Cota de disco esgotada: uso atual ${currentUsageBytes} bytes, ` +
          `arquivo ${fileSize} bytes, limite ${tenant.diskQuotaBytes} bytes`
      );
    }

    // ------------------------------------------------------------------
    // 5. Deduplicação: buscar documento com mesmo sha256 + tenantId
    //    wiki "Deduplicação de documentos por conteúdo"
    //    Retorna existente se status != FAILED
    // ------------------------------------------------------------------
    const existingDoc = await db.collection<DocumentDoc>('documents').findOne({
      tenantId,
      contentHash,
      deleted: false,
    });

    if (existingDoc !== null && existingDoc.status !== 'FAILED') {
      // O reenvio deduplicado É uma operação de upload: gera um NOVO evento
      // (deduplicated:true) apontando para o documento já existente. Dimensões
      // congeladas do arquivo ENVIADO agora (mimeType/sizeBytes) + tipo do doc
      // reaproveitado. pageCount nasce null (backfill é por documentId no worker).
      // wiki "Histórico de eventos de upload e relatório de uso (cobrança)".
      const existingTypeName = await resolveDocumentTypeName(
        db,
        tenantId,
        existingDoc.documentTypeId
      );
      await emitUploadEvent(db, request.log, tenantId, {
        documentId: existingDoc.id,
        uploadedById: userId,
        eventType: 'upload',
        mimeType,
        documentTypeId: existingDoc.documentTypeId,
        documentTypeName: existingTypeName,
        sizeBytes: fileSize,
        pageCount: null,
        deduplicated: true,
      });

      request.log.info(
        { tenantId, userId, documentId: existingDoc.id, contentHash },
        'documento deduplicado — retornando existente'
      );
      return reply
        .status(200)
        .header('X-Deduplicated', 'true')
        .send(existingDoc);
    }

    // ------------------------------------------------------------------
    // 6. Validar documentTypeId (se informado)
    //    Deve pertencer ao tenant OU ser global (isGlobal: true)
    //    wiki "Tipos de documento globais e por empresa"
    // ------------------------------------------------------------------
    if (documentTypeId !== undefined) {
      const docTypeRepo = new TenantRepository<DocumentTypeDoc>(
        db.collection('document_types'),
        { tenantId }
      );

      // Tenta no escopo do tenant primeiro
      const tenantDocType = await docTypeRepo.findById(documentTypeId);
      if (!tenantDocType) {
        // Tenta tipo global (tenantId: null)
        const globalDocType = await db.collection<DocumentTypeDoc>('document_types').findOne({
          id: documentTypeId,
          isGlobal: true,
          deleted: false,
        });
        if (!globalDocType) {
          throw new NotFoundError('Tipo de documento não encontrado');
        }
      }
    }

    // ------------------------------------------------------------------
    // 7. Upload para S3
    //    Chave: tenants/{tenantId}/documents/{sha256}/{filename}
    // ------------------------------------------------------------------
    const s3Key = `tenants/${tenantId}/documents/${contentHash}/${filename}`;
    await app.s3.uploadFile({ key: s3Key, buffer: fileBuffer, mimeType });

    // ------------------------------------------------------------------
    // 8. Persistir documento no MongoDB com status PENDING
    // ------------------------------------------------------------------
    const documentId = newId();
    const repo = new TenantRepository<DocumentDoc>(db.collection('documents'), { tenantId });

    let document: DocumentDoc;
    try {
      document = await repo.insertOne({
        id: documentId,
        departmentId,
        documentTypeId: documentTypeId ?? null,
        filename,
        originalFilename,
        contentHash,
        sizeBytes: fileSize,
        mimeType,
        s3Key,
        status: 'PENDING',
        failureReason: null,
        tags: [],
        mongoContentId: null,
        indexValues: indexValues as Record<string, string | number | Date | null>,
        uploadedById: userId,
        uploadedAt: new Date(),
        processedAt: null,
        costUsdCents: 0,
      });
    } catch (insertError) {
      // Rollback: remove arquivo do S3 para evitar objetos órfãos
      try {
        await app.s3.deleteFile(s3Key);
      } catch (deleteError) {
        request.log.error(
          { err: deleteError, s3Key, tenantId, userId },
          'falha ao remover arquivo do S3 no rollback'
        );
      }
      throw insertError;
    }

    // ------------------------------------------------------------------
    // 9. Enfileirar job BullMQ
    // ------------------------------------------------------------------
    const jobData: DocumentProcessingJobData = DocumentProcessingJobDataSchema.parse({
      tenantId,
      documentId: document.id,
      s3Key,
      mimeType,
    });

    if (app.queue !== null) {
      await app.queue.add('process-document', jobData, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      });
    } else {
      request.log.warn(
        { tenantId, documentId: document.id },
        'queue não configurada — job de processamento não enfileirado'
      );
    }

    // ------------------------------------------------------------------
    // 10. AuditLog
    //     spec §10 invariante 7: AuditLog em upload
    // ------------------------------------------------------------------
    const auditLogger = new AuditLogger(db);
    try {
      await auditLogger.record({
        tenantId,
        userId,
        action: 'document.upload',
        resource: `documents/${document.id}`,
        metadata: {
          filename: originalFilename,
          sizeBytes: fileSize,
          contentHash,
          departmentId,
          documentTypeId: documentTypeId ?? null,
        },
      });
    } catch (auditError) {
      // Auditoria nunca derruba a operação principal
      request.log.error(
        { err: auditError, tenantId, userId, documentId: document.id },
        'falha ao registrar audit log de upload'
      );
    }

    // ------------------------------------------------------------------
    // 11. Evento de upload (document_events — append-only, cobrança)
    //     Cobre o fluxo de upload NORMAL e também o caso FAILED: quando o
    //     documento existente estava FAILED, o `if` de dedup acima não
    //     retornou, então criamos um doc novo e este caminho emite o evento
    //     com deduplicated:false e o novo documentId.
    //     QUOTA_EXCEEDED nunca chega aqui (lança antes, no passo 4).
    //     wiki "Histórico de eventos de upload e relatório de uso (cobrança)".
    // ------------------------------------------------------------------
    const documentTypeName = await resolveDocumentTypeName(
      db,
      tenantId,
      documentTypeId ?? null
    );
    await emitUploadEvent(db, request.log, tenantId, {
      documentId: document.id,
      uploadedById: userId,
      eventType: 'upload',
      mimeType,
      documentTypeId: documentTypeId ?? null,
      documentTypeName,
      sizeBytes: fileSize,
      pageCount: null,
      deduplicated: false,
    });

    request.log.info(
      { tenantId, userId, documentId: document.id, sizeBytes: fileSize, contentHash },
      'documento enviado com sucesso'
    );

    return reply.status(201).send(document);
  });

  // =========================================================================
  // GET /documents — listagem paginada com filtros
  // =========================================================================
  /**
   * GET /documents
   *
   * Listagem paginada de documentos do tenant com filtros opcionais.
   * Paginação por cursor estável (ordenada por `id` ASC).
   *
   * Query params:
   *   - departmentId?    — filtra por departamento (verifica permissão de leitura)
   *   - documentTypeId?  — filtra por tipo de documento
   *   - tags?            — CSV de tags (ex.: "2026,janeiro")
   *   - status?          — filtra por status de processamento
   *   - cursor?          — cursor da página anterior (id do último item)
   *   - limit?           — itens por página (padrão 20, máx 100)
   *
   * Resposta: { items, nextCursor, total }
   */
  app.get('/documents', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.user!.sub;
    const role = request.user!.role;
    const db = app.db;

    // Parse e validação de query params
    const query = ListDocumentsQuerySchema.parse(request.query);

    // Resolve o contexto de tenant:
    // - roles normais: sempre o do JWT (mode: 'single')
    // - SUPER_ADMIN com ?tenantId=xxx: mode 'single'
    // - SUPER_ADMIN sem ?tenantId: mode 'all' (sem filtro)
    // - MULTI_TENANT_ADMIN com ?tenantId=xxx (∈ lista): mode 'single'
    // - MULTI_TENANT_ADMIN sem ?tenantId: mode 'allowed' ($in)
    const tenantContext = resolveTenantContext(request, { explicitTenantId: query.tenantId, write: false });

    // Mantém compatibilidade com helpers que esperam string | null
    const effectiveTenantId: string | null =
      tenantContext.mode === 'single' ? tenantContext.tenantId : null;

    // ------------------------------------------------------------------
    // 1. Resolver departamentos acessíveis
    // ------------------------------------------------------------------
    const readableDepartmentIds = await resolveAccessibleDepartmentIds(
      db,
      userId,
      effectiveTenantId,
      role
    );

    // Se filtro por departamento específico foi solicitado, verificar permissão
    if (query.departmentId !== undefined) {
      await assertCanReadDepartment(db, userId, effectiveTenantId, query.departmentId, role);
    }

    // ------------------------------------------------------------------
    // 2. Montar filtro base
    // ------------------------------------------------------------------
    type DocFilter = Record<string, unknown>;
    const baseFilter: DocFilter = { deleted: false };

    if (tenantContext.mode === 'single') {
      baseFilter['tenantId'] = tenantContext.tenantId;
    } else if (tenantContext.mode === 'allowed') {
      // MULTI_TENANT_ADMIN: filtra por $in sobre os tenants permitidos
      baseFilter['tenantId'] = { $in: tenantContext.tenantIds };
    }
    // mode: 'all' (SUPER_ADMIN sem tenantId) — sem filtro de tenant

    // Restrição de departamentos por role
    if (readableDepartmentIds !== null) {
      if (query.departmentId !== undefined) {
        // Verifica que o departamento solicitado está entre os permitidos
        if (!readableDepartmentIds.includes(query.departmentId)) {
          throw new NotFoundError('Departamento não encontrado ou sem permissão de leitura');
        }
        baseFilter['departmentId'] = query.departmentId;
      } else {
        baseFilter['departmentId'] = { $in: readableDepartmentIds };
      }
    } else if (query.departmentId !== undefined) {
      baseFilter['departmentId'] = query.departmentId;
    }

    if (query.documentTypeId !== undefined) {
      baseFilter['documentTypeId'] = query.documentTypeId;
    }

    if (query.status !== undefined) {
      baseFilter['status'] = query.status;
    }

    if (query.tags !== undefined) {
      const tagList = query.tags
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      if (tagList.length > 0) {
        baseFilter['tags'] = { $all: tagList };
      }
    }

    // ------------------------------------------------------------------
    // 3. Paginação por cursor
    // ------------------------------------------------------------------
    const limit = normalizeLimit(query.limit);

    const cursorFilter: DocFilter =
      query.cursor !== undefined ? { ...baseFilter, id: { $gt: query.cursor } } : baseFilter;

    const collection = db.collection<DocumentDoc>('documents');

    // Total (sem cursor — conta todos que casam com o filtro base)
    const total = await collection.countDocuments(baseFilter as Parameters<typeof collection.countDocuments>[0]);

    const docs = await collection
      .find(cursorFilter as Parameters<typeof collection.find>[0])
      .sort({ id: 1 })
      .limit(limit + 1)
      .toArray();

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;
    const last = page.at(-1);
    const nextCursor = hasMore && last ? last.id : null;

    // Strip _id (detalhe interno do Mongo)
    const items = page.map(({ _id: _ignored, ...rest }) => rest);

    request.log.info(
      { tenantId: effectiveTenantId, userId, total, returned: items.length },
      'listagem de documentos'
    );

    return reply.status(200).send({ items, nextCursor, total });
  });

  // =========================================================================
  // GET /documents/:id — detalhe de documento
  // =========================================================================
  /**
   * GET /documents/:id
   *
   * Retorna um documento pelo id, verificando isolamento de tenant e permissão
   * de leitura no departamento do documento.
   */
  app.get('/documents/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.user!.sub;
    const role = request.user!.role;
    const db = app.db;

    const { id } = request.params as { id: string };

    let doc: DocumentDoc | null;

    if (role === 'SUPER_ADMIN') {
      // SUPER_ADMIN não tem tenantId no JWT — busca o documento sem restrição
      // de tenant e resolve o tenantId a partir do próprio documento.
      doc = await findDocumentGlobally(db, id);
    } else if (role === 'MULTI_TENANT_ADMIN') {
      // MTA sem tenantId explícito: restringe a busca à lista de tenants permitidos.
      // Garante isolamento — documentos de empresas fora da lista são tratados
      // como inexistentes (spec §10, invariante 4).
      doc = await findDocumentInTenants(db, id, request.user?.allowedTenantIds ?? []);
    } else {
      const tenantId = request.tenantId as string;
      const repo = new TenantRepository<DocumentDoc>(db.collection('documents'), { tenantId });
      doc = await repo.findById(id);
    }

    if (!doc) {
      throw new NotFoundError('Documento não encontrado');
    }

    // Verifica permissão de leitura no departamento do documento.
    // Para SUPER_ADMIN/MTA o tenantId vem do próprio documento (sempre permitido).
    await assertCanReadDepartment(db, userId, doc.tenantId, doc.departmentId, role);

    // Enriquece com o número de páginas extraído (mora em document_content,
    // não na coleção documents). Nulo enquanto a extração não rodou.
    const content = await db
      .collection<{ extraction?: { pageCount?: number } }>('document_content')
      .findOne({ documentId: doc.id, tenantId: doc.tenantId }, { projection: { extraction: 1 } });
    const pageCount =
      typeof content?.extraction?.pageCount === 'number' ? content.extraction.pageCount : null;

    request.log.info(
      { tenantId: doc.tenantId, userId, documentId: doc.id },
      'detalhe de documento recuperado'
    );

    return reply.status(200).send({ ...doc, pageCount });
  });

  // =========================================================================
  // GET /documents/:id/download — URL assinada S3
  // =========================================================================
  /**
   * GET /documents/:id/download
   *
   * Gera uma URL pré-assinada do S3 com validade de 5 minutos para download
   * direto do arquivo. Registra AuditLog de download.
   *
   * Resposta: { url: string, expiresAt: string (ISO 8601) }
   */
  app.get('/documents/:id/download', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.user!.sub;
    const role = request.user!.role;
    const db = app.db;

    const { id } = request.params as { id: string };

    // ------------------------------------------------------------------
    // 1. Buscar documento
    //    SUPER_ADMIN: busca sem filtro de tenant (resolve pelo documento).
    //    MULTI_TENANT_ADMIN: restringe à lista allowedTenantIds.
    //    Demais roles: busca escopada ao tenant do JWT.
    // ------------------------------------------------------------------
    let doc: DocumentDoc | null;

    if (role === 'SUPER_ADMIN') {
      doc = await findDocumentGlobally(db, id);
    } else if (role === 'MULTI_TENANT_ADMIN') {
      doc = await findDocumentInTenants(db, id, request.user?.allowedTenantIds ?? []);
    } else {
      const tenantId = request.tenantId as string;
      const repo = new TenantRepository<DocumentDoc>(db.collection('documents'), { tenantId });
      doc = await repo.findById(id);
    }

    if (!doc) {
      throw new NotFoundError('Documento não encontrado');
    }

    // ------------------------------------------------------------------
    // 2. Verificar permissão de leitura no departamento
    // ------------------------------------------------------------------
    await assertCanReadDepartment(db, userId, doc.tenantId, doc.departmentId, role);

    // ------------------------------------------------------------------
    // 3. Gerar URL assinada (5 minutos = 300 segundos)
    // ------------------------------------------------------------------
    const expiresInSeconds = 300;
    const url = await app.s3.getSignedDownloadUrl(doc.s3Key, expiresInSeconds);
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

    // ------------------------------------------------------------------
    // 4. AuditLog de download
    // ------------------------------------------------------------------
    const auditLogger = new AuditLogger(db);
    try {
      await auditLogger.record({
        tenantId: doc.tenantId,
        userId,
        action: 'document.download',
        resource: `documents/${doc.id}`,
        metadata: { filename: doc.originalFilename, s3Key: doc.s3Key },
      });
    } catch (auditError) {
      request.log.error(
        { err: auditError, tenantId: doc.tenantId, userId, documentId: doc.id },
        'falha ao registrar audit log de download'
      );
    }

    request.log.info(
      { tenantId: doc.tenantId, userId, documentId: doc.id },
      'URL de download gerada'
    );

    return reply.status(200).send({ url, expiresAt });
  });

  // =========================================================================
  // GET /documents/:id/preview — converte Office→PDF via extractor e devolve PDF
  // =========================================================================
  /**
   * GET /documents/:id/preview
   *
   * Baixa o arquivo original do S3, envia ao microserviço extractor para
   * conversão Office→PDF (LibreOffice headless) e devolve o PDF inline.
   * Usado pelo frontend para PPTX/PPT — o <iframe> carrega o blob URL.
   *
   * Suporta: pptx, ppt, docx, doc, xlsx, xls, odp, odt.
   * Outros mime types retornam 422.
   */
  app.get('/documents/:id/preview', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.user!.sub;
    const role = request.user!.role;
    const db = app.db;

    const { id } = request.params as { id: string };

    // ------------------------------------------------------------------
    // 1. Buscar documento (mesmo padrão do /download)
    // ------------------------------------------------------------------
    let doc: DocumentDoc | null;

    if (role === 'SUPER_ADMIN') {
      doc = await findDocumentGlobally(db, id);
    } else if (role === 'MULTI_TENANT_ADMIN') {
      doc = await findDocumentInTenants(db, id, request.user?.allowedTenantIds ?? []);
    } else {
      const tenantId = request.tenantId as string;
      const repo = new TenantRepository<DocumentDoc>(db.collection('documents'), { tenantId });
      doc = await repo.findById(id);
    }

    if (!doc) {
      throw new NotFoundError('Documento não encontrado');
    }

    // ------------------------------------------------------------------
    // 2. Verificar permissão de leitura no departamento
    // ------------------------------------------------------------------
    await assertCanReadDepartment(db, userId, doc.tenantId, doc.departmentId, role);

    // ------------------------------------------------------------------
    // 3. Validar mime type — apenas formatos que o extractor converte
    // ------------------------------------------------------------------
    const CONVERTIBLE_MIMES = new Set([
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/vnd.oasis.opendocument.presentation',
      'application/vnd.oasis.opendocument.text',
    ]);

    if (!CONVERTIBLE_MIMES.has(doc.mimeType)) {
      return reply.status(422).send({ error: `mime type não suportado para preview: ${doc.mimeType}` });
    }

    // ------------------------------------------------------------------
    // 4. Baixar arquivo do S3 como buffer
    // ------------------------------------------------------------------
    const fileBuffer = await app.s3.downloadFile(doc.s3Key);

    // ------------------------------------------------------------------
    // 5. Enviar ao extractor para conversão Office→PDF
    // ------------------------------------------------------------------
    const { EXTRACTOR_URL } = getConfig();
    const extractorBaseUrl = EXTRACTOR_URL.replace(/\/extract$/, '');
    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer], { type: doc.mimeType }), doc.originalFilename);
    formData.append('content_type', doc.mimeType);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 70_000);

    let pdfBuffer: Buffer;
    try {
      const extractorResponse = await fetch(`${extractorBaseUrl}/convert/pdf`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      if (!extractorResponse.ok) {
        const errText = await extractorResponse.text().catch(() => '');
        request.log.error(
          { tenantId: doc.tenantId, userId, documentId: doc.id, status: extractorResponse.status, body: errText },
          'extractor retornou erro na conversão'
        );
        return reply.status(502).send({ error: 'falha na conversão do documento' });
      }

      pdfBuffer = Buffer.from(await extractorResponse.arrayBuffer());
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError') {
        return reply.status(504).send({ error: 'timeout na conversão do documento' });
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    // ------------------------------------------------------------------
    // 6. AuditLog de preview
    // ------------------------------------------------------------------
    const auditLogger = new AuditLogger(db);
    try {
      await auditLogger.record({
        tenantId: doc.tenantId,
        userId,
        action: 'document.preview',
        resource: `documents/${doc.id}`,
        metadata: { filename: doc.originalFilename, mimeType: doc.mimeType },
      });
    } catch (auditError) {
      request.log.error(
        { err: auditError, tenantId: doc.tenantId, userId, documentId: doc.id },
        'falha ao registrar audit log de preview'
      );
    }

    request.log.info(
      { tenantId: doc.tenantId, userId, documentId: doc.id, mimeType: doc.mimeType },
      'preview PDF gerado via extractor'
    );

    return reply
      .status(200)
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename="${doc.id}.pdf"`)
      .send(pdfBuffer);
  });

  // =========================================================================
  // PATCH /documents/:id — edição manual de tipo, índices e tags
  // =========================================================================
  /**
   * PATCH /documents/:id
   *
   * Atualiza campos editáveis do documento: documentTypeId, indexValues e tags.
   * Campos protegidos (status, s3Key, contentHash, uploadedById) nunca são
   * alterados por este endpoint.
   *
   * Valida indexValues contra indexFields do tipo quando documentTypeId está
   * preenchido (informado agora ou já salvo).
   *
   * Registra AuditLog com a lista de campos alterados.
   */
  app.patch('/documents/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.user!.sub;
    const role = request.user!.role;
    const db = app.db;

    const { id } = request.params as { id: string };

    // Parse e validação de body
    const body = PatchDocumentBodySchema.parse(request.body);

    // ------------------------------------------------------------------
    // 1. Buscar documento
    //    SUPER_ADMIN: busca sem filtro de tenant (resolve pelo documento).
    //    MULTI_TENANT_ADMIN: restringe à lista allowedTenantIds.
    //    Demais roles: busca escopada ao tenant do JWT.
    // ------------------------------------------------------------------
    let doc: DocumentDoc | null;

    if (role === 'SUPER_ADMIN') {
      doc = await findDocumentGlobally(db, id);
    } else if (role === 'MULTI_TENANT_ADMIN') {
      doc = await findDocumentInTenants(db, id, request.user?.allowedTenantIds ?? []);
    } else {
      const tenantId = request.tenantId as string;
      const repo = new TenantRepository<DocumentDoc>(db.collection('documents'), { tenantId });
      doc = await repo.findById(id);
    }

    if (!doc) {
      throw new NotFoundError('Documento não encontrado');
    }

    // A partir daqui o tenantId é sempre o do documento.
    const tenantId = doc.tenantId;
    const repo = new TenantRepository<DocumentDoc>(db.collection('documents'), { tenantId });

    // ------------------------------------------------------------------
    // 2. Verificar permissão de ESCRITA no departamento
    // ------------------------------------------------------------------
    await assertCanWriteDepartment(db, userId, tenantId, doc.departmentId, role);

    // ------------------------------------------------------------------
    // 3. Validar documentTypeId (se informado)
    //    Deve pertencer ao tenant OU ser global (isGlobal: true)
    // ------------------------------------------------------------------
    // Determina o documentTypeId efetivo após o patch:
    // - se body traz explicitamente null → limpar tipo
    // - se body traz uuid → usar novo
    // - se body não traz → manter o do documento
    const effectiveDocumentTypeId: string | null =
      'documentTypeId' in body
        ? (body.documentTypeId ?? null)
        : (doc.documentTypeId ?? null);

    if (body.documentTypeId !== undefined && body.documentTypeId !== null) {
      const docTypeRepo = new TenantRepository<DocumentTypeDoc>(
        db.collection('document_types'),
        { tenantId }
      );
      const tenantDocType = await docTypeRepo.findById(body.documentTypeId);
      if (!tenantDocType) {
        const globalDocType = await db.collection<DocumentTypeDoc>('document_types').findOne({
          id: body.documentTypeId,
          isGlobal: true,
          deleted: false,
        });
        if (!globalDocType) {
          throw new NotFoundError('Tipo de documento não encontrado');
        }
      }
    }

    // ------------------------------------------------------------------
    // 4. Validar indexValues contra indexFields do tipo efetivo
    // ------------------------------------------------------------------
    if (body.indexValues !== undefined && effectiveDocumentTypeId !== null) {
      // Buscar o tipo (tenant ou global) para obter os indexFields
      const docTypeRepo = new TenantRepository<DocumentTypeDoc>(
        db.collection('document_types'),
        { tenantId }
      );
      let docType = await docTypeRepo.findById(effectiveDocumentTypeId);
      if (!docType) {
        docType = await db.collection<DocumentTypeDoc>('document_types').findOne({
          id: effectiveDocumentTypeId,
          isGlobal: true,
          deleted: false,
        }) ?? null;
      }

      if (docType) {
        const indexFields = (docType.indexFields as IndexFieldDoc[]) ?? [];
        const validationErrors = validateIndexValues(
          body.indexValues as Record<string, string | number | null>,
          indexFields
        );
        if (validationErrors.length > 0) {
          return reply.status(422).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Valores de índice inválidos',
              details: validationErrors,
            },
          });
        }
      }
    }

    // ------------------------------------------------------------------
    // 5. Montar update parcial (nunca sobrescreve campos protegidos)
    // ------------------------------------------------------------------
    const updateData: Partial<Omit<DocumentDoc, 'id' | 'tenantId' | 'deleted'>> = {};

    if ('documentTypeId' in body) {
      updateData.documentTypeId = body.documentTypeId ?? null;
    }
    if (body.indexValues !== undefined) {
      updateData.indexValues = body.indexValues as Record<string, string | number | Date | null>;
    }
    if (body.tags !== undefined) {
      updateData.tags = body.tags;
    }

    // Se não há nada para atualizar, retorna o documento atual sem tocar no banco
    if (Object.keys(updateData).length === 0) {
      return reply.status(200).send(doc);
    }

    const updated = await repo.updateById(id, updateData);

    if (!updated) {
      throw new NotFoundError('Documento não encontrado');
    }

    // ------------------------------------------------------------------
    // 6. AuditLog
    // ------------------------------------------------------------------
    const auditLogger = new AuditLogger(db);
    try {
      await auditLogger.record({
        tenantId,
        userId,
        action: 'document.update',
        resource: `documents/${doc.id}`,
        metadata: { changedFields: Object.keys(body) },
      });
    } catch (auditError) {
      request.log.error(
        { err: auditError, tenantId, userId, documentId: doc.id },
        'falha ao registrar audit log de atualização de documento'
      );
    }

    request.log.info(
      { tenantId, userId, documentId: doc.id, changedFields: Object.keys(body) },
      'documento atualizado'
    );

    return reply.status(200).send(updated);
  });

  // =========================================================================
  // DELETE /documents/:id — exclusão lógica + limpeza de chunks/S3
  // =========================================================================
  /**
   * DELETE /documents/:id
   *
   * Soft-delete do documento (marca `deleted: true`). Remove fisicamente os
   * chunks e o document_content do MongoDB e o arquivo do S3.
   *
   * Permissão: TENANT_ADMIN/SUPER_ADMIN sempre; UPLOADER precisa de canWrite no departamento.
   * Resposta: 204 No Content.
   */
  app.delete('/documents/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.user!.sub;
    const role = request.user!.role;
    const db = app.db;

    const { id } = request.params as { id: string };

    // SUPER_ADMIN: busca sem filtro de tenant (resolve pelo documento).
    // MULTI_TENANT_ADMIN: restringe à lista allowedTenantIds.
    // Demais roles: busca escopada ao tenant do JWT.
    let doc: DocumentDoc | null;

    if (role === 'SUPER_ADMIN') {
      doc = await findDocumentGlobally(db, id);
    } else if (role === 'MULTI_TENANT_ADMIN') {
      doc = await findDocumentInTenants(db, id, request.user?.allowedTenantIds ?? []);
    } else {
      const tenantId = request.tenantId as string;
      const repo = new TenantRepository<DocumentDoc>(db.collection('documents'), { tenantId });
      doc = await repo.findById(id);
    }

    if (!doc) {
      throw new NotFoundError('Documento não encontrado');
    }

    const tenantId = doc.tenantId;
    const repo = new TenantRepository<DocumentDoc>(db.collection('documents'), { tenantId });

    await assertCanWriteDepartment(db, userId, tenantId, doc.departmentId, role);

    await repo.softDelete(id);

    // Remove chunks e document_content — não há valor em mantê-los após exclusão
    await Promise.all([
      db.collection('chunks').deleteMany({ documentId: id, tenantId }),
      db.collection('document_content').deleteOne({ documentId: id, tenantId }),
    ]);

    // Remove o arquivo do S3 (falha silenciosa — não derruba a operação)
    await app.s3.deleteFile(doc.s3Key).catch((s3Err: unknown) => {
      request.log.error({ err: s3Err, s3Key: doc.s3Key }, 'falha ao remover arquivo do S3');
    });

    const auditLogger = new AuditLogger(db);
    try {
      await auditLogger.record({
        tenantId,
        userId,
        action: 'document.delete',
        resource: `documents/${doc.id}`,
        metadata: { filename: doc.filename, s3Key: doc.s3Key },
      });
    } catch (auditError) {
      request.log.error(
        { err: auditError, tenantId, userId, documentId: doc.id },
        'falha ao registrar audit log de exclusão'
      );
    }

    request.log.info({ tenantId, userId, documentId: doc.id }, 'documento excluído');

    return reply.status(204).send();
  });

  // =========================================================================
  // POST /documents/:id/reprocess — reenfileira job para documento FAILED
  // =========================================================================
  /**
   * POST /documents/:id/reprocess
   *
   * Reenfileira o job de processamento de um documento que está em status FAILED.
   * Limpa document_content e chunks anteriores para forçar re-extração completa
   * (caso contrário a guarda de idempotência no worker retorna o conteúdo antigo).
   *
   * Permissão: TENANT_ADMIN/SUPER_ADMIN sempre; UPLOADER precisa de canWrite no departamento.
   * Spec §8 fase 5, entregável 38.
   */
  app.post('/documents/:id/reprocess', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.user!.sub;
    const role = request.user!.role;
    const db = app.db;

    const { id } = request.params as { id: string };

    // SUPER_ADMIN: busca sem filtro de tenant (resolve pelo documento).
    // MULTI_TENANT_ADMIN: restringe à lista allowedTenantIds.
    // Demais roles: busca escopada ao tenant do JWT.
    let doc: DocumentDoc | null;

    if (role === 'SUPER_ADMIN') {
      doc = await findDocumentGlobally(db, id);
    } else if (role === 'MULTI_TENANT_ADMIN') {
      doc = await findDocumentInTenants(db, id, request.user?.allowedTenantIds ?? []);
    } else {
      const tenantId = request.tenantId as string;
      const repo = new TenantRepository<DocumentDoc>(db.collection('documents'), { tenantId });
      doc = await repo.findById(id);
    }

    if (!doc) {
      throw new NotFoundError('Documento não encontrado');
    }

    if (doc.status === 'PROCESSING' || doc.status === 'PENDING') {
      return reply.status(409).send({
        error: 'Conflict',
        message: `Reprocessamento não pode ser iniciado enquanto o documento está ${doc.status}.`,
      });
    }

    const tenantId = doc.tenantId;
    const repo = new TenantRepository<DocumentDoc>(db.collection('documents'), { tenantId });

    await assertCanWriteDepartment(db, userId, tenantId, doc.departmentId, role);

    // Limpa conteúdo anterior para forçar re-extração completa no worker
    await db.collection('document_content').deleteOne({ documentId: id, tenantId });
    await db.collection('chunks').deleteMany({ documentId: id, tenantId });

    const updated = await repo.updateById(id, {
      status: 'PENDING',
      failureReason: null,
    } as Partial<Omit<DocumentDoc, 'id' | 'tenantId' | 'deleted'>>);

    if (!updated) {
      throw new NotFoundError('Documento não encontrado');
    }

    const jobData: DocumentProcessingJobData = DocumentProcessingJobDataSchema.parse({
      tenantId,
      documentId: doc.id,
      s3Key: doc.s3Key,
      mimeType: doc.mimeType,
    });

    if (app.queue !== null) {
      await app.queue.add('process-document', jobData, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      });
    } else {
      request.log.warn(
        { tenantId, documentId: doc.id },
        'queue não configurada — job de reprocessamento não enfileirado'
      );
    }

    const auditLogger = new AuditLogger(db);
    try {
      await auditLogger.record({
        tenantId,
        userId,
        action: 'document.reprocess',
        resource: `documents/${doc.id}`,
        metadata: { previousFailureReason: doc.failureReason },
      });
    } catch (auditError) {
      request.log.error(
        { err: auditError, tenantId, userId, documentId: doc.id },
        'falha ao registrar audit log de reprocessamento'
      );
    }

    request.log.info(
      { tenantId, userId, documentId: doc.id },
      'documento reenfileirado para reprocessamento'
    );

    return reply.status(202).send(updated);
  });

  // =========================================================================
  // GET /documents/:id/status-stream — SSE de status de processamento
  // =========================================================================
  /**
   * GET /documents/:id/status-stream
   *
   * Abre um stream SSE que emite o status atual do documento a cada 2 segundos.
   * Fecha automaticamente quando o status atinge um estado terminal (READY ou FAILED).
   * O cliente deve fechar a conexão caso abandone a página antes disso.
   */
  app.get('/documents/:id/status-stream', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = request.user!.sub;
    const role = request.user!.role;
    const db = app.db;

    const { id } = request.params as { id: string };

    let doc: DocumentDoc | null;

    if (role === 'SUPER_ADMIN') {
      doc = await findDocumentGlobally(db, id);
    } else if (role === 'MULTI_TENANT_ADMIN') {
      doc = await findDocumentInTenants(db, id, request.user?.allowedTenantIds ?? []);
    } else {
      const tenantId = request.tenantId as string;
      const repo = new TenantRepository<DocumentDoc>(db.collection('documents'), { tenantId });
      doc = await repo.findById(id);
    }

    if (!doc) {
      throw new NotFoundError('Documento não encontrado');
    }

    await assertCanReadDepartment(db, userId, doc.tenantId, doc.departmentId, role);

    const tenantId = doc.tenantId;

    reply.hijack();

    // @fastify/cors é bypassado pelo hijack — headers CORS precisam ser setados manualmente.
    const origin = (request.headers['origin'] as string | undefined) ?? '*';
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
    });

    const TERMINAL = new Set(['READY', 'FAILED']);

    const formatSSE = (data: unknown): string =>
      `event: status\ndata: ${JSON.stringify(data)}\n\n`;

    const sendStatus = async (): Promise<boolean> => {
      const current = await db.collection<DocumentDoc>('documents').findOne(
        { id, tenantId },
        { projection: { status: 1, failureReason: 1 } }
      );
      if (!current) return true;
      reply.raw.write(formatSSE({ status: current.status, failureReason: current.failureReason ?? null }));
      return TERMINAL.has(current.status);
    };

    // Envia status imediatamente e encerra se já for terminal
    const alreadyDone = await sendStatus();
    if (alreadyDone) {
      reply.raw.end();
      return;
    }

    const interval = setInterval(() => {
      void sendStatus().then((done) => {
        if (done) {
          clearInterval(interval);
          reply.raw.end();
        }
      });
    }, 2000);

    // Limpa o intervalo se o cliente fechar a conexão antes do término
    reply.raw.on('close', () => {
      clearInterval(interval);
    });
  });
};
