/**
 * Bootstraps the drizzle migration tracking table and applies pending schema fixes.
 * Run once in environments where 0001_initial was applied manually (not via drizzle-kit).
 *
 * Usage inside the api container:
 *   pnpm --filter db-pg tsx src/bootstrap-migrations.ts
 */
import postgres from 'postgres';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) throw new Error('DATABASE_URL not set');

const sql = postgres(DATABASE_URL);

try {
  // 1. Ensure drizzle tracking schema and table exist
  await sql`CREATE SCHEMA IF NOT EXISTS drizzle`;
  await sql`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id      SERIAL PRIMARY KEY,
      hash    TEXT   NOT NULL,
      created_at BIGINT
    )
  `;
  console.log('✔ drizzle.__drizzle_migrations ready');

  // 2. Mark 0001_initial as already applied (sha256 of the file)
  const hash0001 = '476966a7083bcea0509dc6fbf5cbbcb8d00b94598d34d33bccc6f221f4104fbd';
  const hash0002 = '032167c206fa0b0e9db055e48f96e0ed3281cb1d20d040edd3640baef19c3e1c';
  const hash0003 = '4907d794fcf57e16c4ed488c71a7870ec75158cde796fbcbce49330e1fe5a00c';
  const hash0004 = '5ebce9ab53e88ac1d0c2c05a46cdddae1b73293d1906815e50e24ba666297d6e';
  const hash0005 = '07d09f5c97a96958b16d302d79f647932482a6ade9e1053c1ed1a8bba9a6dc42';

  const existing = await sql<{ hash: string }[]>`
    SELECT hash FROM drizzle.__drizzle_migrations WHERE hash = ANY(${[hash0001, hash0002, hash0003, hash0004, hash0005]})
  `;
  const existingSet = new Set(existing.map((r) => r.hash));

  if (!existingSet.has(hash0001)) {
    await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${hash0001}, ${1748000000000})`;
    console.log('✔ 0001_initial marcada como aplicada');
  } else {
    console.log('– 0001_initial já registrada');
  }

  // 3. Apply 0002: replace full unique index with partial one (deleted = false only)
  await sql`DROP INDEX IF EXISTS uniq_doc_tenant_content_hash`;
  await sql`
    CREATE UNIQUE INDEX uniq_doc_tenant_content_hash
      ON documents (tenant_id, content_hash)
      WHERE deleted = false
  `;
  console.log('✔ índice uniq_doc_tenant_content_hash recriado como parcial');

  if (!existingSet.has(hash0002)) {
    await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${hash0002}, ${1750891380000})`;
    console.log('✔ 0002_partial_unique_content_hash marcada como aplicada');
  } else {
    console.log('– 0002_partial_unique_content_hash já registrada');
  }

  // 4. Apply 0003: FK nullable em document_events + colunas deleted em tenants
  await sql`ALTER TABLE document_events ALTER COLUMN uploaded_by_id DROP NOT NULL`;
  await sql`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS deleted boolean NOT NULL DEFAULT false`;
  await sql`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS deleted_at timestamptz`;
  console.log('✔ 0003: document_events.uploaded_by_id nullable + tenants.deleted/deleted_at');

  if (!existingSet.has(hash0003)) {
    await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${hash0003}, ${1782432000000})`;
    console.log('✔ 0003_tenant_deletion marcada como aplicada');
  } else {
    console.log('– 0003_tenant_deletion já registrada');
  }

  // 5. Apply 0004: platform_settings (singleton, kill switch de plataforma) +
  //    toggles por empresa das features de IA de sugestão (Fases 7/8/8.1).
  await sql`
    CREATE TABLE IF NOT EXISTS platform_settings (
      id                            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      ai_classification_enabled     BOOLEAN     NOT NULL DEFAULT true,
      ai_title_suggestion_enabled   BOOLEAN     NOT NULL DEFAULT true,
      ai_index_suggestion_enabled   BOOLEAN     NOT NULL DEFAULT true,
      updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  // Índice único parcial sobre a expressão constante `true`: impede uma segunda
  // linha, garantindo o invariante de singleton no nível do banco.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_platform_settings_singleton
      ON platform_settings ((true))
  `;
  // Semeia a linha singleton apenas se ainda não existir (idempotente).
  await sql`
    INSERT INTO platform_settings (
      ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled
    )
    SELECT true, true, true
    WHERE NOT EXISTS (SELECT 1 FROM platform_settings)
  `;
  await sql`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ai_classification_enabled boolean NOT NULL DEFAULT true`;
  await sql`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ai_title_suggestion_enabled boolean NOT NULL DEFAULT true`;
  await sql`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ai_index_suggestion_enabled boolean NOT NULL DEFAULT true`;
  console.log('✔ 0004: platform_settings (singleton) + tenants.ai_*_enabled');

  if (!existingSet.has(hash0004)) {
    await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${hash0004}, ${1783646715000})`;
    console.log('✔ 0004_ai_feature_flags marcada como aplicada');
  } else {
    console.log('– 0004_ai_feature_flags já registrada');
  }

  // 6. Apply 0005: coluna type_suggestion (sugestão de tipo por IA, Fase 8)
  await sql`ALTER TABLE document_content ADD COLUMN IF NOT EXISTS type_suggestion jsonb`;
  console.log('✔ 0005: document_content.type_suggestion adicionada');

  if (!existingSet.has(hash0005)) {
    await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${hash0005}, ${1784131200000})`;
    console.log('✔ 0005_type_suggestion marcada como aplicada');
  } else {
    console.log('– 0005_type_suggestion já registrada');
  }

  // 7. Verify
  const idx = await sql<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes
    WHERE tablename = 'documents' AND indexname = 'uniq_doc_tenant_content_hash'
  `;
  console.log('\nÍndice final:', idx[0]?.indexdef);
  console.log('\n✅ Bootstrap concluído. Rode pnpm --filter db-pg migrate para confirmar.');
} finally {
  await sql.end();
}
