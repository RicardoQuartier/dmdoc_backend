import { pathToFileURL } from 'node:url';
import postgres from 'postgres';

/**
 * Backfill idempotente: popula `document_type_index_fields` (tabela
 * normalizada, fonte de verdade atual) a partir dos elementos do array JSONB
 * legado `document_types.index_fields`.
 *
 * Reaproveita o `id` já presente em cada elemento do JSONB — `ON CONFLICT (id)
 * DO NOTHING` torna a operação segura para rodar mais de uma vez (elementos
 * já migrados não são duplicados nem sobrescritos).
 *
 * Mapeamento de campos (camelCase do JSONB → snake_case da tabela):
 *   id → id (reaproveitado)
 *   name → name
 *   fieldType → field_type
 *   required → required
 *   aiExtractionHint → ai_extraction_hint
 *   order → sort_order
 *   showOnSearch → show_on_search
 *   deleted → deleted
 */
async function run(sql: postgres.Sql): Promise<void> {
  const result = await sql`
    INSERT INTO document_type_index_fields (
      id, document_type_id, name, field_type, required, ai_extraction_hint, sort_order, show_on_search, deleted
    )
    SELECT
      (elem->>'id')::uuid,
      dt.id,
      elem->>'name',
      elem->>'fieldType',
      (elem->>'required')::boolean,
      elem->>'aiExtractionHint',
      COALESCE((elem->>'order')::integer, 0),
      COALESCE((elem->>'showOnSearch')::boolean, true),
      COALESCE((elem->>'deleted')::boolean, false)
    FROM document_types dt,
      LATERAL jsonb_array_elements(dt.index_fields) AS elem
    WHERE jsonb_typeof(dt.index_fields) = 'array'
    ON CONFLICT (id) DO NOTHING
  `;

  console.log(JSON.stringify({
    level: 'info',
    name: 'backfill-document-type-index-fields',
    msg: 'backfill concluído',
    rowsInserted: result.count,
  }));
}

async function main(): Promise<void> {
  const databaseUrl =
    process.env['DATABASE_URL'] ?? 'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc';

  console.log(JSON.stringify({
    level: 'info',
    name: 'backfill-document-type-index-fields',
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
      name: 'backfill-document-type-index-fields',
      msg: 'falha ao executar backfill',
      err: String(err),
    }));
    process.exitCode = 1;
  });
}
