import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { seed } from './seed.js';

/**
 * Script de reset completo do banco — equivalente ao `migrate:fresh --seed` do Laravel.
 *
 * Executar: `pnpm --filter @dmdoc/db-pg db:fresh`
 *
 * Fluxo:
 *   1. Trunca TODAS as tabelas em ordem reversa de FK (preservando o schema)
 *   2. Popula os dados iniciais (seed)
 *
 * ATENÇÃO: destrói todos os dados. Use apenas em desenvolvimento.
 */

function createScriptLogger(name: string) {
  return {
    info: (data: Record<string, unknown> | string, msg?: string) => {
      const message = typeof data === 'string' ? data : msg ?? '';
      const extra = typeof data === 'object' ? data : {};
      console.log(JSON.stringify({ level: 'info', name, msg: message, ...extra }));
    },
    warn: (data: Record<string, unknown> | string, msg?: string) => {
      const message = typeof data === 'string' ? data : msg ?? '';
      const extra = typeof data === 'object' ? data : {};
      console.warn(JSON.stringify({ level: 'warn', name, msg: message, ...extra }));
    },
    error: (data: Record<string, unknown> | string, msg?: string) => {
      const message = typeof data === 'string' ? data : msg ?? '';
      const extra = typeof data === 'object' ? data : {};
      console.error(JSON.stringify({ level: 'error', name, msg: message, ...extra }));
    },
  };
}

/**
 * Trunca todas as tabelas do DMDoc em ordem reversa de FK, reiniciando
 * sequences de identity. O CASCADE garante que dependências circulares
 * (ex.: document_events.document_id → documents.id) sejam tratadas pelo
 * próprio PostgreSQL.
 *
 * Tabelas em ordem reversa de dependência:
 *   chunks → document_content → document_events → documents
 *   → department_permissions → departments → users
 *   → global_type_tenant_depts → document_type_index_fields
 *   → document_types → tenants → department_templates → audit_logs
 */
export async function dbFresh(sql: postgres.Sql): Promise<void> {
  await sql`
    TRUNCATE TABLE
      chunks,
      document_content,
      document_events,
      documents,
      department_permissions,
      departments,
      users,
      global_type_tenant_depts,
      document_type_index_fields,
      document_types,
      tenants,
      department_templates,
      audit_logs
    RESTART IDENTITY CASCADE
  `;
}

async function main(): Promise<void> {
  const log = createScriptLogger('db-fresh');
  const databaseUrl =
    process.env['DATABASE_URL'] ?? 'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc';

  log.warn({ databaseUrl }, 'db:fresh — TRUNCANDO todas as tabelas e recriando do zero');

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await dbFresh(sql);
    log.info('tabelas truncadas');

    await seed(sql);

    log.info('db:fresh concluído — banco pronto para uso');
  } finally {
    await sql.end();
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    createScriptLogger('db-fresh').error({ err: String(err) }, 'falha no db:fresh');
    process.exitCode = 1;
  });
}
