import type { Sql } from 'postgres';

/**
 * Helper compartilhado (API + worker) para resolver o CATÁLOGO de tipos de
 * documento visíveis para UM departamento — a base do prompt de classificação
 * automática de tipo por IA (Fase 8).
 *
 * Reproduz EXATAMENTE a regra de visibilidade que `GET /document-types`
 * (`apps/api/src/routes/document-types.ts`) aplica para um usuário
 * UPLOADER/USER, porém escopada a um único departamento (o departamento do
 * documento sendo classificado):
 *
 * 1. Tipos GLOBAIS (`is_global = true`, `tenant_id IS NULL`) visíveis para o
 *    departamento — ou seja, aqueles com uma configuração em
 *    `global_type_tenant_depts` do próprio tenant (`deleted = false`) cujo
 *    `department_ids` contenha o `departmentId`.
 * 2. Tipos da EMPRESA (`tenant_id = tenantId`) cujo `department_ids` denormalizado
 *    contenha o `departmentId`.
 *
 * Todos com `deleted = false`. Nunca vaza tipo de outro tenant nem de um
 * departamento não relacionado.
 *
 * Regra de negócio: "Como a IA escolhe entre os tipos de documento existentes"
 * e "Tipos de documento globais e por empresa" — o catálogo oferecido à IA é
 * escopado pelo departamento do documento, a mesma visibilidade de
 * `GET /document-types`.
 */

/**
 * Item do catálogo de tipos visíveis para um departamento. `description` é a
 * dica de classificação usada no prompt da IA.
 */
export interface DepartmentDocumentTypeCatalogItem {
  id: string;
  name: string;
  description: string | null;
  /**
   * Palavras/expressões-sinal do tipo (Fase 8, epic E-1). Reforçam a
   * classificação por IA na desambiguação de tipos parecidos. `[]` quando o
   * tipo não define nenhuma.
   */
  recognitionKeywords: string[];
  /**
   * Regras de desambiguação em texto livre — inclusive negativas
   * ("NÃO classifique como X se..."). `null` quando o tipo não define.
   */
  recognitionRules: string | null;
}

/** Linha crua devolvida pela query (colunas em snake_case do postgres.js). */
interface CatalogRow {
  id: string;
  name: string;
  description: string | null;
  recognition_keywords: string[];
  recognition_rules: string | null;
}

/**
 * Resolve o catálogo de tipos de documento visíveis para um departamento.
 *
 * Uma única query cobre os dois escopos (globais visíveis + tipos da empresa
 * associados ao departamento), com `deleted = false` e sem duplicatas.
 *
 * @param sql          Cliente postgres.js (pool de conexões).
 * @param tenantId     UUID da empresa dona do documento — filtro de isolamento.
 * @param departmentId UUID do departamento do documento — escopo de visibilidade.
 * @returns Tipos visíveis ordenados por nome; array vazio se nenhum se aplica.
 */
export async function resolveDepartmentDocumentTypeCatalog(
  sql: Sql,
  tenantId: string,
  departmentId: string
): Promise<DepartmentDocumentTypeCatalogItem[]> {
  const rows = await sql<CatalogRow[]>`
    SELECT DISTINCT dt.id, dt.name, dt.description,
                    dt.recognition_keywords, dt.recognition_rules
    FROM document_types dt
    WHERE dt.deleted = false
      AND (
        -- 1) Tipos globais visíveis para este departamento neste tenant
        (
          dt.is_global = true
          AND dt.tenant_id IS NULL
          AND EXISTS (
            SELECT 1
            FROM global_type_tenant_depts g
            WHERE g.global_type_id = dt.id
              AND g.tenant_id = ${tenantId}
              AND g.deleted = false
              AND g.department_ids && ${[departmentId]}::uuid[]
          )
        )
        -- 2) Tipos da empresa associados a este departamento
        OR (
          dt.tenant_id = ${tenantId}
          AND dt.department_ids && ${[departmentId]}::uuid[]
        )
      )
    ORDER BY dt.name ASC
  `;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    recognitionKeywords: r.recognition_keywords ?? [],
    recognitionRules: r.recognition_rules,
  }));
}
