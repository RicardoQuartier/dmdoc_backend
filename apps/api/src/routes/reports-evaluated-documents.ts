import type { FastifyBaseLogger, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { EvaluatedDocumentEntriesRepository } from '@dmdoc/db-pg';
import type { Role } from '@dmdoc/shared-types';
import { AuditLogger, type AuditSql } from '../auth/audit.js';
import { requireRole } from '../auth/role-guard.js';
import { resolveTenantContext } from '../auth/resolve-tenant.js';
import { rolesVisibleTo } from '../auth/role-visibility.js';
import { NotFoundError, ValidationError } from '../errors/index.js';
import { csvUuids } from '../lib/query-schemas.js';

/**
 * Lançamentos MANUAIS de páginas avaliadas (épico E-13) — seção "Documentos
 * avaliados" do relatório de Uso e Cobrança.
 *
 * Toda rota segue a mesma ordem, sem exceção:
 *  1. gate de papel (`requireRole` TENANT_ADMIN/MTA; SA passa sempre) → 403
 *     para UPLOADER/USER ANTES de qualquer leitura;
 *  2. escopo de empresa (`resolveScopedTenantId`) → 404 fora do escopo;
 *  3. repositório escopado pelo tenant resolvido → lançamento de outra empresa
 *     é 404 (nunca 403).
 *
 * Leitura de identidade (nomes, seletor de usuários) obedece a regra de
 * hierarquia "inferior ou igual" (`rolesVisibleTo`).
 *
 * Escrita (criar/editar/excluir) e audit são ATÔMICOS: rodam no mesmo
 * `sql.begin`. A justificativa de uma correção só existe no audit log — se ele
 * não gravar, a correção não pode valer. Falha no audit desfaz a operação e a
 * rota responde erro.
 *
 * Empresa do usuário do lançamento: o banco só garante que o usuário EXISTE
 * (FK simples em `user_id`). Que ele é DESTA empresa, ativo e de nível ≤ ao do
 * ator é garantido aqui, por `findSelectableUser`, antes de gravar.
 */

type Entry = NonNullable<Awaited<ReturnType<EvaluatedDocumentEntriesRepository['findById']>>>;

/** Teto de páginas por lançamento — barra erro de digitação grosseiro. */
const MAX_PAGE_COUNT = 1_000_000;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `true` se `YYYY-MM-DD` existe no calendário (rejeita `2026-02-30`). */
function isCalendarDate(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Data de "hoje" no fuso de Brasília, `YYYY-MM-DD`. A regra "data da avaliação
 * não pode ser futura" é de negócio e segue o relógio do cliente brasileiro,
 * não o UTC do servidor (às 22h de Brasília o UTC já está no dia seguinte).
 */
export function todayInSaoPaulo(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

const isoDate = z
  .string()
  .regex(ISO_DATE_RE, 'data deve estar no formato YYYY-MM-DD')
  .refine(isCalendarDate, 'data inexistente no calendário');

const evaluatedOnSchema = isoDate.refine(
  // Comparação lexicográfica é correta para `YYYY-MM-DD`.
  (value) => value <= todayInSaoPaulo(),
  'evaluatedOn não pode ser uma data futura (fuso America/Sao_Paulo)',
);

const pageCountSchema = z
  .number()
  .int('pageCount deve ser um número inteiro')
  .min(1, 'pageCount deve ser no mínimo 1')
  .max(MAX_PAGE_COUNT, `pageCount deve ser no máximo ${MAX_PAGE_COUNT}`);

const justificationSchema = z
  .string()
  .trim()
  .min(10, 'justificativa deve ter ao menos 10 caracteres')
  .max(500, 'justificativa deve ter no máximo 500 caracteres');

const ListQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
  dateFrom: isoDate.optional(),
  dateTo: isoDate.optional(),
  userIds: csvUuids,
  page: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? Number(v) : 1))
    .pipe(z.number().int().min(1)),
  // Teto 100 = limite do repositório (`normalizeLimit`); acima disso ele
  // truncaria em silêncio, então a rota recusa explicitamente.
  pageSize: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? Number(v) : 20))
    .pipe(z.number().int().min(1).max(100)),
});

