import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { newId, type Sql } from '@dmdoc/db-pg';
import { TenantDeletionJobDataSchema } from '@dmdoc/shared-types';
import {
  buildStorageDriver,
  encryptSecret,
  parseSecretKey,
  parseStorageTarget,
  storageLocationKey,
  type ResolvedStorageTarget,
  type S3Config,
  type StorageDriver,
} from '@dmdoc/storage';
import {
  ConflictError,
  NotFoundError,
  UpstreamServiceError,
  ValidationError,
} from '../../errors/index.js';
import { requireRole } from '../../auth/role-guard.js';
import { AuditLogger } from '../../auth/audit.js';
import { applyTemplateToTenant } from '../../lib/apply-template-to-tenant.js';
import type { Config } from '../../config.js';
import {
  buildPlatformS3Config,
  classifyStorageTestError,
  maskStorageSecrets,
  parseStorageConfigBody,
  sameStorageConfig,
  toDesiredConfig,
  type DesiredStorageConfig,
  type StorageDriverFactory,
  type StorageTestFailure,
} from '../../lib/storage-admin.js';

const CreateTenantBodySchema = z.object({
  name: z.string().min(1).max(200),
  diskQuotaBytes: z.number().int().nonnegative().default(10 * 1024 ** 3),
  userQuota: z.number().int().nonnegative().default(20),
  /** UUID de um template de departamentos a aplicar ao novo tenant (opcional). */
  templateId: z.string().uuid().optional(),
});

const PatchTenantBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  diskQuotaBytes: z.number().int().nonnegative().optional(),
  userQuota: z.number().int().nonnegative().optional(),
  active: z.boolean().optional(),
  // Toggles por empresa das features de IA de sugestão (Fases 7/8/8.1) — plus
  // comercial gerido exclusivamente pelo SUPER_ADMIN, no mesmo fluxo de
  // edição de empresa usado para cotas. Ver `packages/shared-types/src/tenant.ts`.
  aiClassificationEnabled: z.boolean().optional(),
  aiTitleSuggestionEnabled: z.boolean().optional(),
  aiIndexSuggestionEnabled: z.boolean().optional(),
  aiTagGenerationEnabled: z.boolean().optional(),
  aiTagAutoApplyEnabled: z.boolean().optional(),
  aiClassificationAutoApplyEnabled: z.boolean().optional(),
  aiTitleAutoApplyEnabled: z.boolean().optional(),
  aiIndexAutoApplyEnabled: z.boolean().optional(),
});

const ListTenantsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(20),
  cursor: z.string().optional(),
});

const TenantIdParamsSchema = z.object({ id: z.string().uuid() });

/**
 * Linha de `tenant_storage_configs` como o postgres.js devolve (snake_case).
 * `config` já chega desserializado — jsonb gravado com `sql.json(...)`.
 */
interface StorageConfigRow {
  id: string;
  provider: string;
  credentials_source: string;
  config: unknown;
  encrypted_secret: string | null;
  created_at: Date;
  retired_at: Date | null;
}

/** Um destino aposentado que ainda tem arquivos, como a tela o exibe. */
interface PreviousDestination {
  /** `null` é o S3 da plataforma (`documents.storage_config_id IS NULL`). */
  id: string | null;
  provider: string;
  credentialsSource: string;
  config: unknown;
  retiredAt: Date | null;
  documentCount: number;
}

export interface AdminTenantsRoutesOptions {
  config: Config;
  /**
   * Fábrica de driver usada SÓ pelo "Testar conexão" — o único lugar que
   * constrói um driver a partir de uma configuração que ainda não está no
   * banco. Injetável para que o teste exercite a rota sem abrir socket; em
   * produção é `buildStorageDriver` com a config S3 da plataforma.
   */
  buildStorageDriver?: StorageDriverFactory;
}

/**
 * Rotas de administração de tenants. Apenas SUPER_ADMIN acessa.
 *
 * A tabela `tenants` não usa TenantRepository (não tem tenantId próprio nem
 * soft-delete). Operações via SQL direto.
 */
