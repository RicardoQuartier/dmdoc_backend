import { pathToFileURL } from 'node:url';
import argon2 from 'argon2';
import postgres from 'postgres';
import { newId } from './helpers.js';

/**
 * Script de bootstrap: popula dados iniciais (spec §5, Fase 1 entregável 9).
 *
 * Executar: `pnpm --filter @dmdoc/db-pg seed`
 *
 * IDEMPOTENTE: cada linha é gravada via INSERT ... ON CONFLICT DO NOTHING pela
 * chave natural, então rodar o seed N vezes não duplica nada.
 *   - users          → (tenant_id, email)
 *   - tenants        → (name)
 *   - document_types → (tenant_id, name)
 *
 * Cria:
 *   - 1 SUPER_ADMIN (sem empresa: tenant_id NULL)
 *   - 2 tenants de teste com cotas razoáveis
 *   - 1 TENANT_ADMIN para cada tenant de teste
 *   - 1 MULTI_TENANT_ADMIN com acesso aos dois tenants
 *   - Tipos de documento GLOBAIS: Contrato, Boleto, Nota Fiscal
 *
 * Senhas são hasheadas com argon2 (nunca texto puro).
 */

function envOr(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
}

interface IndexFieldSeed {
  name: string;
  fieldType: 'TEXT' | 'DATE' | 'NUMBER';
  required: boolean;
  sortOrder: number;
  aiExtractionHint: string | null;
}

interface GlobalTypeSeed {
  name: string;
  description: string;
  indexFields: IndexFieldSeed[];
}

function globalTypeSeeds(): GlobalTypeSeed[] {
  return [
    {
      name: 'Contrato',
      description: 'Contratos de prestação de serviço e afins.',
      indexFields: [
        {
          name: 'partes',
          fieldType: 'TEXT',
          required: true,
          sortOrder: 1,
          aiExtractionHint: 'Nomes das partes contratantes',
        },
        {
          name: 'vencimento',
          fieldType: 'DATE',
          required: false,
          sortOrder: 2,
          aiExtractionHint: 'Data de vencimento ou término do contrato',
        },
      ],
    },
    {
      name: 'Boleto',
      description: 'Boletos bancários.',
      indexFields: [
        {
          name: 'vencimento',
          fieldType: 'DATE',
          required: false,
          sortOrder: 1,
          aiExtractionHint: 'Data de vencimento do boleto',
        },
        {
          name: 'valor',
          fieldType: 'NUMBER',
          required: false,
          sortOrder: 2,
          aiExtractionHint: 'Valor do boleto',
        },
      ],
    },
    {
      name: 'Nota Fiscal',
      description: 'Notas fiscais de produtos e serviços.',
      indexFields: [
        {
          name: 'numero',
          fieldType: 'TEXT',
          required: false,
          sortOrder: 1,
          aiExtractionHint: 'Número da nota fiscal',
        },
        {
          name: 'emissao',
          fieldType: 'DATE',
          required: false,
          sortOrder: 2,
          aiExtractionHint: 'Data de emissão',
        },
        {
          name: 'valor',
          fieldType: 'NUMBER',
          required: false,
          sortOrder: 3,
          aiExtractionHint: 'Valor total da nota',
        },
      ],
    },
  ];
}

/**
 * Upsert idempotente de um tenant pela chave natural `name`.
 * Retorna o id do tenant (existente ou recém-criado).
 */
async function upsertTenant(
  sql: postgres.Sql,
  opts: {
    name: string;
    diskQuotaBytes: bigint;
    userQuota: number;
  },
): Promise<string> {
  // Tenta inserir; se já existir (ON CONFLICT), lê o id existente.
  await sql`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota, active, created_at)
    VALUES (
      gen_random_uuid(),
      ${opts.name},
      ${opts.diskQuotaBytes.toString()},
      ${opts.userQuota},
      true,
      NOW()
    )
    ON CONFLICT (name) DO UPDATE
      SET disk_quota_bytes = EXCLUDED.disk_quota_bytes,
          user_quota       = EXCLUDED.user_quota,
          active           = EXCLUDED.active
  `;

  const rows = await sql<Array<{ id: string }>>`
    SELECT id FROM tenants WHERE name = ${opts.name} LIMIT 1
  `;
  return rows[0]?.id ?? '';
}

