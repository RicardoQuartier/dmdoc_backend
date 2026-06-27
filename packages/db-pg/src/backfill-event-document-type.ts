import { pathToFileURL } from 'node:url';
import postgres from 'postgres';

async function run(sql: postgres.Sql): Promise<void> {
  const result = await sql`
    UPDATE document_events de
    SET
      document_type_id   = d.document_type_id,
      document_type_name = dt.name
    FROM documents d
    LEFT JOIN document_types dt ON dt.id = d.document_type_id
    WHERE de.document_id = d.id
      AND de.document_type_id IS NULL
      AND d.document_type_id IS NOT NULL
      AND d.deleted = false
  `;

  console.log(JSON.stringify({
    level: 'info',
    name: 'backfill-event-document-type',
    msg: 'backfill concluído',
    rowsUpdated: result.count,
  }));
}

async function main(): Promise<void> {
  const databaseUrl =
    process.env['DATABASE_URL'] ?? 'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc';

  console.log(JSON.stringify({
    level: 'info',
    name: 'backfill-event-document-type',
    msg: 'conectando ao PostgreSQL',
    databaseUrl,
  }));

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await run(sql);
  } finally {
    await sql.end();
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    console.error(JSON.stringify({
      level: 'error',
      name: 'backfill-event-document-type',
      msg: 'falha ao executar backfill',
      err: String(err),
    }));
    process.exitCode = 1;
  });
}
