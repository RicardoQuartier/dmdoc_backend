import postgres, { type Sql } from 'postgres';

/**
 * Abre uma conexão Postgres (`DATABASE_URL`, fallback de dev), executa `fn`
 * e garante o fechamento da conexão no `finally`.
 *
 * Evita duplicar o boilerplate de abrir/fechar conexão em cada comando
 * artisan que precisa de acesso direto ao banco.
 */
export async function withConnection(fn: (sql: Sql) => Promise<void>): Promise<void> {
  const databaseUrl =
    process.env['DATABASE_URL'] ?? 'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc';

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await fn(sql);
  } finally {
    await sql.end();
  }
}
