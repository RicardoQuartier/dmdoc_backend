import { pathToFileURL } from 'node:url';
import argon2 from 'argon2';
import type { Db } from 'mongodb';
import type { FieldType, IndexField, Role } from '@dmdoc/shared-types';
import { MongoDbClient } from './client.js';
import { newId } from './helpers.js';
import { createScriptLogger, readMongoConfig, envOr } from './scripts/script-env.js';

/**
 * Script de bootstrap: popula dados iniciais (spec §5, Fase 1 entregável 9).
 *
 * Executar: `pnpm --filter @dmdoc/db-mongo seed`
 *
 * IDEMPOTENTE: cada documento é gravado via upsert pela sua chave natural,
 * então rodar o seed N vezes não duplica nada nem altera ids já existentes.
 *   - user            → (tenantId, email)
 *   - tenant          → (name)
 *   - document_type   → (tenantId, name)
 *
 * Cria:
 *   - 1 SUPER_ADMIN (sem empresa: `tenantId: null`)
 *   - 1 tenant de teste com cotas razoáveis
 *   - 1 TENANT_ADMIN desse tenant
 *   - Tipos de documento GLOBAIS: Contrato, Boleto, Nota Fiscal
 *
 * Senhas são hasheadas com argon2 (nunca texto puro).
 */

/** Constrói um `IndexField` completo a partir do essencial, preenchendo defaults. */
function indexField(
  name: string,
  fieldType: FieldType,
  required: boolean,
  order: number,
  aiExtractionHint: string | null,
): IndexField {
  return {
    id: newId(),
    name,
    fieldType,
    required,
    aiExtractionHint,
    order,
    showOnSearch: true,
    deleted: false,
  };
}

/** Definição declarativa de um tipo global a semear. */
interface GlobalTypeSeed {
  name: string;
  description: string;
  indexFields: IndexField[];
}

function globalTypeSeeds(): GlobalTypeSeed[] {
  return [
    {
      name: 'Contrato',
      description: 'Contratos de prestação de serviço e afins.',
      indexFields: [
        indexField('partes', 'TEXT', true, 1, 'Nomes das partes contratantes'),
        indexField('vencimento', 'DATE', false, 2, 'Data de vencimento ou término do contrato'),
      ],
    },
    {
      name: 'Boleto',
      description: 'Boletos bancários.',
      indexFields: [
        indexField('vencimento', 'DATE', false, 1, 'Data de vencimento do boleto'),
        indexField('valor', 'NUMBER', false, 2, 'Valor do boleto'),
      ],
    },
    {
      name: 'Nota Fiscal',
      description: 'Notas fiscais de produtos e serviços.',
      indexFields: [
        indexField('numero', 'TEXT', false, 1, 'Número da nota fiscal'),
        indexField('emissao', 'DATE', false, 2, 'Data de emissão'),
        indexField('valor', 'NUMBER', false, 3, 'Valor total da nota'),
      ],
    },
  ];
}

/**
 * Upsert idempotente de um usuário pela chave natural `(tenantId, email)`.
 * Em re-runs preserva `id`, `passwordHash` e `createdAt` já existentes
 * (`$setOnInsert`), apenas garantindo os campos estruturais.
 */
async function upsertUser(
  db: Db,
  user: {
    tenantId: string | null;
    email: string;
    passwordHash: string;
    name: string;
    role: Role;
  },
): Promise<{ id: string }> {
  const res = await db.collection('users').findOneAndUpdate(
    { tenantId: user.tenantId, email: user.email },
    {
      $setOnInsert: {
        id: newId(),
        tenantId: user.tenantId,
        email: user.email,
        passwordHash: user.passwordHash,
        createdAt: new Date(),
        deleted: false,
      },
      $set: {
        name: user.name,
        role: user.role,
        active: true,
      },
    },
    { upsert: true, returnDocument: 'after' },
  );

  // Com `upsert` + `returnDocument:'after'`, o documento final sempre existe.
  const doc = res as { id: string } | null;
  return { id: doc?.id ?? '' };
}

