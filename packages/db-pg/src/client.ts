import postgres from 'postgres';

/**
 * Cria um cliente postgres.js com configurações padronizadas de pool.
 *
 * @param connectionString - Connection string PostgreSQL completa.
 *   Ex.: postgresql://dmdoc:dmdoc@localhost:5432/dmdoc
 *
 * Configurações:
 *   max: 10 conexões no pool (adequado para API + worker em dev e prod)
 *   idle_timeout: 30s — fecha conexões ociosas após 30 segundos
 *   connect_timeout: 10s — falha rapidamente se o servidor não responder
 */
export function createPgClient(connectionString: string): postgres.Sql {
  return postgres(connectionString, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
  });
}

export type { Sql } from 'postgres';
