import { migrateFresh } from '@dmdoc/db-pg';

/**
 * globalSetup do Vitest para a suíte de `apps/api`.
 *
 * Roda UMA vez, antes de qualquer arquivo de teste: aplica `migrate:fresh` no
 * banco de teste, garantindo um schema limpo e COMPLETO (todas as migrations,
 * incluindo 0004_ai_feature_flags e 0005_type_suggestion). Sem isso, os testes
 * de platform-settings/ai-feature-flags falhavam com "relation does not exist"
 * quando o `dmdoc_test` ficava para trás em relação ao repositório.
 *
 * SEGURANÇA: `migrate:fresh` DROPA o schema. Para nunca destruir o banco de
 * desenvolvimento por engano, este setup só roda contra um banco cujo nome
 * termine em `dmdoc_test` e resolve a URL a partir de `TEST_DATABASE_URL`
 * (nunca do `DATABASE_URL` de dev, que dentro do container aponta para o
 * banco `dmdoc`).
 */
function resolveTestDatabaseUrl(): string {
  const url =
    process.env['TEST_DATABASE_URL'] ??
    'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test';

  const dbName = url.split('/').pop()?.split('?')[0] ?? '';
  if (dbName !== 'dmdoc_test') {
    throw new Error(
      `global-setup: recusando migrate:fresh em banco que não é "dmdoc_test" (recebido: "${dbName}"). ` +
        'Defina TEST_DATABASE_URL apontando para o banco de teste.',
    );
  }
  return url;
}

export async function setup(): Promise<void> {
  const testUrl = resolveTestDatabaseUrl();
  // migrateFresh() lê DATABASE_URL do process.env — fixamos no alvo de teste.
  process.env['DATABASE_URL'] = testUrl;
  await migrateFresh();
}