/** `tenantId` na query — usado por GET /users, PATCH e DELETE. */
const TenantQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
});

const IdParamsSchema = z.object({ id: z.string().min(1) });

const CreateBodySchema = z
  .object({
    tenantId: z.string().uuid().optional(),
    userId: z.string().uuid(),
    evaluatedOn: evaluatedOnSchema,
    pageCount: pageCountSchema,
  })
  .strict();

const UpdateBodySchema = z
  .object({
    userId: z.string().uuid().optional(),
    evaluatedOn: evaluatedOnSchema.optional(),
    pageCount: pageCountSchema.optional(),
    justification: justificationSchema,
  })
  .strict()
  .refine(
    (b) => b.userId !== undefined || b.evaluatedOn !== undefined || b.pageCount !== undefined,
    { message: 'informe ao menos um campo a alterar (userId, evaluatedOn ou pageCount)' },
  );

const DeleteBodySchema = z.object({ justification: justificationSchema }).strict();

type SelectableUserRow = { id: string; name: string; email: string };

/**
 * Resolve a empresa em escopo da operação — SEMPRE uma empresa concreta.
 *
 * Usa `write: false` de propósito: com `write: true`, SUPER_ADMIN sem
 * `tenantId` recebe 409 (ConflictError). Aqui qualquer ausência de empresa
 * concreta é tratada como recurso inexistente → 404, igual ao MTA. Nenhum modo
 * de leitura ampla (`all`/`allowed`) sobrevive: `mode !== 'single'` → 404.
 *
 * Papéis locais têm o tenant fixado pelo token (`resolveTenantContext` ignora o
 * parâmetro). Se um TENANT_ADMIN informar `tenantId` de OUTRA empresa, a rota
 * responde 404 em vez de devolver silenciosamente os dados da própria — o
 * pedido era por um recurso fora do escopo dele.
 */
function resolveScopedTenantId(request: FastifyRequest, explicitTenantId: string | undefined): string {
  const ctx = resolveTenantContext(request, { explicitTenantId, write: false });
  if (ctx.mode !== 'single') {
    throw new NotFoundError('tenantId é obrigatório para esta operação');
  }
  if (explicitTenantId !== undefined && explicitTenantId !== ctx.tenantId) {
    throw new NotFoundError('Empresa não encontrada ou sem acesso');
  }
  return ctx.tenantId;
}

/**
 * Usuários a quem se pode atribuir um lançamento: da empresa, ativos, não
 * excluídos e de nível ≤ ao do ator. É a MESMA regra do seletor
 * (`GET /reports/evaluated-documents/users`) e da validação de `userId` em
 * POST/PATCH — um id fora deste conjunto é 404, sem revelar se existe em outra
 * empresa ou em nível acima. É a ÚNICA barreira de empresa do usuário: o banco
 * só tem FK simples em `user_id`.
 */
