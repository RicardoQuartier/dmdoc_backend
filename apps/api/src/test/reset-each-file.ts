import { beforeAll } from 'vitest';
import { createPgClient } from '@dmdoc/db-pg';
import { resetDomainTables } from './helpers.js';

/**
 * setupFile do Vitest aplicado a TODA suíte de `apps/api`.
 *
 * Os arquivos de teste compartilham o mesmo Postgres (`dmdoc_test`). Sem um
 * ponto de partida limpo, o estado semeado por um arquivo (ou deixado por uma
 * asserção que falhou antes do cleanup) vazava para o próximo, causando uma
 * cascata de falhas por violação de FK e colisão de dados.
 *
 * Este setup zera TODAS as tabelas de domínio ANTES de cada arquivo rodar
 * (`beforeAll`). Combinado com `fileParallelism: false` no vitest.config,
 * garante que cada arquivo comece de um estado determinístico, isolado dos
 * demais — inclusive os que semeiam em `beforeAll` (que não fazem reset por
 * teste).
 */

const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test';

beforeAll(async () => {
  const db = createPgClient(TEST_DATABASE_URL);
  try {
    await resetDomainTables(db);
  } finally {
    await db.end();
  }
});