/**
 * Upsert idempotente de um usuário pela chave natural `(tenant_id, email)`.
 * Preserva o `id` já existente (não sobrescreve na atualização).
 */
async function upsertUser(
  sql: postgres.Sql,
  user: {
    tenantId: string | null;
    email: string;
    passwordHash: string;
    name: string;
    role: string;
    allowedTenantIds?: string[] | null;
  },
): Promise<{ id: string }> {
  const id = newId();
  const allowedTenantIds = user.allowedTenantIds ?? null;

  await sql`
    INSERT INTO users (
      id, tenant_id, email, password_hash, name, role, active,
      allowed_tenant_ids, created_at, deleted
    )
    VALUES (
      ${id},
      ${user.tenantId},
      ${user.email},
      ${user.passwordHash},
      ${user.name},
      ${user.role},
      true,
      ${allowedTenantIds}::uuid[],
      NOW(),
      false
    )
    ON CONFLICT (tenant_id, email) DO UPDATE
      SET name               = EXCLUDED.name,
          role               = EXCLUDED.role,
          active             = EXCLUDED.active,
          allowed_tenant_ids = EXCLUDED.allowed_tenant_ids
  `;

  const rows = await sql<Array<{ id: string }>>`
    SELECT id FROM users
    WHERE email = ${user.email}
      AND (
        (tenant_id IS NULL AND ${user.tenantId} IS NULL)
        OR tenant_id = ${user.tenantId}
      )
    LIMIT 1
  `;
  return { id: rows[0]?.id ?? '' };
}