export const adminTenantsRoutes: FastifyPluginAsync<AdminTenantsRoutesOptions> = async (
  app,
  options
) => {
  // Chave mestra e bucket da plataforma são resolvidos UMA vez, no registro do
  // plugin: `parseSecretKey` valida o formato e falhar aqui (no boot) é muito
  // melhor do que no primeiro PUT de um cliente.
  const secretKey = parseSecretKey(options.config.STORAGE_SECRET_KEY);
  const platformS3Config = buildPlatformS3Config(options.config);
  const makeDriver: StorageDriverFactory =
    options.buildStorageDriver ??
    ((target: ResolvedStorageTarget): StorageDriver =>
      buildStorageDriver(target, { platformS3Config }));

  /**
   * POST /admin/tenants — cria nova empresa.
   *
   * `templateId` opcional: quando informado, os nós do template são inseridos
   * como departamentos reais do novo tenant dentro da mesma transação.
   * Se o templateId não existir, a transação inteira é revertida.
   */
  app.post('/admin/tenants', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'SUPER_ADMIN');

    const { name, diskQuotaBytes, userQuota, templateId } = CreateTenantBodySchema.parse(request.body);
    const sql = app.db;

    const tenantId = newId();
    const createdAt = new Date();

    await sql.begin(async (tx) => {
      try {
        await tx`
          INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
          VALUES (${tenantId}, ${name}, ${diskQuotaBytes}, ${userQuota}, true, ${createdAt})
        `;
      } catch (err: unknown) {
        const pgErr = err as { code?: string };
        if (pgErr.code === '23505') {
          throw new ConflictError('Nome de empresa já em uso');
        }
        throw err;
      }

      if (templateId !== undefined) {
        await applyTemplateToTenant(tx as unknown as typeof sql, tenantId, templateId, request.log);
      }
    });

    if (templateId !== undefined) {
      request.log.info({ tenantId, templateId }, 'tenant criado com template');
    } else {
      request.log.info({ tenantId }, 'tenant criado');
    }

    return reply.status(201).send({ id: tenantId, name, diskQuotaBytes, userQuota, active: true, createdAt });
  });

  /**
   * GET /admin/tenants — lista empresas com paginação por cursor.
   */
  app.get('/admin/tenants', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'SUPER_ADMIN');

    const { limit, cursor } = ListTenantsQuerySchema.parse(request.query);
    const sql = app.db;

    type TenantRow = {
      id: string;
      name: string;
      disk_quota_bytes: string;
      user_quota: number;
      active: boolean;
      created_at: Date;
      ai_classification_enabled: boolean;
      ai_title_suggestion_enabled: boolean;
      ai_index_suggestion_enabled: boolean;
      ai_tag_generation_enabled: boolean;
      ai_tag_auto_apply_enabled: boolean;
      ai_classification_auto_apply_enabled: boolean;
      ai_title_auto_apply_enabled: boolean;
      ai_index_auto_apply_enabled: boolean;
    };

    let rows: TenantRow[];
    if (cursor !== undefined) {
      rows = await sql<TenantRow[]>`
        SELECT id, name, disk_quota_bytes, user_quota, active, created_at,
               ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled, ai_tag_generation_enabled, ai_tag_auto_apply_enabled, ai_classification_auto_apply_enabled, ai_title_auto_apply_enabled, ai_index_auto_apply_enabled
        FROM tenants
        WHERE deleted = false AND id > ${cursor}
        ORDER BY id ASC
        LIMIT ${limit + 1}
      `;
    } else {
      rows = await sql<TenantRow[]>`
        SELECT id, name, disk_quota_bytes, user_quota, active, created_at,
               ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled, ai_tag_generation_enabled, ai_tag_auto_apply_enabled, ai_classification_auto_apply_enabled, ai_title_auto_apply_enabled, ai_index_auto_apply_enabled
        FROM tenants
        WHERE deleted = false
        ORDER BY id ASC
        LIMIT ${limit + 1}
      `;
    }

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    const nextCursor = hasMore && last ? last.id : null;

    const items = page.map((r) => ({
      id: r.id,
      name: r.name,
      diskQuotaBytes: Number(r.disk_quota_bytes),
      userQuota: r.user_quota,
      active: r.active,
      createdAt: r.created_at,
      aiClassificationEnabled: r.ai_classification_enabled,
      aiTitleSuggestionEnabled: r.ai_title_suggestion_enabled,
      aiIndexSuggestionEnabled: r.ai_index_suggestion_enabled,
      aiTagGenerationEnabled: r.ai_tag_generation_enabled,
      aiTagAutoApplyEnabled: r.ai_tag_auto_apply_enabled,
      aiClassificationAutoApplyEnabled: r.ai_classification_auto_apply_enabled,
      aiTitleAutoApplyEnabled: r.ai_title_auto_apply_enabled,
      aiIndexAutoApplyEnabled: r.ai_index_auto_apply_enabled,
    }));

    return reply.status(200).send({ items, nextCursor });
  });

  /**
   * PATCH /admin/tenants/:id — atualiza campos da empresa.
   */
  app.patch('/admin/tenants/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'SUPER_ADMIN');

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const updates = PatchTenantBodySchema.parse(request.body);
    const sql = app.db;

    type TenantRow = {
      id: string;
      name: string;
      disk_quota_bytes: string;
      user_quota: number;
      active: boolean;
      created_at: Date;
      ai_classification_enabled: boolean;
      ai_title_suggestion_enabled: boolean;
      ai_index_suggestion_enabled: boolean;
      ai_tag_generation_enabled: boolean;
      ai_tag_auto_apply_enabled: boolean;
      ai_classification_auto_apply_enabled: boolean;
      ai_title_auto_apply_enabled: boolean;
      ai_index_auto_apply_enabled: boolean;
    };

    const toResponse = (r: TenantRow) => ({
      id: r.id,
      name: r.name,
      diskQuotaBytes: Number(r.disk_quota_bytes),
      userQuota: r.user_quota,
      active: r.active,
      createdAt: r.created_at,
      aiClassificationEnabled: r.ai_classification_enabled,
      aiTitleSuggestionEnabled: r.ai_title_suggestion_enabled,
      aiIndexSuggestionEnabled: r.ai_index_suggestion_enabled,
      aiTagGenerationEnabled: r.ai_tag_generation_enabled,
      aiTagAutoApplyEnabled: r.ai_tag_auto_apply_enabled,
      aiClassificationAutoApplyEnabled: r.ai_classification_auto_apply_enabled,
      aiTitleAutoApplyEnabled: r.ai_title_auto_apply_enabled,
      aiIndexAutoApplyEnabled: r.ai_index_auto_apply_enabled,
    });

    if (Object.keys(updates).length === 0) {
      const rows = await sql<TenantRow[]>`
        SELECT id, name, disk_quota_bytes, user_quota, active, created_at,
               ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled, ai_tag_generation_enabled, ai_tag_auto_apply_enabled, ai_classification_auto_apply_enabled, ai_title_auto_apply_enabled, ai_index_auto_apply_enabled
        FROM tenants
        WHERE id = ${id}
        LIMIT 1
      `;
      if (rows.length === 0) throw new NotFoundError();
      return reply.status(200).send(toResponse(rows[0]!));
    }

    // Todos os campos deste endpoint são administrados exclusivamente pelo
    // SUPER_ADMIN e são dados sensíveis da empresa (nome, cotas, ativa/inativa e
    // as 3 flags de IA). Capturamos o estado ANTES da atualização sempre que ao
    // menos um campo auditável é enviado, para registrar o diff antes/depois no
    // AuditLog (mesmo padrão de `PATCH /admin/platform-settings`). Ver spec §10.
    const touchesAiFlags =
      updates.aiClassificationEnabled !== undefined ||
      updates.aiTitleSuggestionEnabled !== undefined ||
      updates.aiIndexSuggestionEnabled !== undefined ||
      updates.aiTagGenerationEnabled !== undefined ||
      updates.aiTagAutoApplyEnabled !== undefined ||
      updates.aiClassificationAutoApplyEnabled !== undefined ||
      updates.aiTitleAutoApplyEnabled !== undefined ||
      updates.aiIndexAutoApplyEnabled !== undefined;
    const touchesSettings =
      updates.name !== undefined ||
      updates.diskQuotaBytes !== undefined ||
      updates.userQuota !== undefined ||
      updates.active !== undefined;

    let before: TenantRow | undefined;
    if (touchesAiFlags || touchesSettings) {
      const beforeRows = await sql<TenantRow[]>`
        SELECT id, name, disk_quota_bytes, user_quota, active, created_at,
               ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled, ai_tag_generation_enabled, ai_tag_auto_apply_enabled, ai_classification_auto_apply_enabled, ai_title_auto_apply_enabled, ai_index_auto_apply_enabled
        FROM tenants
        WHERE id = ${id}
        LIMIT 1
      `;
      before = beforeRows[0];
      // Se o tenant não existe, não interrompe aqui: o UPDATE abaixo também
      // não afeta nenhuma linha e cai no NotFoundError já existente, mantendo
      // uma única fonte de verdade para o 404.
    }

    // Monta SET dinâmico apenas com os campos fornecidos
    const setParts: string[] = [];
    const values: unknown[] = [id];
    let paramIdx = 2;

    if (updates.name !== undefined) {
      setParts.push(`name = $${paramIdx++}`);
      values.push(updates.name);
    }
    if (updates.diskQuotaBytes !== undefined) {
      setParts.push(`disk_quota_bytes = $${paramIdx++}`);
      values.push(updates.diskQuotaBytes);
    }
    if (updates.userQuota !== undefined) {
      setParts.push(`user_quota = $${paramIdx++}`);
      values.push(updates.userQuota);
    }
    if (updates.active !== undefined) {
      setParts.push(`active = $${paramIdx++}`);
      values.push(updates.active);
    }
    if (updates.aiClassificationEnabled !== undefined) {
      setParts.push(`ai_classification_enabled = $${paramIdx++}`);
      values.push(updates.aiClassificationEnabled);
    }
    if (updates.aiTitleSuggestionEnabled !== undefined) {
      setParts.push(`ai_title_suggestion_enabled = $${paramIdx++}`);
      values.push(updates.aiTitleSuggestionEnabled);
    }
    if (updates.aiIndexSuggestionEnabled !== undefined) {
      setParts.push(`ai_index_suggestion_enabled = $${paramIdx++}`);
      values.push(updates.aiIndexSuggestionEnabled);
    }
    if (updates.aiTagGenerationEnabled !== undefined) {
      setParts.push(`ai_tag_generation_enabled = $${paramIdx++}`);
      values.push(updates.aiTagGenerationEnabled);
    }
    if (updates.aiTagAutoApplyEnabled !== undefined) {
      setParts.push(`ai_tag_auto_apply_enabled = $${paramIdx++}`);
      values.push(updates.aiTagAutoApplyEnabled);
    }
    if (updates.aiClassificationAutoApplyEnabled !== undefined) {
      setParts.push(`ai_classification_auto_apply_enabled = $${paramIdx++}`);
      values.push(updates.aiClassificationAutoApplyEnabled);
    }
    if (updates.aiTitleAutoApplyEnabled !== undefined) {
      setParts.push(`ai_title_auto_apply_enabled = $${paramIdx++}`);
      values.push(updates.aiTitleAutoApplyEnabled);
    }
    if (updates.aiIndexAutoApplyEnabled !== undefined) {
      setParts.push(`ai_index_auto_apply_enabled = $${paramIdx++}`);
      values.push(updates.aiIndexAutoApplyEnabled);
    }

    const query = `
      UPDATE tenants
      SET ${setParts.join(', ')}
      WHERE id = $1
      RETURNING id, name, disk_quota_bytes, user_quota, active, created_at,
                ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled, ai_tag_generation_enabled, ai_tag_auto_apply_enabled, ai_classification_auto_apply_enabled, ai_title_auto_apply_enabled, ai_index_auto_apply_enabled
    `;

    let rows: TenantRow[];
    try {
      rows = await sql.unsafe<TenantRow[]>(query, values as Parameters<typeof sql.unsafe>[1]);
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        throw new ConflictError('Nome de empresa já em uso');
      }
      throw err;
    }

    if (rows.length === 0) throw new NotFoundError();
    const r = rows[0]!;

    const auditLogger = new AuditLogger(sql);

    // AuditLog #1 — flags de IA (plus comercial por empresa, ver
    // `packages/shared-types/src/tenant.ts`). Registra o ator (userId + role),
    // o tenant afetado, e o diff antes/depois apenas dos campos de IA
    // efetivamente informados no PATCH. Ver spec §10, invariante 7.
    if (before !== undefined) {
      const changes: Record<string, { before: boolean; after: boolean }> = {};
      if (updates.aiClassificationEnabled !== undefined) {
        changes['aiClassificationEnabled'] = {
          before: before.ai_classification_enabled,
          after: r.ai_classification_enabled,
        };
      }
      if (updates.aiTitleSuggestionEnabled !== undefined) {
        changes['aiTitleSuggestionEnabled'] = {
          before: before.ai_title_suggestion_enabled,
          after: r.ai_title_suggestion_enabled,
        };
      }
      if (updates.aiIndexSuggestionEnabled !== undefined) {
        changes['aiIndexSuggestionEnabled'] = {
          before: before.ai_index_suggestion_enabled,
          after: r.ai_index_suggestion_enabled,
        };
      }
      if (updates.aiTagGenerationEnabled !== undefined) {
        changes['aiTagGenerationEnabled'] = {
          before: before.ai_tag_generation_enabled,
          after: r.ai_tag_generation_enabled,
        };
      }
      if (updates.aiTagAutoApplyEnabled !== undefined) {
        changes['aiTagAutoApplyEnabled'] = {
          before: before.ai_tag_auto_apply_enabled,
          after: r.ai_tag_auto_apply_enabled,
        };
      }
      if (updates.aiClassificationAutoApplyEnabled !== undefined) {
        changes['aiClassificationAutoApplyEnabled'] = {
          before: before.ai_classification_auto_apply_enabled,
          after: r.ai_classification_auto_apply_enabled,
        };
      }
      if (updates.aiTitleAutoApplyEnabled !== undefined) {
        changes['aiTitleAutoApplyEnabled'] = {
          before: before.ai_title_auto_apply_enabled,
          after: r.ai_title_auto_apply_enabled,
        };
      }
      if (updates.aiIndexAutoApplyEnabled !== undefined) {
        changes['aiIndexAutoApplyEnabled'] = {
          before: before.ai_index_auto_apply_enabled,
          after: r.ai_index_auto_apply_enabled,
        };
      }

      if (Object.keys(changes).length > 0) {
        try {
          await auditLogger.record({
            tenantId: id,
            userId: request.user?.sub ?? null,
            action: 'tenant.ai_settings.update',
            resource: `tenants/${id}`,
            metadata: { actorRole: request.user?.role ?? null, changes },
          });
        } catch (auditError) {
          request.log.error(
            { err: auditError, tenantId: id, userId: request.user?.sub ?? null },
            'falha ao registrar audit log de atualização de configuração de IA do tenant',
          );
        }
      }
    }

    // AuditLog #2 — dados administrativos da empresa (nome, cotas, ativa/inativa).
    // São dados sensíveis geridos pelo SUPER_ADMIN e, pela mesma invariante de
    // auditoria de mudanças administrativas (spec §10), passam a ser auditados
    // com o MESMO padrão de diff antes/depois das flags de IA. Ação separada
    // (`tenant.settings.update`) para não misturar o diff comercial de IA com o
    // diff administrativo.
    if (before !== undefined) {
      const changes: Record<string, { before: unknown; after: unknown }> = {};
      if (updates.name !== undefined) {
        changes['name'] = { before: before.name, after: r.name };
      }
      if (updates.diskQuotaBytes !== undefined) {
        changes['diskQuotaBytes'] = {
          before: Number(before.disk_quota_bytes),
          after: Number(r.disk_quota_bytes),
        };
      }
      if (updates.userQuota !== undefined) {
        changes['userQuota'] = { before: before.user_quota, after: r.user_quota };
      }
      if (updates.active !== undefined) {
        changes['active'] = { before: before.active, after: r.active };
      }

      if (Object.keys(changes).length > 0) {
        try {
          await auditLogger.record({
            tenantId: id,
            userId: request.user?.sub ?? null,
            action: 'tenant.settings.update',
            resource: `tenants/${id}`,
            metadata: { actorRole: request.user?.role ?? null, changes },
          });
        } catch (auditError) {
          request.log.error(
            { err: auditError, tenantId: id, userId: request.user?.sub ?? null },
            'falha ao registrar audit log de atualização administrativa do tenant',
          );
        }
      }
    }

    request.log.info({ tenantId: id }, 'tenant atualizado');
    return reply.status(200).send(toResponse(r));
  });

  /**
   * DELETE /admin/tenants/:id — exclui (soft-delete) uma empresa e enfileira a
   * purga definitiva em background.
   *
   * O endpoint apenas marca o tenant e enfileira o job na fila `tenant-deletion`
   * — ele NÃO executa a purga (S3, dados) diretamente; isso é responsabilidade
   * do worker. A empresa é marcada `deleted=true`/`active=false` e o nome é
   * renomeado (libera o índice único de nome imediatamente para reuso).
   *
   * Idempotência: como o UPDATE usa `AND deleted = false`, re-disparar sobre um
   * tenant já excluído cai no 404 (já está deleted).
   */
  app.delete('/admin/tenants/:id', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'SUPER_ADMIN');

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const sql = app.db;

    // Marca + renomeia em transação. O `RETURNING` só traz linha se o tenant
    // existia e ainda não estava deleted — combina existência e idempotência.
    const updated = await sql.begin(async (tx) => {
      return tx<Array<{ id: string }>>`
        UPDATE tenants
        SET active = false,
            deleted = true,
            deleted_at = now(),
            name = '[EXCLUÍDA-' || extract(epoch from now())::bigint || '] ' || name
        WHERE id = ${id} AND deleted = false
        RETURNING id
      `;
    });

    if (updated.length === 0) {
      throw new NotFoundError();
    }

    // Enfileira o job de purga. Em testes a fila é null — apenas loga e segue.
    if (app.tenantDeletionQueue !== null) {
      const jobData = TenantDeletionJobDataSchema.parse({ tenantId: id });
      await app.tenantDeletionQueue.add('purge', jobData, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      });
    } else {
      request.log.warn({ tenantId: id }, 'tenantDeletionQueue não configurada — purga não enfileirada');
    }

    // AuditLog da solicitação de exclusão.
    const auditLogger = new AuditLogger(sql);
    try {
      await auditLogger.record({
        tenantId: id,
        userId: request.user?.sub ?? null,
        action: 'tenant.delete.requested',
        resource: `tenants/${id}`,
        metadata: {},
      });
    } catch (auditError) {
      request.log.error(
        { err: auditError, tenantId: id, userId: request.user?.sub ?? null },
        'falha ao registrar audit log de exclusão de tenant',
      );
    }

    request.log.info({ tenantId: id }, 'tenant marcado para exclusão e purga enfileirada');
    return reply.status(202).send({ id, status: 'deleting' });
  });

  // =========================================================================
  // Destino de armazenamento da empresa (épico E-11 / T-140)
  // =========================================================================
  //
  // Os três endpoints abaixo são exclusivos do SUPER_ADMIN — o TENANT_ADMIN não
  // tem acesso NEM DE LEITURA, pela mesma razão das flags de IA: onde os
  // arquivos de um cliente ficam é decisão comercial e operacional da
  // plataforma sobre aquele cliente, não uma preferência que ele ajusta. E a
  // leitura, aqui, revelaria bucket, endpoint e siteId do destino.

  /**
   * GET /admin/tenants/:id/storage — configuração de armazenamento vigente.
   *
   * Empresa sem linha ativa responde o DEFAULT (`s3`/`platform`), nunca 404: a
   * ausência de linha é um estado válido e é o de todas as empresas anteriores
   * ao épico (ver migration `0017_tenant_storage.sql`, "sem backfill").
   *
   * O segredo nunca sai — só `secretConfigured`.
   */
  app.get('/admin/tenants/:id/storage', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'SUPER_ADMIN');

    const { id } = TenantIdParamsSchema.parse(request.params);
    const sql = app.db;

    await assertTenantExists(sql, id);

    return reply.status(200).send(await buildStorageResponse(sql, id));
  });

  /**
   * PUT /admin/tenants/:id/storage — troca o destino da empresa.
   *
   * ⚠️ NUNCA um `UPDATE` dos campos de configuração de uma linha existente. A
   * troca é, numa transação: aposentar a ativa (`active = false`,
   * `retired_at = now()`) e INSERIR uma linha nova. Documentos já gravados
   * apontam para a linha antiga pelo `storage_config_id` e precisam dela — com
   * as credenciais dela — para continuarem legíveis. Sobrescrever a linha
   * apagaria o endereço de onde aqueles arquivos realmente estão; é exatamente
   * a perda de dados que a ADR-1 do épico corrigiu.
   */
  app.put('/admin/tenants/:id/storage', { preHandler: app.authenticate }, async (request, reply) => {
    requireRole(request, 'SUPER_ADMIN');

    const { id } = TenantIdParamsSchema.parse(request.params);
    const desired = toDesiredConfig(parseStorageConfigBody(request.body));
    const sql = app.db;

    await assertTenantExists(sql, id);

    // ⚠️ Guarda da T-141. Trocar o destino embaixo de uma migração em curso faz
    // o job convergir para um alvo que mudou no meio do caminho: parte do
    // acervo termina no destino que deixou de ser o ativo, e o `cleanup-source`
    // passa a ver documentos em três lugares. A guarda mora aqui porque é a
    // partir da T-141 que `storage_migrations` tem linhas vivas.
    if ((await loadActiveMigration(sql, id)) !== undefined) {
      throw new ConflictError(
        'Há uma migração de acervo em andamento nesta empresa. Conclua ou cancele a migração antes de trocar o destino.'
      );
    }

    const current = await loadActiveStorageConfig(sql, id);

    // ------------------------------------------------------------------
    // Segredo: informado cifra, ausente PRESERVA (copiando o texto cifrado
    // da linha aposentada, sem decifrar nada — a chave mestra só é usada
    // para cifrar o que chega novo).
    // ------------------------------------------------------------------
    const encryptedSecret = resolveEncryptedSecret(desired, current, secretKey);

    // ------------------------------------------------------------------
    // Idempotência: configuração idêntica à ativa não versiona.
    //
    // Sem isto, cada abertura e salvamento da tela sem alteração nenhuma
    // criaria uma linha, aposentando uma configuração que documentos
    // referenciam e enchendo `previousDestinations` de destinos iguais com
    // zero arquivos. Segredo INFORMADO sempre versiona: um texto cifrado não
    // é comparável (o IV é aleatório) e rotação de credencial merece linha
    // própria no histórico, mesmo que o valor coincida.
    // ------------------------------------------------------------------
    if (isSameAsActive(desired, current)) {
      request.log.info(
        { tenantId: id, storageConfigId: current?.id ?? null },
        'configuração de storage idêntica à ativa — nada a versionar'
      );
      return reply.status(200).send(await buildStorageResponse(sql, id));
    }

    let retiredId: string | null;
    let newConfigId: string | null;
    try {
      const written = await sql.begin(async (tx) => {
        const retired = await tx<Array<{ id: string }>>`
          UPDATE tenant_storage_configs
          SET active = false, retired_at = now()
          WHERE tenant_id = ${id} AND active
          RETURNING id
        `;

        // "Voltar para o S3 da plataforma" = aposentar a ativa e NÃO inserir
        // nada. Ausência de linha ativa ≡ plataforma; inserir uma linha
        // ('s3','platform') seria uma segunda representação do mesmo estado, e
        // as duas divergiriam na primeira consulta que esquecesse uma delas.
        if (desired.credentialsSource === 'platform') {
          return { retiredId: retired[0]?.id ?? null, newConfigId: null };
        }

        const inserted = await tx<Array<{ id: string }>>`
          INSERT INTO tenant_storage_configs (tenant_id, provider, credentials_source, config, encrypted_secret)
          VALUES (
            ${id},
            ${desired.provider},
            ${desired.credentialsSource},
            ${sql.json(desired.config)},
            ${encryptedSecret}
          )
          RETURNING id
        `;
        return { retiredId: retired[0]?.id ?? null, newConfigId: inserted[0]!.id };
      });
      retiredId = written.retiredId;
      newConfigId = written.newConfigId;
    } catch (err: unknown) {
      // `uniq_tenant_storage_active` (índice único parcial): dois PUTs
      // simultâneos na mesma empresa. O perdedor é conflito, nunca 500.
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError('Outra alteração de armazenamento desta empresa está em andamento');
      }
      throw err;
    }

    // Com o cache chaveado por `storage_config_id`, a configuração nova já é um
    // id novo (miss automático) — a invalidação não é necessária para
    // correção. O que ela faz é descartar já a instância da configuração
    // APOSENTADA, para não manter viva, por até um TTL, uma credencial que o
    // operador acabou de tirar de circulação.
    if (retiredId !== null) {
      app.storage.invalidate(id, retiredId);
    }

    const auditLogger = new AuditLogger(sql);
    try {
      await auditLogger.record({
        tenantId: id,
        userId: request.user?.sub ?? null,
        action: 'tenant.storage.update',
        resource: `tenants/${id}`,
        metadata: {
          actorRole: request.user?.role ?? null,
          retiredStorageConfigId: retiredId,
          newStorageConfigId: newConfigId,
          // ⚠️ Diff MASCARADO. Audit log é lido por gente; gravar o segredo do
          // cliente aqui anularia a criptografia da coluna. O que se registra é
          // QUE o segredo mudou, nunca o valor.
          secretChanged: desired.secret !== undefined,
          changes: {
            provider: {
              before: current?.provider ?? 's3',
              after: desired.provider,
            },
            credentialsSource: {
              before: current?.credentials_source ?? 'platform',
              after: desired.credentialsSource,
            },
            config: {
              before: maskStorageSecrets(current?.config ?? {}),
              after: maskStorageSecrets(desired.config),
            },
          },
        },
      });
    } catch (auditError) {
      request.log.error(
        { err: auditError, tenantId: id, userId: request.user?.sub ?? null },
        'falha ao registrar audit log de troca de destino de armazenamento'
      );
    }

    request.log.info(
      {
        tenantId: id,
        userId: request.user?.sub ?? null,
        retiredStorageConfigId: retiredId,
        newStorageConfigId: newConfigId,
        provider: desired.provider,
      },
      'destino de armazenamento da empresa atualizado'
    );

    return reply.status(200).send(await buildStorageResponse(sql, id));
  });

  /**
   * POST /admin/tenants/:id/storage/test — testa a configuração do CORPO.
   *
   * Roda contra a configuração informada, não contra a salva: o objetivo é
   * descobrir que o `driveId` está errado ANTES de gravar, e não no primeiro
   * upload real de um usuário. Por isso usa `buildStorageDriver`, que constrói
   * o driver sem tocar no banco.
   *
   * Falha de conexão responde **200 com `ok: false`** e um código de motivo —
   * não é erro da API, é o resultado do teste. Só entrada inválida (422),
   * empresa inexistente (404) e papel errado (403) viram status de erro.
   */
  app.post(
    '/admin/tenants/:id/storage/test',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, 'SUPER_ADMIN');

      const { id } = TenantIdParamsSchema.parse(request.params);
      const desired = toDesiredConfig(parseStorageConfigBody(request.body));
      const sql = app.db;

      await assertTenantExists(sql, id);
      const current = await loadActiveStorageConfig(sql, id);

      // Segredo omitido usa o já gravado — a tela testa a configuração vigente
      // sem que o operador precise redigitar um segredo que ela nunca recebeu.
      const encryptedSecret = resolveEncryptedSecret(desired, current, secretKey);

      let driver: StorageDriver;
      try {
        // `parseStorageTarget` é o MESMO validador do caminho de produção
        // (`resolve.ts`): campo obrigatório faltando, provider desconhecido e
        // segredo ilegível falham aqui, do mesmo jeito que falhariam num upload.
        const target = parseStorageTarget(
          {
            provider: desired.provider,
            credentials_source: desired.credentialsSource,
            config: desired.config,
            encrypted_secret: encryptedSecret,
          },
          secretKey,
          id
        );
        driver = makeDriver(target);
      } catch (error) {
        request.log.warn(
          { err: error, tenantId: id },
          'configuração de storage inválida no teste de conexão'
        );
        return reply.status(200).send({ ok: false, ...classifyStorageTestError(error) });
      }

      // Chave fora de `documents/`, e com ponto na frente: se sobrar (queda no
      // meio do teste), não se confunde com arquivo de documento nenhum.
      const key = `tenants/${id}/.dmdoc-connection-test`;
      const payload = Buffer.from(`dmdoc connection test ${new Date().toISOString()}`, 'utf8');

      let wrote = false;
      let failure: StorageTestFailure | null = null;
      try {
        await driver.put({ key, buffer: payload, mimeType: 'text/plain' });
        wrote = true;
        const readBack = await driver.get(key);
        if (!readBack.equals(payload)) {
          failure = {
            code: 'CONTENT_MISMATCH',
            message:
              'O destino aceitou a gravação mas devolveu um conteúdo diferente do enviado. Confira se o bucket/pasta não é servido por um proxy ou cache.',
          };
        }
      } catch (error) {
        request.log.warn(
          { err: error, tenantId: id, provider: driver.provider },
          'teste de conexão com o destino de armazenamento falhou'
        );
        failure = classifyStorageTestError(error);
      } finally {
        // Não deixar o arquivo de teste para trás. DUAS situações pedem a
        // remoção, e só a primeira é óbvia:
        //
        // 1. a gravação deu certo — com ou sem falha depois dela (é o caso do
        //    `CONTENT_MISMATCH`, em que o objeto está lá e só o conteúdo não
        //    confere);
        // 2. a gravação falhou com um erro AMBÍGUO (timeout, conexão cortada,
        //    5xx do provedor). O `put` não voltou, mas o objeto pode ter sido
        //    criado do outro lado assim mesmo — e um resíduo na biblioteca do
        //    cliente é exatamente o tipo de arquivo que ninguém, meses depois,
        //    consegue ligar a este endpoint.
        //
        // Credencial recusada, permissão negada e destino inexistente ficam de
        // fora de propósito: ali o provedor recusou ANTES de gravar, não há o
        // que remover, e uma remoção especulativa só produziria um segundo erro
        // idêntico no log — justamente no caminho de falha mais comum.
        const speculative = !wrote && failure?.code === 'UNKNOWN';
        if (wrote || speculative) {
          try {
            await driver.delete(key);
          } catch (cleanupError) {
            // Best-effort: a falha da limpeza não transforma um teste
            // bem-sucedido em erro. Ela é `warn` quando SABEMOS que o arquivo
            // existe, e `debug` na tentativa especulativa — em que o erro
            // esperado é o mesmo que já derrubou a gravação.
            const logFields = { err: cleanupError, tenantId: id, key, speculative };
            const logMessage = 'não foi possível remover o arquivo de teste de conexão';
            if (speculative) {
              request.log.debug(logFields, logMessage);
            } else {
              request.log.warn(logFields, logMessage);
            }
          }
        }
      }

      if (failure !== null) {
        return reply.status(200).send({ ok: false, ...failure });
      }

      request.log.info(
        { tenantId: id, userId: request.user?.sub ?? null, provider: driver.provider },
        'teste de conexão com o destino de armazenamento bem-sucedido'
      );
      return reply.status(200).send({
        ok: true,
        provider: driver.provider,
        checkedAt: new Date().toISOString(),
      });
    }
  );

  // =========================================================================
  // Migração de acervo entre destinos (épico E-11 / T-141)
  // =========================================================================
  //
  // A migração roda DEPOIS da troca de destino, nunca antes: uploads novos já
  // vão para o destino novo (o `PUT` acima) enquanto o backlog é alcançado em
  // segundo plano. Como cada documento carrega seu `storage_config_id`, os dois
  // acervos convivem sem janela de inconsistência — o download resolve o driver
  // por documento (`forStorageConfig`), não pelo destino corrente da empresa.

  /**
   * POST /admin/tenants/:id/storage/migrate — dispara a migração.
   *
   * Cria a linha em `storage_migrations` e enfileira o job. **409 quando já há
   * uma ativa**: a garantia real é o índice único parcial
   * `uniq_storage_migration_running` (duas requisições simultâneas competem no
   * banco, não na aplicação); o 409 é a tradução amigável do 23505.
   *
   * Enfileirar DEPOIS do INSERT é deliberado: um job para uma linha que não
   * existe falharia sem deixar rastro no banco, enquanto uma linha sem job fica
   * visível na tela (`PENDING` que não anda) e é cancelável.
   */
  app.post(
    '/admin/tenants/:id/storage/migrate',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, 'SUPER_ADMIN');

      const { id } = TenantIdParamsSchema.parse(request.params);
      const sql = app.db;

      await assertTenantExists(sql, id);

      const destination = await loadDestination(sql, id);
      const sources = await loadPendingSources(sql, id, destination.storageConfigId);
      const totalDocs = sources.reduce((sum, source) => sum + source.documentCount, 0);

      // `from_provider`/`to_provider` são DESCRITIVOS — rótulo da migração em
      // tela e no histórico. Nada aqui decide o que migrar (isso é
      // `storage_config_id`), e é por isso que uma migração s3 → s3 tem os dois
      // iguais sem que isso signifique "nada a fazer".
      const fromProvider =
        [...new Set(sources.map((source) => source.provider))].sort().join('+') ||
        destination.provider;

      let migration: StorageMigrationRow;
      try {
        const inserted = await sql<StorageMigrationRow[]>`
          INSERT INTO storage_migrations (tenant_id, from_provider, to_provider, status)
          VALUES (${id}, ${fromProvider}, ${destination.provider}, 'PENDING')
          RETURNING id, status, from_provider, to_provider, total_docs, migrated_docs,
                    failed_docs, last_error, started_at, finished_at, created_at
        `;
        migration = inserted[0]!;
      } catch (err: unknown) {
        if ((err as { code?: string }).code === '23505') {
          throw new ConflictError(
            'Já existe uma migração de acervo em andamento nesta empresa. Acompanhe o progresso ou cancele-a antes de disparar outra.'
          );
        }
        throw err;
      }

      if (app.storageMigrationQueue !== null) {
        try {
          // `jobId` = id da migração: o BullMQ recusa um segundo job para a
          // mesma linha, o que fecha a porta de dois processos copiando o mesmo
          // acervo e contando progresso um por cima do outro.
          await app.storageMigrationQueue.add(
            'migrate',
            { tenantId: id, migrationId: migration.id },
            { jobId: migration.id }
          );
        } catch (queueError) {
          // Sem job não haverá progresso nenhum: encerrar a linha aqui evita
          // deixar a empresa travada por uma migração fantasma que o índice
          // único parcial manteria viva para sempre.
          await sql`
            UPDATE storage_migrations
            SET status = 'FAILED',
                last_error = 'não foi possível enfileirar o job de migração',
                finished_at = clock_timestamp()
            WHERE id = ${migration.id}
          `;
          request.log.error(
            { err: queueError, tenantId: id, migrationId: migration.id },
            'falha ao enfileirar job de migração de acervo'
          );
          throw new UpstreamServiceError(
            'Não foi possível enfileirar a migração de acervo. Tente novamente em instantes.'
          );
        }
      } else {
        request.log.warn(
          { tenantId: id, migrationId: migration.id },
          'storageMigrationQueue não configurada — migração de acervo não enfileirada'
        );
      }

      await recordAudit(request, sql, {
        tenantId: id,
        action: 'tenant.storage.migrate.requested',
        metadata: {
          actorRole: request.user?.role ?? null,
          migrationId: migration.id,
          toStorageConfigId: destination.storageConfigId,
          toProvider: destination.provider,
          fromProvider,
          totalDocs,
          // Os ids das ORIGENS: é o que permite auditar depois que a migração
          // realmente tinha o que copiar — o `total_docs = 0` fantasma da ADR-1
          // apareceria aqui como lista vazia.
          sourceStorageConfigIds: sources.map((source) => source.storageConfigId),
        },
      });

      request.log.info(
        {
          tenantId: id,
          userId: request.user?.sub ?? null,
          migrationId: migration.id,
          toStorageConfigId: destination.storageConfigId,
          totalDocs,
        },
        'migração de acervo enfileirada'
      );

      return reply.status(202).send(await buildMigrationResponse(sql, id, migration));
    }
  );

  /**
   * GET /admin/tenants/:id/storage/migrate — status e progresso.
   *
   * Devolve a migração MAIS RECENTE (ativa ou encerrada) mais o que ainda
   * depende da origem. É o endpoint que a tela consulta em intervalo regular.
   *
   * `pendingDocuments` vem da MESMA consulta que o job usa para selecionar, e
   * não dos contadores: contador é o que a migração acha que fez, esta contagem
   * é o que o banco diz que falta. Quando as duas discordam, a segunda está
   * certa.
   */
  app.get(
    '/admin/tenants/:id/storage/migrate',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, 'SUPER_ADMIN');

      const { id } = TenantIdParamsSchema.parse(request.params);
      const sql = app.db;

      await assertTenantExists(sql, id);

      const latest = await sql<StorageMigrationRow[]>`
        SELECT id, status, from_provider, to_provider, total_docs, migrated_docs,
               failed_docs, last_error, started_at, finished_at, created_at
        FROM storage_migrations
        WHERE tenant_id = ${id}
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `;

      return reply.status(200).send(await buildMigrationResponse(sql, id, latest[0]));
    }
  );

  /**
   * POST /admin/tenants/:id/storage/migrate/cancel — interrompe a migração.
   *
   * Para no documento CORRENTE: o que já foi copiado e comutado permanece no
   * destino novo, e nada é revertido. Reverter significaria copiar tudo de
   * volta — mais tempo em execução, mais chance de falhar, e nenhum ganho: o
   * acervo comutado está íntegro (o hash foi conferido) e continua servível.
   *
   * O worker observa o cancelamento entre um documento e o outro.
   */
  app.post(
    '/admin/tenants/:id/storage/migrate/cancel',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, 'SUPER_ADMIN');

      const { id } = TenantIdParamsSchema.parse(request.params);
      const sql = app.db;

      await assertTenantExists(sql, id);

      const cancelled = await sql<StorageMigrationRow[]>`
        UPDATE storage_migrations
        SET status = 'CANCELLED',
            finished_at = clock_timestamp()
        WHERE tenant_id = ${id}
          AND status IN ('PENDING', 'RUNNING')
        RETURNING id, status, from_provider, to_provider, total_docs, migrated_docs,
                  failed_docs, last_error, started_at, finished_at, created_at
      `;

      const migration = cancelled[0];
      if (migration === undefined) {
        throw new ConflictError('Não há migração de acervo em andamento nesta empresa');
      }

      await recordAudit(request, sql, {
        tenantId: id,
        action: 'tenant.storage.migrate.cancelled',
        metadata: {
          actorRole: request.user?.role ?? null,
          migrationId: migration.id,
          migratedDocs: migration.migrated_docs,
          failedDocs: migration.failed_docs,
          totalDocs: migration.total_docs,
        },
      });

      request.log.warn(
        {
          tenantId: id,
          userId: request.user?.sub ?? null,
          migrationId: migration.id,
          migratedDocs: migration.migrated_docs,
        },
        'migração de acervo cancelada'
      );

      return reply.status(200).send(await buildMigrationResponse(sql, id, migration));
    }
  );

  /**
   * POST /admin/tenants/:id/storage/cleanup-source — apaga o acervo da origem.
   *
   * ⚠️ Destrutivo e IRREVERSÍVEL, e por isso é uma ação separada da migração.
   * A migração não apaga nada: enquanto esta rota não for chamada, o destino
   * antigo segue como cópia de segurança e o cliente pode conferir o acervo no
   * destino novo com calma.
   *
   * Três guardas, nesta ordem:
   *
   * 1. **Nenhuma migração ativa.** Varrer a origem embaixo de um job que ainda
   *    está lendo dela é apagar o arquivo entre o `get` e o `put`.
   * 2. **Nenhum documento apontando para fora do destino ativo** — a MESMA
   *    consulta `IS DISTINCT FROM` da seleção. Se ela devolve uma linha sequer,
   *    existe arquivo que só é legível na origem. É esta guarda que a ADR-1
   *    salvou: a versão por `storage_provider` diria "ninguém depende da origem"
   *    numa troca s3 → s3 e apagaria o acervo inteiro.
   * 3. **Origem que é FISICAMENTE o mesmo lugar do destino não é varrida** (ver
   *    `storageLocationKey`). Uma rotação de credencial cria uma configuração
   *    nova para o MESMO bucket; varrer "a anterior" apagaria os arquivos que a
   *    migração acabou de gravar.
   */
  app.post(
    '/admin/tenants/:id/storage/cleanup-source',
    { preHandler: app.authenticate },
    async (request, reply) => {
      requireRole(request, 'SUPER_ADMIN');

      const { id } = TenantIdParamsSchema.parse(request.params);
      const sql = app.db;

      await assertTenantExists(sql, id);

      if ((await loadActiveMigration(sql, id)) !== undefined) {
        throw new ConflictError(
          'Há uma migração de acervo em andamento nesta empresa. Aguarde a conclusão antes de limpar a origem.'
        );
      }

      const destination = await loadDestination(sql, id);
      const pendingDocuments = await countPendingDocuments(sql, id, destination.storageConfigId);
      if (pendingDocuments > 0) {
        throw new ConflictError(
          `${pendingDocuments} documento(s) ainda dependem do destino anterior. ` +
            'Conclua a migração de acervo (sem falhas) antes de limpar a origem.'
        );
      }

      const targets = await loadCleanupTargets(sql, id, destination, platformS3Config);
      const sweepable = targets.filter((target) => !target.sameLocationAsDestination);
      const skipped = targets.filter((target) => target.sameLocationAsDestination);

      const results: Array<{
        storageConfigId: string | null;
        provider: string;
        ok: boolean;
        error?: string;
      }> = [];
      const prefix = `tenants/${id}/`;

      for (const target of sweepable) {
        try {
          const driver = await app.storage.forStorageConfig(id, target.storageConfigId);
          await driver.deletePrefix(prefix);
          results.push({ storageConfigId: target.storageConfigId, provider: target.provider, ok: true });
          request.log.warn(
            {
              tenantId: id,
              userId: request.user?.sub ?? null,
              storageConfigId: target.storageConfigId,
              prefix,
            },
            'acervo do destino anterior apagado (cleanup-source)'
          );
        } catch (error) {
          // Uma origem que falhou não impede as outras: o operador precisa
          // saber EXATAMENTE quais destinos ficaram para trás, e não descobrir
          // isso um por vez a cada nova tentativa.
          request.log.error(
            { err: error, tenantId: id, storageConfigId: target.storageConfigId, prefix },
            'falha ao apagar o acervo do destino anterior'
          );
          results.push({
            storageConfigId: target.storageConfigId,
            provider: target.provider,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Configuração varrida com sucesso fica no banco como HISTÓRICO (a FK
      // composta de `documents` impede apagá-la enquanto algum documento a
      // referenciar — e depois dela varrida, ninguém referencia). O que se
      // carimba é a aposentadoria, para a tela de destinos anteriores.
      const sweptIds = results
        .filter((result) => result.ok && result.storageConfigId !== null)
        .map((result) => result.storageConfigId as string);
      if (sweptIds.length > 0) {
        await sql`
          UPDATE tenant_storage_configs
          SET retired_at = COALESCE(retired_at, now())
          WHERE tenant_id = ${id}
            AND id IN ${sql(sweptIds)}
            AND active = false
        `;
      }

      await recordAudit(request, sql, {
        tenantId: id,
        action: 'tenant.storage.cleanup_source',
        metadata: {
          actorRole: request.user?.role ?? null,
          prefix,
          activeStorageConfigId: destination.storageConfigId,
          // Os ids varridos são o coração deste registro: é a única prova de
          // QUAIS destinos foram apagados numa operação sem volta.
          sweptStorageConfigIds: results.filter((r) => r.ok).map((r) => r.storageConfigId),
          failedStorageConfigIds: results.filter((r) => !r.ok).map((r) => r.storageConfigId),
          skippedStorageConfigIds: skipped.map((target) => target.storageConfigId),
          skippedReason: skipped.length > 0 ? 'MESMO_DESTINO_FISICO' : null,
        },
      });

      return reply.status(200).send({
        ok: results.every((result) => result.ok),
        prefix,
        swept: results,
        skipped: skipped.map((target) => ({
          storageConfigId: target.storageConfigId,
          provider: target.provider,
          reason: 'MESMO_DESTINO_FISICO' as const,
        })),
      });
    }
  );
};

// ---------------------------------------------------------------------------
// Auxiliares do destino de armazenamento
// ---------------------------------------------------------------------------

/**
 * 404 quando a empresa não existe (ou já foi excluída).
 *
 * Vem antes de qualquer leitura de `tenant_storage_configs`: sem isto, um id
 * inventado responderia alegremente o default da plataforma, como se a empresa
 * existisse e estivesse no bucket de sempre.
 */
async function assertTenantExists(sql: Sql, tenantId: string): Promise<void> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT id FROM tenants WHERE id = ${tenantId} AND deleted = false LIMIT 1
  `;
  if (rows.length === 0) throw new NotFoundError('Empresa não encontrada');
}

/** Linha ATIVA da empresa, ou `undefined` quando ela está no S3 da plataforma. */
async function loadActiveStorageConfig(
  sql: Sql,
  tenantId: string
): Promise<StorageConfigRow | undefined> {
  const rows = await sql<StorageConfigRow[]>`
    SELECT id, provider, credentials_source, config, encrypted_secret, created_at, retired_at
    FROM tenant_storage_configs
    WHERE tenant_id = ${tenantId} AND active
    LIMIT 1
  `;
  return rows[0];
}

/**
 * Texto cifrado a gravar na linha nova.
 *
 * - segredo informado → cifra agora;
 * - segredo ausente com a MESMA origem (mesmo provider e `tenant`) → copia o
 *   texto cifrado da linha ativa, sem decifrar;
 * - segredo ausente sem nada compatível para copiar → 422. Trocar de provider
 *   (ou sair da plataforma) sem informar o segredo produziria uma linha
 *   `credentials_source = 'tenant'` sem `encrypted_secret`, que o
 *   `parseStorageTarget` recusa — um cadastro "salvo com sucesso" que quebra
 *   todo upload seguinte.
 */
function resolveEncryptedSecret(
  desired: DesiredStorageConfig,
  current: StorageConfigRow | undefined,
  secretKey: Buffer
): string | null {
  if (desired.credentialsSource === 'platform') return null;
  if (desired.secret !== undefined) return encryptSecret(desired.secret, secretKey);

  const reusable =
    current !== undefined &&
    current.credentials_source === 'tenant' &&
    current.provider === desired.provider &&
    current.encrypted_secret !== null &&
    current.encrypted_secret.length > 0;

  if (reusable) return current.encrypted_secret;

  throw new ValidationError(
    desired.provider === 'sharepoint'
      ? 'clientSecret é obrigatório: não há segredo do SharePoint gravado para esta empresa'
      : 'secretAccessKey é obrigatório: não há segredo gravado para esta empresa neste provedor'
  );
}

/**
 * A configuração pedida já é a vigente?
 *
 * Segredo informado NUNCA é considerado igual (ver comentário na rota). O caso
 * "plataforma" tem duas formas equivalentes: sem linha ativa (o normal) e uma
 * linha `('s3','platform')` — que este endpoint não cria, mas que um seed ou
 * dado legado pode ter deixado. As duas contam como já-vigente.
 */
function isSameAsActive(
  desired: DesiredStorageConfig,
  current: StorageConfigRow | undefined
): boolean {
  if (desired.secret !== undefined) return false;

  if (current === undefined) {
    return desired.credentialsSource === 'platform';
  }

  return (
    current.provider === desired.provider &&
    current.credentials_source === desired.credentialsSource &&
    sameStorageConfig(current.config, desired.config)
  );
}

/**
 * Corpo da resposta do GET e do PUT: a configuração vigente (sem o segredo)
 * mais os destinos aposentados que ainda guardam arquivos.
 */
async function buildStorageResponse(
  sql: Sql,
  tenantId: string
): Promise<{
  storageConfigId: string | null;
  provider: string;
  credentialsSource: string;
  config: unknown;
  secretConfigured: boolean;
  configuredAt: Date | null;
  previousDestinations: PreviousDestination[];
}> {
  const active = await loadActiveStorageConfig(sql, tenantId);
  const previousDestinations = await loadPreviousDestinations(sql, tenantId, active !== undefined);

  return {
    storageConfigId: active?.id ?? null,
    // Sem linha ativa = S3 da plataforma. É o default do produto, não um erro.
    provider: active?.provider ?? 's3',
    credentialsSource: active?.credentials_source ?? 'platform',
    config: active?.config ?? {},
    // O segredo NUNCA sai — nem cifrado, nem parcial. Só o booleano.
    secretConfigured:
      active?.encrypted_secret !== null &&
      active?.encrypted_secret !== undefined &&
      active.encrypted_secret.length > 0,
    configuredAt: active?.created_at ?? null,
    previousDestinations,
  };
}

/**
 * Destinos APOSENTADOS que ainda têm documentos apontando para eles.
 *
 * É o que diz à tela "esta empresa ainda tem 412 arquivos no destino anterior"
 * — sem isso o SUPER_ADMIN troca de destino às cegas, sem saber que existe
 * migração pendente (T-141).
 *
 * ⚠️ A contagem usa IGUALDADE (`= c.id`) e `IS NULL`, nunca `IS DISTINCT FROM`:
 * é com igualdade que o índice `docs_by_storage_config (tenant_id,
 * storage_config_id)` é usado. A medição da kurisu-chan: 0,044 ms contra
 * ~5005 buffers na varredura.
 *
 * `deleted = false` porque a pergunta é sobre ARQUIVO que ainda existe no
 * destino — a exclusão de documento apaga o binário (ver wiki "Exclusão lógica
 * (soft delete)"), então uma linha soft-deletada não representa nada a migrar.
 */
async function loadPreviousDestinations(
  sql: Sql,
  tenantId: string,
  hasActiveConfig: boolean
): Promise<PreviousDestination[]> {
  const retired = await sql<
    Array<{
      id: string;
      provider: string;
      credentials_source: string;
      config: unknown;
      retired_at: Date | null;
      document_count: number;
    }>
  >`
    SELECT c.id,
           c.provider,
           c.credentials_source,
           c.config,
           c.retired_at,
           (
             SELECT count(*)::int
             FROM documents d
             WHERE d.tenant_id = ${tenantId}
               AND d.storage_config_id = c.id
               AND d.deleted = false
           ) AS document_count
    FROM tenant_storage_configs c
    WHERE c.tenant_id = ${tenantId}
      AND c.active = false
    ORDER BY c.retired_at DESC NULLS LAST, c.created_at DESC
  `;

  const destinations: PreviousDestination[] = retired
    .filter((row) => row.document_count > 0)
    .map((row) => ({
      id: row.id,
      provider: row.provider,
      credentialsSource: row.credentials_source,
      config: row.config,
      retiredAt: row.retired_at,
      documentCount: row.document_count,
    }));

  // O acervo da plataforma (`storage_config_id IS NULL`) não tem linha para
  // aparecer na consulta acima, mas é um destino anterior como qualquer outro
  // assim que a empresa passa a gravar em outro lugar. Enquanto ela ESTIVER na
  // plataforma, esses arquivos estão no destino corrente — e listá-los como
  // "anterior" faria a tela oferecer uma migração de um lugar para ele mesmo.
  if (hasActiveConfig) {
    const platformRows = await sql<Array<{ document_count: number }>>`
      SELECT count(*)::int AS document_count
      FROM documents
      WHERE tenant_id = ${tenantId}
        AND storage_config_id IS NULL
        AND deleted = false
    `;
    const documentCount = platformRows[0]?.document_count ?? 0;
    if (documentCount > 0) {
      destinations.push({
        id: null,
        provider: 's3',
        credentialsSource: 'platform',
        config: {},
        retiredAt: null,
        documentCount,
      });
    }
  }

  return destinations;
}

// ---------------------------------------------------------------------------
// Auxiliares da migração de acervo (T-141)
// ---------------------------------------------------------------------------

/** Linha de `storage_migrations` como o postgres.js devolve (snake_case). */
interface StorageMigrationRow {
  id: string;
  status: string;
  from_provider: string;
  to_provider: string;
  total_docs: number;
  migrated_docs: number;
  failed_docs: number;
  last_error: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}

/** Destino da migração: a configuração ATIVA (nula = S3 da plataforma). */
interface StorageDestination {
  storageConfigId: string | null;
  provider: string;
}

/** Uma origem que ainda tem documentos, agrupada por configuração. */
interface PendingSource {
  storageConfigId: string | null;
  provider: string;
  documentCount: number;
}

/** Um destino candidato à limpeza da origem. */
interface CleanupTarget {
  storageConfigId: string | null;
  provider: string;
  /**
   * A configuração é fisicamente o MESMO lugar do destino ativo (mesmo bucket,
   * mesma biblioteca+pasta). Acontece na rotação de credencial, que versiona a
   * linha sem mudar o bucket — varrer essa "origem" apagaria o acervo ativo.
   */
  sameLocationAsDestination: boolean;
}

/** Migração viva da empresa (`PENDING`/`RUNNING`), se houver. */
async function loadActiveMigration(
  sql: Sql,
  tenantId: string
): Promise<{ id: string; status: string } | undefined> {
  const rows = await sql<Array<{ id: string; status: string }>>`
    SELECT id, status
    FROM storage_migrations
    WHERE tenant_id = ${tenantId}
      AND status IN ('PENDING', 'RUNNING')
    LIMIT 1
  `;
  return rows[0];
}

/**
 * Destino corrente da empresa — o alvo de qualquer migração.
 *
 * Sem linha ativa é o S3 da plataforma: `storageConfigId` nulo com provider
 * `s3`, o mesmo par que o CHECK `documents_platform_storage_is_s3` exige.
 */
async function loadDestination(sql: Sql, tenantId: string): Promise<StorageDestination> {
  const active = await loadActiveStorageConfig(sql, tenantId);
  return {
    storageConfigId: active?.id ?? null,
    provider: active?.provider ?? 's3',
  };
}

/**
 * Documentos que ainda dependem de um destino diferente do ativo, agrupados
 * pela configuração de origem.
 *
 * ⚠️ `IS DISTINCT FROM`, nunca `<>`. Com `NULL` de um dos lados — documento
 * ainda na plataforma, ou destino de plataforma — o `<>` devolve `NULL`, o
 * `WHERE` descarta a linha e a resposta volta vazia: a migração fecharia em
 * `DONE` com zero documentos e o `cleanup-source` apagaria um acervo que nunca
 * foi copiado. É a MESMA consulta que o worker usa para selecionar.
 */
async function loadPendingSources(
  sql: Sql,
  tenantId: string,
  destinationConfigId: string | null
): Promise<PendingSource[]> {
  const rows = await sql<
    Array<{ storage_config_id: string | null; storage_provider: string; document_count: number }>
  >`
    SELECT storage_config_id,
           storage_provider,
           count(*)::int AS document_count
    FROM documents
    WHERE tenant_id = ${tenantId}
      AND deleted = false
      AND storage_config_id IS DISTINCT FROM ${destinationConfigId}
    GROUP BY storage_config_id, storage_provider
    ORDER BY document_count DESC
  `;

  return rows.map((row) => ({
    storageConfigId: row.storage_config_id,
    provider: row.storage_provider,
    documentCount: row.document_count,
  }));
}

/** Quantos documentos ainda dependem da origem. Mesma regra de `loadPendingSources`. */
async function countPendingDocuments(
  sql: Sql,
  tenantId: string,
  destinationConfigId: string | null
): Promise<number> {
  const rows = await sql<Array<{ pending: number }>>`
    SELECT count(*)::int AS pending
    FROM documents
    WHERE tenant_id = ${tenantId}
      AND deleted = false
      AND storage_config_id IS DISTINCT FROM ${destinationConfigId}
  `;
  return rows[0]?.pending ?? 0;
}

/**
 * Destinos que a limpeza da origem varreria: toda configuração APOSENTADA da
 * empresa, mais o S3 da plataforma quando a empresa saiu dele.
 *
 * A lista NÃO é filtrada por "tem documento": a guarda de documentos já rodou
 * antes (nenhum documento pode depender da origem para chegar aqui), e o que
 * sobrou no destino antigo é exatamente a cópia que se quer apagar. Varrer um
 * prefixo vazio é no-op no contrato do driver.
 *
 * Cada alvo carrega se é fisicamente o mesmo lugar do destino ativo — ver
 * `storageLocationKey` para o porquê de isso ser vital.
 */
async function loadCleanupTargets(
  sql: Sql,
  tenantId: string,
  destination: StorageDestination,
  platformS3Config: S3Config
): Promise<CleanupTarget[]> {
  const retired = await sql<
    Array<{ id: string; provider: string; credentials_source: string; config: unknown }>
  >`
    SELECT id, provider, credentials_source, config
    FROM tenant_storage_configs
    WHERE tenant_id = ${tenantId}
      AND active = false
    ORDER BY retired_at DESC NULLS LAST, created_at DESC
  `;

  const active = await loadActiveStorageConfig(sql, tenantId);
  const destinationLocation = storageLocationKey(
    active?.provider ?? 's3',
    active?.credentials_source ?? 'platform',
    active?.config ?? {},
    platformS3Config
  );

  const targets: CleanupTarget[] = retired.map((row) => ({
    storageConfigId: row.id,
    provider: row.provider,
    sameLocationAsDestination:
      storageLocationKey(row.provider, row.credentials_source, row.config, platformS3Config) ===
      destinationLocation,
  }));

  // A plataforma não tem linha em `tenant_storage_configs`, mas é um destino
  // anterior como qualquer outro assim que a empresa passa a gravar em outro
  // lugar. Enquanto ela ESTIVER na plataforma, esse é o destino ativo e varrê-lo
  // seria apagar o acervo vivo.
  if (destination.storageConfigId !== null) {
    targets.push({
      storageConfigId: null,
      provider: 's3',
      sameLocationAsDestination:
        storageLocationKey('s3', 'platform', {}, platformS3Config) === destinationLocation,
    });
  }

  return targets;
}

/**
 * Corpo compartilhado pelo disparo, pelo GET de progresso e pelo cancelamento.
 *
 * Uma forma só para os três endpoints: a tela consulta o progresso em intervalo
 * regular e não deveria precisar de um parser por rota.
 *
 * `cleanupAvailable` é a resposta a "já posso apagar a origem?" — e responde
 * `false` enquanto QUALQUER documento depender dela, mesmo que a migração diga
 * `DONE`. Contador é o que a migração acha que fez; a contagem é o que o banco
 * diz que falta.
 */
async function buildMigrationResponse(
  sql: Sql,
  tenantId: string,
  migration: StorageMigrationRow | undefined
): Promise<{
  migration: {
    id: string;
    status: string;
    fromProvider: string;
    toProvider: string;
    totalDocs: number;
    migratedDocs: number;
    failedDocs: number;
    lastError: string | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    createdAt: Date;
  } | null;
  destination: StorageDestination;
  pendingDocuments: number;
  pendingSources: PendingSource[];
  cleanupAvailable: boolean;
}> {
  const destination = await loadDestination(sql, tenantId);
  const pendingSources = await loadPendingSources(sql, tenantId, destination.storageConfigId);
  const pendingDocuments = pendingSources.reduce((sum, source) => sum + source.documentCount, 0);
  const isActive = migration !== undefined && ACTIVE_MIGRATION_STATUSES.has(migration.status);

  return {
    migration:
      migration === undefined
        ? null
        : {
            id: migration.id,
            status: migration.status,
            fromProvider: migration.from_provider,
            toProvider: migration.to_provider,
            totalDocs: migration.total_docs,
            migratedDocs: migration.migrated_docs,
            failedDocs: migration.failed_docs,
            lastError: migration.last_error,
            startedAt: migration.started_at,
            finishedAt: migration.finished_at,
            createdAt: migration.created_at,
          },
    destination,
    pendingDocuments,
    pendingSources,
    cleanupAvailable: pendingDocuments === 0 && !isActive,
  };
}

/** Status em que a migração ainda está viva — os mesmos do índice único parcial. */
const ACTIVE_MIGRATION_STATUSES = new Set(['PENDING', 'RUNNING']);

/**
 * Registra auditoria sem deixar a falha do log derrubar a operação principal.
 *
 * Concentra o `try/catch` que os três endpoints da migração repetiriam — em
 * especial o `cleanup-source`, cujo registro é a única prova de uma operação
 * destrutiva e irreversível.
 */
async function recordAudit(
  request: FastifyRequest,
  sql: Sql,
  entry: { tenantId: string; action: string; metadata: Record<string, unknown> }
): Promise<void> {
  try {
    await new AuditLogger(sql).record({
      tenantId: entry.tenantId,
      userId: request.user?.sub ?? null,
      action: entry.action,
      resource: `tenants/${entry.tenantId}`,
      metadata: entry.metadata,
    });
  } catch (auditError) {
    request.log.error(
      {
        err: auditError,
        tenantId: entry.tenantId,
        userId: request.user?.sub ?? null,
        action: entry.action,
      },
      'falha ao registrar audit log'
    );
  }
}
