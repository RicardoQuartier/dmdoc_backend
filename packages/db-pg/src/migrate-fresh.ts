/**
 * Drop completo do schema + re-aplica todas as migrations via drizzle-kit.
 * Equivalente ao `migrate:fresh` do Laravel.
 *
 * Uso: pnpm --filter db-pg migrate:fresh
 *
 * ATENÇÃO: destrói todos os dados e recria o schema do zero.
 * Use apenas em desenvolvimento.
 */
import { execSync } from 'node:child_process';
import postgres from 'postgres';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc';

const sql = postgres(DATABASE_URL, { max: 1 });

try {
  console.log('⚠️  migrate:fresh — apagando schema público e tracking do drizzle...');
  await sql`DROP SCHEMA public CASCADE`;
  await sql`CREATE SCHEMA public AUTHORIZATION dmdoc`;
  await sql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  console.log('✔ schemas dropados');
} finally {
  await sql.end();
}

console.log('⏳ aplicando migrations...');
execSync('drizzle-kit migrate', {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL },
});
console.log('✅ migrate:fresh concluído');
