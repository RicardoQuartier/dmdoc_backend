import { pathToFileURL } from 'node:url';
import postgres from 'postgres';

/**
 * Preenche `document_events` ausentes: documentos que existem em `documents`
 * mas não têm nenhum evento de upload correspondente (gap causado por falhas
 * silenciosas históricas de `emitUploadEvent()`).
 *
 * Sem esse evento, o upload nunca aparece em relatórios de uso/faturamento
 * (`reports.ts`/`usage.ts` leem exclusivamente de `document_events`).
 *
 * Propositalmente NÃO filtra `d.deleted = false`: o evento representa "o
 * upload aconteceu" — um documento excluído depois não muda esse fato, e é
 * justamente o caso em que a lacuna mais prejudica auditoria/faturamento.
 *
 * Idempotente via `LEFT JOIN document_events de ... WHERE de.id IS NULL`:
 * rodar duas vezes seguidas não duplica nada na segunda execução.
 *
 * Uso standalone: `pnpm --filter @dmdoc/db-pg backfill:missing-document-events`
 * Uso via artisan: `pnpm run artisan backfill:missing-document-events`
 */
export async function run(sql: postgres.Sql): Promise<void> {
  const [gapRow] = await sql<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count
    FROM documents d
    LEFT JOIN document_events de ON de.document_id = d.id
    WHERE de.id IS NULL
  `;

  console.log(JSON.stringify({
    level: 'info',
    name: 'backfill-missing-document-events',
    msg: 'gap de document_events encontrado',
    gapCount: gapRow?.count ?? 0,
  }));

  const result = await sql`
    INSERT INTO document_events (
      id, tenant_id, document_id, uploaded_by_id, event_type,
      mime_type, document_type_id, document_type_name,
      size_bytes, page_count, deduplicated, created_at
    )
    SELECT
      gen_random_uuid(), d.tenant_id, d.id, d.uploaded_by_id, 'upload',
      d.mime_type, d.document_type_id, dt.name,
      d.size_bytes, (dc.extraction->>'pageCount')::int, false, d.uploaded_at
    FROM documents d
    LEFT JOIN document_types dt   ON dt.id = d.document_type_id
    LEFT JOIN document_content dc ON dc.document_id = d.id
    LEFT JOIN document_events de  ON de.document_id = d.id
    WHERE de.id IS NULL
  `;

  console.log(JSON.stringify({
    level: 'info',
    name: 'backfill-missing-document-events',
    msg: 'backfill concluído',
    rowsInserted: result.count,
  }));
}

async function main(): Promise<void> {
  const databaseUrl =
    process.env['DATABASE_URL'] ?? 'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc';

  console.log(JSON.stringify({
    level: 'info',
    name: 'backfill-missing-document-events',
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
      name: 'backfill-missing-document-events',
      msg: 'falha ao executar backfill',
      err: String(err),
    }));
    process.exitCode = 1;
  });
}
