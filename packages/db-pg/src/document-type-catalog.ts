import type { Sql } from 'postgres';

/**
 * Helper compartilhado (API + worker) para resolver o CATÁLOGO de tipos de
 * documento oferecido à classificação automática de tipo por IA (Fase 8):
 *
 * 1. TODOS os tipos GLOBAIS (`is_global = true`, `tenant_id IS NULL`) — a
 *    associação por departamento (`global_type_tenant_depts`) NÃO restringe o
 *    catálogo da IA.
 * 2. Tipos da EMPRESA (`tenant_id = tenantId`) cujo `department_ids`
 *    denormalizado contenha o `departmentId`.
 *
 * Todos com `deleted = false`.
 *
 * Tipos globais entram SEMPRE (decisão do Owner, 2026-07-25). Antes, um global
 * só era candidato quando o tenant o tivesse associado àquele departamento — o
 * que produzia o cenário em que a empresa tem um tipo global "Nota Fiscal"
 * perfeitamente aplicável, o usuário o vê no seletor, e a IA responde "nenhum
 * tipo compatível" porque nunca o recebeu. Tipos globais são da plataforma e
 * visíveis a todos, então passam a ser candidatos em qualquer departamento.
 *
 * O escopo por departamento continua valendo integralmente para os tipos da
 * EMPRESA: a IA nunca vê um tipo de empresa de departamento não relacionado, e
 * nunca vê tipo de outro tenant.
 *
 * NOTA: a variante `GET /document-types?departmentId=` (listagem de UI) mantém
 * a regra antiga, exigindo a associação — ela controla o que o usuário vê, não
 * o que a IA considera. Os dois deixaram de ser a mesma regra.
 *
 * Regra de negócio: "Classificação de tipo por IA — catálogo e fallback sem
 * tipo compatível" e "Tipos de documento globais e por empresa".
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
 * Resolve o catálogo de tipos de documento candidatos à classificação por IA.
 *
 * Uma única query cobre os dois escopos (todos os globais + tipos da empresa
 * associados ao departamento), com `deleted = false` e sem duplicatas.
 *
 * @param sql          Cliente postgres.js (pool de conexões).
 * @param tenantId     UUID da empresa dona do documento — filtro de isolamento
 *                     dos tipos DE EMPRESA (globais não pertencem a ninguém).
 * @param departmentId UUID do departamento do documento — escopo dos tipos de
 *                     empresa.
 * @returns Tipos candidatos ordenados por nome; array vazio se nenhum se aplica.
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
        -- 1) TODOS os tipos globais — a associação por departamento não
        --    restringe o catálogo da IA (Owner, 2026-07-25)
        (dt.is_global = true AND dt.tenant_id IS NULL)
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
