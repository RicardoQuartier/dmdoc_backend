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

  const existing = await sql<{ hash: string }[]>`
    SELECT hash FROM drizzle.__drizzle_migrations WHERE hash = ANY(${[hash0001, hash0002]})
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

  // 4. Verify
  const idx = await sql<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes
    WHERE tablename = 'documents' AND indexname = 'uniq_doc_tenant_content_hash'
  `;
  console.log('\nÍndice final:', idx[0]?.indexdef);
  console.log('\n✅ Bootstrap concluído. Rode pnpm --filter db-pg migrate para confirmar.');
} finally {
  await sql.end();
}
