import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';

/**
 * Raiz do pacote `@dmdoc/db-pg` (onde vivem `drizzle.config.ts` e
 * `node_modules/.bin/drizzle-kit`), calculada a partir da localização deste
 * próprio arquivo — funciona tanto rodando via `tsx` (`src/migrate-fresh.ts`)
 * quanto via build compilado (`dist/migrate-fresh.js`, consumido por outro
 * pacote do workspace, como o `@dmdoc/artisan`), já que em ambos os casos o
 * arquivo está um nível abaixo da raiz do pacote.
 */
const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Drop completo do schema + re-aplica todas as migrations via drizzle-kit.
 * Equivalente ao `migrate:fresh` do Laravel.
 *
 * Uso standalone: `pnpm --filter @dmdoc/db-pg migrate:fresh`
 * Uso via artisan: `pnpm run artisan db:migrate-fresh`
 *
 * ATENÇÃO: destrói todos os dados e recria o schema do zero.
 * Use apenas em desenvolvimento.
 *
 * Gerencia sua própria conexão (não recebe `sql` como parâmetro): abre,
 * dropa o schema, fecha — e só depois dispara o subprocesso
 * `drizzle-kit migrate`, que abre sua própria conexão via `DATABASE_URL`.
 * Manter as duas conexões simultâneas não teria propósito aqui.
 */
export async function migrateFresh(): Promise<void> {
  const databaseUrl =
    process.env['DATABASE_URL'] ?? 'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc';

  const sql = postgres(databaseUrl, { max: 1 });
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
  // cwd fixo na raiz do pacote db-pg: é onde `drizzle.config.ts` vive, e o
  // PATH ganha o `.bin` local do pacote na frente — necessário quando este
  // código roda a partir de outro pacote (ex.: artisan), cujo cwd/PATH
  // padrão do pnpm não incluem o binário `drizzle-kit` deste pacote.
  execSync('drizzle-kit migrate', {
    cwd: PACKAGE_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PATH: `${path.join(PACKAGE_ROOT, 'node_modules', '.bin')}${path.delimiter}${process.env['PATH'] ?? ''}`,
    },
  });
  console.log('✅ migrate:fresh concluído');
}

// Executa quando rodado como script (via tsx), não quando importado.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  migrateFresh().catch((err: unknown) => {
    console.error(
      JSON.stringify({
        level: 'error',
        name: 'migrate-fresh',
        msg: 'falha no migrate:fresh',
        err: String(err),
      }),
    );
    process.exitCode = 1;
  });
}