export async function seed(client: MongoDbClient): Promise<void> {
  const log = createScriptLogger('seed');
  const db = client.getDb();

  // --- Credenciais (env com defaults de dev) ---
  const superAdminEmail = envOr('SEED_SUPERADMIN_EMAIL', 'superadmin@local.com');
  const superAdminPassword = envOr('SEED_SUPERADMIN_PASSWORD', '123qwe');
  const tenantAdminEmail = envOr('SEED_TENANT_ADMIN_EMAIL', 'admin1@local.com');
  const tenantAdminPassword = envOr('SEED_TENANT_ADMIN_PASSWORD', '123qwe');
  const testTenantName = envOr('SEED_TENANT_NAME', 'Empresa Teste Ltda');
  const diskQuotaBytes = Number(envOr('SEED_TENANT_DISK_QUOTA_BYTES', String(10 * 1024 ** 3))); // 10 GiB
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
  const superAdmin = await upsertUser(db, {
    tenantId: null,
    email: superAdminEmail,
    passwordHash: superAdminHash,
    name: 'Super Admin',
    role: 'SUPER_ADMIN',
  });
  log.info({ email: superAdminEmail, id: superAdmin.id }, 'SUPER_ADMIN garantido');

  // --- Tenant de teste (upsert por name) ---
  const tenantRes = await db.collection('tenants').findOneAndUpdate(
    { name: testTenantName },
    {
      $setOnInsert: { id: newId(), name: testTenantName, createdAt: new Date() },
      $set: { diskQuotaBytes, userQuota, active: true },
    },
    { upsert: true, returnDocument: 'after' },
  );
  const tenant = tenantRes as { id: string } | null;
  const tenantId = tenant?.id ?? '';
  log.info({ name: testTenantName, id: tenantId, diskQuotaBytes, userQuota }, 'tenant garantido');

  // --- TENANT_ADMIN do tenant de teste ---
  const tenantAdminHash = await argon2.hash(tenantAdminPassword);
  const tenantAdmin = await upsertUser(db, {
    tenantId,
    email: tenantAdminEmail,
    passwordHash: tenantAdminHash,
    name: 'Tenant Admin',
    role: 'TENANT_ADMIN',
  });
  log.info({ email: tenantAdminEmail, id: tenantAdmin.id, tenantId }, 'TENANT_ADMIN garantido');

  // --- Tenant 2 de teste (para testes E2E de isolamento multi-tenant) ---
  const tenant2Res = await db.collection('tenants').findOneAndUpdate(
    { name: testTenant2Name },
    {
      $setOnInsert: { id: newId(), name: testTenant2Name, createdAt: new Date() },
      $set: { diskQuotaBytes, userQuota, active: true },
    },
    { upsert: true, returnDocument: 'after' },
  );
  const tenant2 = tenant2Res as { id: string } | null;
  const tenantId2 = tenant2?.id ?? '';
  log.info({ name: testTenant2Name, id: tenantId2 }, 'tenant 2 garantido');

  const tenant2AdminHash = await argon2.hash(tenant2AdminPassword);
  const tenant2Admin = await upsertUser(db, {
    tenantId: tenantId2,
    email: tenant2AdminEmail,
    passwordHash: tenant2AdminHash,
    name: 'Tenant Admin 2',
    role: 'TENANT_ADMIN',
  });
  log.info({ email: tenant2AdminEmail, id: tenant2Admin.id, tenantId: tenantId2 }, 'TENANT_ADMIN 2 garantido');

  // --- MULTI_TENANT_ADMIN de desenvolvimento ---
  // Sem empresa fixa (tenantId: null); tem acesso aos dois tenants de teste.
  // Credenciais: mta@local.com / 123qwe (sobreponíveis por env).
  const mtaHash = await argon2.hash(mtaPassword);
  await db.collection('users').findOneAndUpdate(
    { tenantId: null, email: mtaEmail },
    {
      $setOnInsert: {
        id: newId(),
        tenantId: null,
        email: mtaEmail,
        passwordHash: mtaHash,
        createdAt: new Date(),
        deleted: false,
      },
      $set: {
        name: 'Multi-Tenant Admin',
        role: 'MULTI_TENANT_ADMIN' as Role,
        active: true,
        // Lista dos dois tenants de teste para poder testar acesso cross-tenant
        allowedTenantIds: [tenantId, tenantId2],
      },
    },
    { upsert: true, returnDocument: 'after' },
  );
  log.info(
    { email: mtaEmail, allowedTenantIds: [tenantId, tenantId2] },
    'MULTI_TENANT_ADMIN garantido',
  );

  // --- Tipos globais (tenantId: null, isGlobal: true) ---
  for (const seedType of globalTypeSeeds()) {
    await db.collection('document_types').findOneAndUpdate(
      { tenantId: null, name: seedType.name },
      {
        $setOnInsert: {
          id: newId(),
          tenantId: null,
          name: seedType.name,
          isGlobal: true,
          deleted: false,
          createdAt: new Date(),
          indexFields: seedType.indexFields,
        },
        $set: { description: seedType.description },
      },
      { upsert: true, returnDocument: 'after' },
    );
    log.info({ name: seedType.name, isGlobal: true }, 'tipo global garantido');
  }

  log.info('seed concluído');
}

async function main(): Promise<void> {
  const log = createScriptLogger('seed');
  const { uri, dbName } = readMongoConfig();
  log.info({ uri, dbName }, 'conectando ao MongoDB');

  const client = await MongoDbClient.connect(uri, dbName);
  try {
    await seed(client);
  } finally {
    await client.close();
  }
}

// Executa quando rodado como script (via tsx), não quando importado.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    createScriptLogger('seed').error({ err }, 'falha ao executar seed');
    process.exitCode = 1;
  });
}
