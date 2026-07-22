import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { resolveAiFeatureFlags, TenantNotFoundError, type AiFeatureFlags } from './ai-feature-flags.js';

/**
 * Testes de integração de `resolveAiFeatureFlags` contra um PostgreSQL real
 * (banco `dmdoc_test`, migrado com o mesmo schema do dev — inclui a
 * migration 0004_ai_feature_flags.sql).
 *
 * Regra de negócio: "Liga/desliga de recursos de IA — dois níveis e
 * granularidade por feature" (Fases 7/8/8.1) — valor efetivo de cada feature
 * = platform_settings.<feature> AND tenants.<feature>.
 *
 * `platform_settings` é um SINGLETON compartilhado por todo o banco de teste.
 * Para não vazar estado entre testes (e não quebrar `platform-settings.test.ts`,
 * que assume os 3 valores em `true`), cada teste que precisa de um cenário
 * com a plataforma desligada restaura os 3 valores para `true` em `afterEach`.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test';

const sql: Sql = postgres(DATABASE_URL);

const TEST_TENANT_ID = 'c0ffee00-0000-0000-0000-0000000000f2';
const NON_EXISTENT_TENANT_ID = 'c0ffee00-0000-0000-0000-00000000dead';

async function setPlatformSettings(flags: AiFeatureFlags): Promise<void> {
  await sql`
    UPDATE platform_settings
       SET ai_classification_enabled = ${flags.classificationEnabled},
           ai_title_suggestion_enabled = ${flags.titleSuggestionEnabled},
           ai_index_suggestion_enabled = ${flags.indexSuggestionEnabled},
           ai_tag_generation_enabled = ${flags.tagGenerationEnabled}
  `;
}

async function setTenantSettings(tenantId: string, flags: AiFeatureFlags): Promise<void> {
  await sql`
    UPDATE tenants
       SET ai_classification_enabled = ${flags.classificationEnabled},
           ai_title_suggestion_enabled = ${flags.titleSuggestionEnabled},
           ai_index_suggestion_enabled = ${flags.indexSuggestionEnabled},
           ai_tag_generation_enabled = ${flags.tagGenerationEnabled}
     WHERE id = ${tenantId}
  `;
}

const ALL_TRUE: AiFeatureFlags = {
  classificationEnabled: true,
  titleSuggestionEnabled: true,
  indexSuggestionEnabled: true,
  tagGenerationEnabled: true,
};

beforeAll(async () => {
  await sql`DELETE FROM tenants WHERE id = ${TEST_TENANT_ID}`;
  await sql`
    INSERT INTO tenants (id, name, disk_quota_bytes, user_quota)
    VALUES (${TEST_TENANT_ID}, 'Empresa Teste Resolve AI Flags', ${1_000_000}, ${10})
  `;
});

afterEach(async () => {
  // Restaura o singleton global e o tenant de teste para o default (tudo
  // habilitado), evitando vazamento de estado para outros testes/arquivos.
  await setPlatformSettings(ALL_TRUE);
  await setTenantSettings(TEST_TENANT_ID, ALL_TRUE);
});

afterAll(async () => {
  await sql`DELETE FROM tenants WHERE id = ${TEST_TENANT_ID}`;
  await sql.end();
});

describe('resolveAiFeatureFlags', () => {
  it('platform=true, tenant=true → efetivo true nas 3 features', async () => {
    await setPlatformSettings(ALL_TRUE);
    await setTenantSettings(TEST_TENANT_ID, ALL_TRUE);

    const result = await resolveAiFeatureFlags(sql, TEST_TENANT_ID);

    expect(result).toEqual<AiFeatureFlags>({
      classificationEnabled: true,
      titleSuggestionEnabled: true,
      indexSuggestionEnabled: true,
      tagGenerationEnabled: true,
    });
  });

  it('platform=false, tenant=true → efetivo false nas 3 features', async () => {
    await setPlatformSettings({
      classificationEnabled: false,
      titleSuggestionEnabled: false,
      indexSuggestionEnabled: false,
      tagGenerationEnabled: false,
    });
    await setTenantSettings(TEST_TENANT_ID, ALL_TRUE);

    const result = await resolveAiFeatureFlags(sql, TEST_TENANT_ID);

    expect(result).toEqual<AiFeatureFlags>({
      classificationEnabled: false,
      titleSuggestionEnabled: false,
      indexSuggestionEnabled: false,
      tagGenerationEnabled: false,
    });
  });

  it('platform=true, tenant=false → efetivo false nas 3 features', async () => {
    await setPlatformSettings(ALL_TRUE);
    await setTenantSettings(TEST_TENANT_ID, {
      classificationEnabled: false,
      titleSuggestionEnabled: false,
      indexSuggestionEnabled: false,
      tagGenerationEnabled: false,
    });

    const result = await resolveAiFeatureFlags(sql, TEST_TENANT_ID);

    expect(result).toEqual<AiFeatureFlags>({
      classificationEnabled: false,
      titleSuggestionEnabled: false,
      indexSuggestionEnabled: false,
      tagGenerationEnabled: false,
    });
  });

  it('platform=false, tenant=false → efetivo false nas 3 features', async () => {
    await setPlatformSettings({
      classificationEnabled: false,
      titleSuggestionEnabled: false,
      indexSuggestionEnabled: false,
      tagGenerationEnabled: false,
    });
    await setTenantSettings(TEST_TENANT_ID, {
      classificationEnabled: false,
      titleSuggestionEnabled: false,
      indexSuggestionEnabled: false,
      tagGenerationEnabled: false,
    });

    const result = await resolveAiFeatureFlags(sql, TEST_TENANT_ID);

    expect(result).toEqual<AiFeatureFlags>({
      classificationEnabled: false,
      titleSuggestionEnabled: false,
      indexSuggestionEnabled: false,
      tagGenerationEnabled: false,
    });
  });

  it('combinação mista por feature: cada uma respeita seu próprio par (plataforma AND empresa)', async () => {
    await setPlatformSettings({
      classificationEnabled: true,
      titleSuggestionEnabled: false,
      indexSuggestionEnabled: true,
      tagGenerationEnabled: true,
    });
    await setTenantSettings(TEST_TENANT_ID, {
      classificationEnabled: false,
      titleSuggestionEnabled: true,
      indexSuggestionEnabled: true,
      tagGenerationEnabled: true,
    });

    const result = await resolveAiFeatureFlags(sql, TEST_TENANT_ID);

    expect(result).toEqual<AiFeatureFlags>({
      classificationEnabled: false, // true AND false
      titleSuggestionEnabled: false, // false AND true
      indexSuggestionEnabled: true, // true AND true
      tagGenerationEnabled: true,
    });
  });

  it('lança TenantNotFoundError quando o tenantId não existe', async () => {
    await expect(resolveAiFeatureFlags(sql, NON_EXISTENT_TENANT_ID)).rejects.toThrow(TenantNotFoundError);
  });

  it('lança TenantNotFoundError quando o tenant existe mas está excluído logicamente', async () => {
    await sql`UPDATE tenants SET deleted = true WHERE id = ${TEST_TENANT_ID}`;

    try {
      await expect(resolveAiFeatureFlags(sql, TEST_TENANT_ID)).rejects.toThrow(TenantNotFoundError);
    } finally {
      await sql`UPDATE tenants SET deleted = false WHERE id = ${TEST_TENANT_ID}`;
    }
  });
});