async function findSelectableUser(
  q: AuditSql,
  tenantId: string,
  visibleRoles: Role[],
  userId: string,
): Promise<SelectableUserRow | null> {
  const rows = await q<SelectableUserRow[]>`
    SELECT id, name, email
      FROM users
     WHERE id = ${userId}
       AND tenant_id = ${tenantId}
       AND deleted = false
       AND active = true
       AND role = ANY(${visibleRoles}::text[])
     LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Nomes dos usuários referenciados pelos lançamentos, só para papéis visíveis
 * ao ator. Sem filtro de `tenant_id`: o autor do lançamento pode ser um papel
 * global (MTA/SA, `tenant_id` nulo) — e o usuário do lançamento pode ter sido
 * promovido a papel global depois — e é a hierarquia que decide se o nome
 * aparece. Os ids vêm de lançamentos já escopados pela empresa. Usuário
 * excluído logicamente mantém o nome: o lançamento dele continua contando.
 */
async function loadVisibleNames(
  q: AuditSql,
  ids: Iterable<string | null>,
  visibleRoles: Role[],
): Promise<Map<string, string>> {
  const unique = [...new Set([...ids].filter((id): id is string => id !== null))];
  const names = new Map<string, string>();
  if (unique.length === 0) return names;
  const rows = await q<Array<{ id: string; name: string }>>`
    SELECT id, name
      FROM users
     WHERE id = ANY(${unique}::uuid[])
       AND role = ANY(${visibleRoles}::text[])
  `;
  for (const r of rows) names.set(r.id, r.name);
  return names;
}

function toItem(entry: Entry, names: Map<string, string>) {
  return {
    id: entry.id,
    evaluatedOn: entry.evaluatedOn,
    userId: entry.userId,
    userName: entry.userId !== null ? (names.get(entry.userId) ?? null) : null,
    pageCount: entry.pageCount,
    createdById: entry.createdById,
    createdByName: entry.createdById !== null ? (names.get(entry.createdById) ?? null) : null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

/** Campos de negócio que o audit registra como `before`/`after`. */
function snapshot(entry: Entry): { userId: string | null; evaluatedOn: string; pageCount: number } {
  return { userId: entry.userId, evaluatedOn: entry.evaluatedOn, pageCount: entry.pageCount };
}

/**
 * Traduz violações do banco (última barreira — a rota valida antes) para erros
 * tipados: FK de `user_id` (usuário inexistente) → 404; CHECK de páginas → 422.
 */
function mapWriteError(err: unknown): never {
  const code = (err as { code?: string }).code;
  if (code === '23503') throw new NotFoundError('Usuário não encontrado');
  if (code === '23514') throw new ValidationError('pageCount deve ser maior que zero');
  throw err;
}

/**
 * Grava o audit DENTRO da transação da operação (`tx`). Não engole falha: loga
 * com contexto e relança, para o `sql.begin` desfazer a operação e a rota
 * responder erro (500 pelo handler central).
 */
async function recordAuditInTx(
  tx: AuditSql,
  log: FastifyBaseLogger,
  entry: { tenantId: string; userId: string; action: string; entryId: string; metadata: Record<string, unknown> },
): Promise<void> {
  try {
    await new AuditLogger(tx).record({
      tenantId: entry.tenantId,
      userId: entry.userId,
      action: entry.action,
      resource: `evaluated-documents/${entry.entryId}`,
      metadata: entry.metadata,
    });
  } catch (auditError) {
    log.error(
      { err: auditError, tenantId: entry.tenantId, userId: entry.userId, entryId: entry.entryId, action: entry.action },
      'falha ao registrar audit log de documentos avaliados — operação desfeita',
    );
    throw auditError;
  }
}

export const reportsEvaluatedDocumentsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /reports/evaluated-documents — totais, quebra por usuário e página de
   * lançamentos do filtro. `totals`/`byUser` consideram o filtro inteiro (não
   * só a página). Lançamento excluído não aparece em nada.
   */
  app.get('/reports/evaluated-documents', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN', 'MULTI_TENANT_ADMIN');

    const query = ListQuerySchema.parse(request.query);
    const tenantId = resolveScopedTenantId(request, query.tenantId);

    if (query.dateFrom !== undefined && query.dateTo !== undefined && query.dateFrom > query.dateTo) {
      throw new ValidationError('dateFrom não pode ser posterior a dateTo');
    }

    const sql = app.db;
    const actor = request.user!;
    const repo = new EvaluatedDocumentEntriesRepository(sql, { tenantId });

    // `userIds` vazio = sem filtro. O repositório trata `[]` como "nenhum
    // usuário" (falha fechada), então o campo só vai quando há ids.
    const filter = {
      ...(query.dateFrom !== undefined ? { dateFrom: query.dateFrom } : {}),
      ...(query.dateTo !== undefined ? { dateTo: query.dateTo } : {}),
      ...(query.userIds.length > 0 ? { userIds: query.userIds } : {}),
    };

    const [summary, pageResult] = await Promise.all([
      repo.summary(filter),
      repo.listPaged({ ...filter, page: query.page, pageSize: query.pageSize }),
    ]);

    const names = await loadVisibleNames(
      sql,
      [
        ...summary.byUser.map((r) => r.userId),
        ...pageResult.items.map((e) => e.userId),
        ...pageResult.items.map((e) => e.createdById),
      ],
      rolesVisibleTo(actor.role),
    );

    request.log.info(
      {
        tenantId,
        userId: actor.sub,
        filters: { dateFrom: query.dateFrom ?? null, dateTo: query.dateTo ?? null, userIds: query.userIds },
        total: pageResult.total,
        page: pageResult.page,
      },
      'relatório de documentos avaliados consultado',
    );

    return reply.status(200).send({
      tenantId,
      totals: summary.totals,
      byUser: summary.byUser.map((r) => ({
        userId: r.userId,
        label: r.userId !== null ? (names.get(r.userId) ?? null) : null,
        entries: r.entries,
        pages: r.pages,
      })),
      items: pageResult.items.map((e) => toItem(e, names)),
      page: pageResult.page,
      pageSize: pageResult.pageSize,
      total: pageResult.total,
      pageCount: Math.ceil(pageResult.total / pageResult.pageSize),
    });
  });

  /**
   * GET /reports/evaluated-documents/users — usuários selecionáveis (modal de
   * lançamento e filtro "Usuário"): da empresa, ativos, não excluídos e de
   * nível ≤ ao do ator, ordenados por nome.
   */
  app.get('/reports/evaluated-documents/users', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN', 'MULTI_TENANT_ADMIN');

    const query = TenantQuerySchema.parse(request.query);
    const tenantId = resolveScopedTenantId(request, query.tenantId);
    const actor = request.user!;
    const visibleRoles = rolesVisibleTo(actor.role);

    const users = await app.db<SelectableUserRow[]>`
      SELECT id, name, email
        FROM users
       WHERE tenant_id = ${tenantId}
         AND deleted = false
         AND active = true
         AND role = ANY(${visibleRoles}::text[])
       ORDER BY name, id
    `;

    request.log.info(
      { tenantId, userId: actor.sub, count: users.length },
      'usuários selecionáveis de documentos avaliados consultados',
    );

    return reply.status(200).send(users);
  });

  /**
   * POST /reports/evaluated-documents — cria um lançamento. Validação do
   * usuário, INSERT e audit na mesma transação.
   */
  app.post('/reports/evaluated-documents', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN', 'MULTI_TENANT_ADMIN');

    const body = CreateBodySchema.parse(request.body);
    const tenantId = resolveScopedTenantId(request, body.tenantId);

    const sql = app.db;
    const actor = request.user!;
    const visibleRoles = rolesVisibleTo(actor.role);

    const entry = await sql.begin(async (tx) => {
      // Única barreira de empresa + nível do usuário (o banco só garante que
      // ele existe).
      if ((await findSelectableUser(tx, tenantId, visibleRoles, body.userId)) === null) {
        throw new NotFoundError('Usuário não encontrado');
      }

      const repo = new EvaluatedDocumentEntriesRepository(tx, { tenantId });
      let created: Entry;
      try {
        created = await repo.create({
          userId: body.userId,
          evaluatedOn: body.evaluatedOn,
          pageCount: body.pageCount,
          createdById: actor.sub,
        });
      } catch (err) {
        mapWriteError(err);
      }

      await recordAuditInTx(tx, request.log, {
        tenantId,
        userId: actor.sub,
        action: 'evaluated_documents.create',
        entryId: created.id,
        metadata: snapshot(created),
      });
      return created;
    });

    const names = await loadVisibleNames(sql, [entry.userId, entry.createdById], visibleRoles);

    request.log.info(
      { tenantId, userId: actor.sub, entryId: entry.id, targetUserId: entry.userId, pageCount: entry.pageCount },
      'lançamento de documentos avaliados criado',
    );

    return reply.status(201).send(toItem(entry, names));
  });

  /**
   * PATCH /reports/evaluated-documents/:id — corrige um lançamento. Exige
   * justificativa e ao menos um campo com valor DIFERENTE do atual (um PATCH
   * que não muda nada seria uma correção auditada vazia). Leitura, validação,
   * UPDATE e audit na mesma transação: sem audit, sem correção.
   */
  app.patch('/reports/evaluated-documents/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN', 'MULTI_TENANT_ADMIN');

    const { id } = IdParamsSchema.parse(request.params);
    const query = TenantQuerySchema.parse(request.query);
    const body = UpdateBodySchema.parse(request.body);
    const tenantId = resolveScopedTenantId(request, query.tenantId);

    const sql = app.db;
    const actor = request.user!;
    const visibleRoles = rolesVisibleTo(actor.role);

    const result = await sql.begin(async (tx) => {
      const repo = new EvaluatedDocumentEntriesRepository(tx, { tenantId });

      const current = await repo.findById(id);
      if (current === null) return null;

      const userIdChanged = body.userId !== undefined && body.userId !== current.userId;
      const evaluatedOnChanged = body.evaluatedOn !== undefined && body.evaluatedOn !== current.evaluatedOn;
      const pageCountChanged = body.pageCount !== undefined && body.pageCount !== current.pageCount;
      if (!userIdChanged && !evaluatedOnChanged && !pageCountChanged) {
        throw new ValidationError('Nenhuma alteração em relação ao lançamento atual');
      }

      // Só valida o usuário quando ele MUDA: reenviar o mesmo userId de um
      // usuário hoje inativo (ou promovido a papel global) não pode travar a
      // correção de páginas/data. Quando muda, é a única barreira de empresa.
      if (userIdChanged && (await findSelectableUser(tx, tenantId, visibleRoles, body.userId!)) === null) {
        throw new NotFoundError('Usuário não encontrado');
      }

      let updated: Awaited<ReturnType<EvaluatedDocumentEntriesRepository['update']>>;
      try {
        updated = await repo.update(id, {
          ...(userIdChanged ? { userId: body.userId! } : {}),
          ...(evaluatedOnChanged ? { evaluatedOn: body.evaluatedOn! } : {}),
          ...(pageCountChanged ? { pageCount: body.pageCount! } : {}),
          updatedById: actor.sub,
        });
      } catch (err) {
        mapWriteError(err);
      }
      if (updated === null) return null;

      await recordAuditInTx(tx, request.log, {
        tenantId,
        userId: actor.sub,
        action: 'evaluated_documents.update',
        entryId: id,
        metadata: {
          justification: body.justification,
          before: snapshot(updated.before),
          after: snapshot(updated.after),
        },
      });
      return updated;
    });

    if (result === null) {
      throw new NotFoundError('Lançamento não encontrado');
    }

    const names = await loadVisibleNames(sql, [result.after.userId, result.after.createdById], visibleRoles);

    request.log.info(
      { tenantId, userId: actor.sub, entryId: id, before: snapshot(result.before), after: snapshot(result.after) },
      'lançamento de documentos avaliados corrigido',
    );

    return reply.status(200).send(toItem(result.after, names));
  });

  /**
   * DELETE /reports/evaluated-documents/:id — exclusão lógica com
   * justificativa no corpo JSON (`{ justification }`). 204 sem corpo.
   * Soft delete e audit na mesma transação.
   */
  app.delete('/reports/evaluated-documents/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'TENANT_ADMIN', 'MULTI_TENANT_ADMIN');

    const { id } = IdParamsSchema.parse(request.params);
    const query = TenantQuerySchema.parse(request.query);
    const body = DeleteBodySchema.parse(request.body);
    const tenantId = resolveScopedTenantId(request, query.tenantId);

    const actor = request.user!;

    const deleted = await app.db.begin(async (tx) => {
      const repo = new EvaluatedDocumentEntriesRepository(tx, { tenantId });
      const removed = await repo.softDelete(id, actor.sub);
      if (removed === null) return null;

      await recordAuditInTx(tx, request.log, {
        tenantId,
        userId: actor.sub,
        action: 'evaluated_documents.delete',
        entryId: id,
        metadata: { justification: body.justification, before: snapshot(removed) },
      });
      return removed;
    });

    if (deleted === null) {
      throw new NotFoundError('Lançamento não encontrado');
    }

    request.log.info(
      { tenantId, userId: actor.sub, entryId: id, before: snapshot(deleted) },
      'lançamento de documentos avaliados excluído',
    );

    return reply.status(204).send();
  });
};
