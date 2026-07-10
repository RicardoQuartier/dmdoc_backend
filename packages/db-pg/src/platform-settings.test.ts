import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';

/**
 * Testes de integração da migration 0004_ai_feature_flags (contra um
 * PostgreSQL real — banco `dmdoc_test`, migrado com o mesmo schema do dev).
 *
 * Cobertura:
 * - `platform_settings` nasce com exatamente 1 linha (seed da migration),
 *   com as 3 features de IA habilitadas por padrão.
 * - Invariante de singleton: uma segunda linha não pode ser inserida
 *   (índice único parcial `uniq_platform_settings_singleton`).
 * - `tenants` novos recebem as 3 mesmas flags como `true` por default quando
 *   não especificadas no INSERT.
 *
 * Regra de negócio: "Controle de features de IA por plataforma e empresa"
 * (Fases 7/8/8.1) — valor efetivo de cada feature = platform_settings.<feature>
 * AND tenants.<feature>.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test';

const sql: Sql = postgres(DATABASE_URL);

const TEST_TENANT_ID = 'c0ffee00-0000-0000-0000-0000000000f1';

beforeAll(async () => {
  // Garante isolamento caso um teste anterior tenha deixado resíduo.
  await sql`DELETE FROM tenants WHERE id = ${TEST_TENANT_ID}`;
});

afterAll(async () => {
  await sql`DELETE FROM tenants WHERE id = ${TEST_TENANT_ID}`;
  await sql.end();
});

describe('platform_settings (singleton)', () => {
  it('a migration cria a linha singleton com os 3 valores true por default', async () => {
    const rows = await sql<
      Array<{
        ai_classification_enabled: boolean;
        ai_title_suggestion_enabled: boolean;
        ai_index_suggestion_enabled: boolean;
      }>
    >`
      SELECT ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled
      FROM platform_settings
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ai_classification_enabled: true,
      ai_title_suggestion_enabled: true,
      ai_index_suggestion_enabled: true,
    });
  });

  it('impede a inserção de uma segunda linha (invariante de singleton)', async () => {
    await expect(
      sql`
        INSERT INTO platform_settings (
          ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled
        ) VALUES (false, false, false)
      `,
    ).rejects.toThrow();

    // Confirma que a tentativa falha não deixou uma segunda linha para trás.
    const rows = await sql`SELECT id FROM platform_settings`;
    expect(rows).toHaveLength(1);
  });
});

describe('tenants — defaults das flags de IA', () => {
  it('tenant novo recebe os 3 valores true por default quando não especificados', async () => {
    await sql`
      INSERT INTO tenants (id, name, disk_quota_bytes, user_quota)
      VALUES (${TEST_TENANT_ID}, 'Empresa Teste AI Flags', ${1_000_000}, ${10})
    `;

    const rows = await sql<
      Array<{
        ai_classification_enabled: boolean;
        ai_title_suggestion_enabled: boolean;
        ai_index_suggestion_enabled: boolean;
      }>
    >`
      SELECT ai_classification_enabled, ai_title_suggestion_enabled, ai_index_suggestion_enabled
      FROM tenants WHERE id = ${TEST_TENANT_ID}
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ai_classification_enabled: true,
      ai_title_suggestion_enabled: true,
      ai_index_suggestion_enabled: true,
    });
  });
});