export async function seed(sql: postgres.Sql): Promise<void> {
  // --- Credenciais (env com defaults de dev) ---
  const superAdminEmail = envOr('SEED_SUPERADMIN_EMAIL', 'superadmin@local.com');
  const superAdminPassword = envOr('SEED_SUPERADMIN_PASSWORD', '123qwe');
  const tenantAdminEmail = envOr('SEED_TENANT_ADMIN_EMAIL', 'admin1@local.com');
  const tenantAdminPassword = envOr('SEED_TENANT_ADMIN_PASSWORD', '123qwe');
  const testTenantName = envOr('SEED_TENANT_NAME', 'Empresa Teste Ltda');
  const diskQuotaBytes = BigInt(envOr('SEED_TENANT_DISK_QUOTA_BYTES', String(10 * 1024 ** 3)));
  const userQuota = Number(envOr('SEED_TENANT_USER_QUOTA', '20'));

  // --- Tenant 2 e admin 2 ---
  const tenant2AdminEmail = envOr('SEED_TENANT2_ADMIN_EMAIL', 'admin2@local.com');
  const tenant2AdminPassword = envOr('SEED_TENANT2_ADMIN_PASSWORD', '123qwe');
  const testTenant2Name = envOr('SEED_TENANT2_NAME', 'Empresa Teste 2 Ltda');

  // --- MULTI_TENANT_ADMIN de desenvolvimento ---
  const mtaEmail = envOr('SEED_MTA_EMAIL', 'mta@local.com');
  const mtaPassword = envOr('SEED_MTA_PASSWORD', '123qwe');

  // --- SUPER_ADMIN (sem empresa) ---
  const superAdminHash = await argon2.hash(superAdminPassword);
  const superAdmin = await upsertUser(sql, {
    tenantId: null,
    email: superAdminEmail,
    passwordHash: superAdminHash,
    name: 'Super Admin',
    role: 'SUPER_ADMIN',
  });
  console.log(JSON.stringify({ level: 'info', name: 'seed', msg: 'SUPER_ADMIN garantido', email: superAdminEmail, id: superAdmin.id }));

  // --- Tenant 1 de teste ---
  const tenantId = await upsertTenant(sql, {
    name: testTenantName,
    diskQuotaBytes,
    userQuota,
  });
  console.log(JSON.stringify({ level: 'info', name: 'seed', msg: 'tenant garantido', tenantName: testTenantName, id: tenantId }));

  // --- TENANT_ADMIN do tenant 1 ---
  const tenantAdminHash = await argon2.hash(tenantAdminPassword);
  const tenantAdmin = await upsertUser(sql, {
    tenantId,
    email: tenantAdminEmail,
    passwordHash: tenantAdminHash,
    name: 'Tenant Admin',
    role: 'TENANT_ADMIN',
  });
  console.log(JSON.stringify({ level: 'info', name: 'seed', msg: 'TENANT_ADMIN garantido', email: tenantAdminEmail, id: tenantAdmin.id, tenantId }));

  // --- Tenant 2 de teste (para testes E2E de isolamento multi-tenant) ---
  const tenantId2 = await upsertTenant(sql, {
    name: testTenant2Name,
    diskQuotaBytes,
    userQuota,
  });
  console.log(JSON.stringify({ level: 'info', name: 'seed', msg: 'tenant 2 garantido', tenantName: testTenant2Name, id: tenantId2 }));

  const tenant2AdminHash = await argon2.hash(tenant2AdminPassword);
  const tenant2Admin = await upsertUser(sql, {
    tenantId: tenantId2,
    email: tenant2AdminEmail,
    passwordHash: tenant2AdminHash,
    name: 'Tenant Admin 2',
    role: 'TENANT_ADMIN',
  });
  console.log(JSON.stringify({ level: 'info', name: 'seed', msg: 'TENANT_ADMIN 2 garantido', email: tenant2AdminEmail, id: tenant2Admin.id, tenantId: tenantId2 }));

  // --- MULTI_TENANT_ADMIN de desenvolvimento ---
  // Sem empresa fixa (tenantId: null); tem acesso aos dois tenants de teste.
  const mtaHash = await argon2.hash(mtaPassword);
  await upsertUser(sql, {
    tenantId: null,
    email: mtaEmail,
    passwordHash: mtaHash,
    name: 'Multi-Tenant Admin',
    role: 'MULTI_TENANT_ADMIN',
    allowedTenantIds: [tenantId, tenantId2],
  });
  console.log(JSON.stringify({ level: 'info', name: 'seed', msg: 'MULTI_TENANT_ADMIN garantido', email: mtaEmail, allowedTenantIds: [tenantId, tenantId2] }));

  // --- Tipos globais (tenant_id NULL, is_global TRUE) ---
  for (const seedType of globalTypeSeeds()) {
    // Upsert do tipo
    await sql`
      INSERT INTO document_types (id, tenant_id, name, description, is_global, deleted, created_at)
      VALUES (gen_random_uuid(), NULL, ${seedType.name}, ${seedType.description}, true, false, NOW())
      ON CONFLICT (tenant_id, name) DO UPDATE
        SET description = EXCLUDED.description
    `;

    const typeRows = await sql<Array<{ id: string }>>`
      SELECT id FROM document_types
      WHERE tenant_id IS NULL AND name = ${seedType.name}
      LIMIT 1
    `;
    const typeId = typeRows[0]?.id ?? '';

    // Upsert de cada index field
    for (const field of seedType.indexFields) {
      await sql`
        INSERT INTO document_type_index_fields (
          id, document_type_id, name, field_type, required,
          ai_extraction_hint, sort_order, show_on_search, deleted
        )
        VALUES (
          gen_random_uuid(),
          ${typeId},
          ${field.name},
          ${field.fieldType},
          ${field.required},
          ${field.aiExtractionHint},
          ${field.sortOrder},
          true,
          false
        )
        ON CONFLICT DO NOTHING
      `;
    }

    console.log(JSON.stringify({ level: 'info', name: 'seed', msg: 'tipo global garantido', typeName: seedType.name, isGlobal: true }));
  }

  console.log(JSON.stringify({ level: 'info', name: 'seed', msg: 'seed concluído' }));
}

async function main(): Promise<void> {
  const databaseUrl =
    process.env['DATABASE_URL'] ?? 'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc';
  console.log(JSON.stringify({ level: 'info', name: 'seed', msg: 'conectando ao PostgreSQL', databaseUrl }));

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await seed(sql);
  } finally {
    await sql.end();
  }
}

// Executa quando rodado como script (via tsx), não quando importado.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    console.error(JSON.stringify({ level: 'error', name: 'seed', msg: 'falha ao executar seed', err: String(err) }));
    process.exitCode = 1;
  });
}
