import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import {
  resolveDepartmentDocumentTypeCatalog,
  type DepartmentDocumentTypeCatalogItem,
} from './document-type-catalog.js';

/**
 * Testes de integração de `resolveDepartmentDocumentTypeCatalog` contra um
 * PostgreSQL real (banco `dmdoc_test`, migrado com o mesmo schema do dev).
 *
 * Regra de negócio: "Classificação de tipo por IA — catálogo e fallback sem
 * tipo compatível" (Fase 8). O catálogo oferecido à IA é TODOS os tipos
 * globais + os tipos da EMPRESA associados ao departamento do documento.
 *
 * Cobertura:
 * (a) retorna globais + tipos da empresa associados ao departamento;
 * (b) tipos GLOBAIS entram independentemente da associação por departamento,
 *     enquanto o tipo de EMPRESA de outro departamento continua fora;
 * (c) NÃO retorna tipo de EMPRESA de OUTRO tenant (globais não pertencem a
 *     tenant algum e por isso aparecem para qualquer um);
 * (d) exclui tipos com deleted = true.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgresql://dmdoc:dmdoc@localhost:5432/dmdoc_test';

const sql: Sql = postgres(DATABASE_URL);

// Prefixo de UUIDs para todos os fixtures deste arquivo, para limpeza segura.
const TENANT_A = 'd0c7a000-0000-0000-0000-0000000000a1';
const TENANT_B = 'd0c7a000-0000-0000-0000-0000000000b1';

const DEPT_A1 = 'd0c7de70-0000-0000-0000-0000000000a1'; // departamento alvo (tenant A)
const DEPT_A2 = 'd0c7de70-0000-0000-0000-0000000000a2'; // outro departamento (tenant A)
const DEPT_B1 = 'd0c7de70-0000-0000-0000-0000000000b1'; // departamento do tenant B

// Tipos de documento
const GLOBAL_VISIBLE = 'd0c779e0-0000-0000-0000-000000000001'; // global, visível em DEPT_A1
const GLOBAL_HIDDEN = 'd0c779e0-0000-0000-0000-000000000002'; // global, config só p/ DEPT_A2
const TYPE_A_DEPT1 = 'd0c779e0-0000-0000-0000-0000000000a1'; // tipo empresa A, em DEPT_A1
const TYPE_A_DEPT2 = 'd0c779e0-0000-0000-0000-0000000000a2'; // tipo empresa A, só em DEPT_A2
const TYPE_A_DELETED = 'd0c779e0-0000-0000-0000-0000000000a3'; // tipo empresa A, DEPT_A1, deleted
const TYPE_B_DEPT1 = 'd0c779e0-0000-0000-0000-0000000000b1'; // tipo empresa B (outro tenant)

const CONFIG_VISIBLE = 'd0c7c07f-0000-0000-0000-000000000001';
const CONFIG_HIDDEN = 'd0c7c07f-0000-0000-0000-000000000002';
const CONFIG_TENANT_B = 'd0c7c07f-0000-0000-0000-000000000003';

async function cleanup(): Promise<void> {
  await sql`DELETE FROM global_type_tenant_depts WHERE id = ANY(${[
    CONFIG_VISIBLE,
    CONFIG_HIDDEN,
    CONFIG_TENANT_B,
  ]}::uuid[])`;
  await sql`DELETE FROM document_types WHERE id = ANY(${[
    GLOBAL_VISIBLE,
    GLOBAL_HIDDEN,
    TYPE_A_DEPT1,
    TYPE_A_DEPT2,
    TYPE_A_DELETED,
    TYPE_B_DEPT1,
  ]}::uuid[])`;
  await sql`DELETE FROM departments WHERE id = ANY(${[DEPT_A1, DEPT_A2, DEPT_B1]}::uuid[])`;
  await sql`DELETE FROM tenants WHERE id = ANY(${[TENANT_A, TENANT_B]}::uuid[])`;
}

beforeAll(async () => {
  await cleanup();

  await sql`INSERT INTO tenants (id, name, disk_quota_bytes, user_quota)
    VALUES (${TENANT_A}, 'Empresa Catalogo A', ${1_000_000}, ${10}),
           (${TENANT_B}, 'Empresa Catalogo B', ${1_000_000}, ${10})`;

  await sql`INSERT INTO departments (id, tenant_id, name, level) VALUES
    (${DEPT_A1}, ${TENANT_A}, 'Financeiro A', 0),
    (${DEPT_A2}, ${TENANT_A}, 'Juridico A', 0),
    (${DEPT_B1}, ${TENANT_B}, 'Financeiro B', 0)`;

  // Tipos globais (tenant_id NULL). GLOBAL_VISIBLE carrega sinais de
  // reconhecimento (Fase 8, epic E-1) para provar que fluem pelo catálogo.
  await sql`INSERT INTO document_types (id, tenant_id, name, description, recognition_keywords, recognition_rules, is_global, department_ids) VALUES
    (${GLOBAL_VISIBLE}, NULL, 'Contrato Global', 'Contrato padrao da plataforma', ${['clausula', 'partes contratantes']}::text[], 'NAO classifique como Recibo.', true, NULL),
    (${GLOBAL_HIDDEN}, NULL, 'Boleto Global', 'Boleto padrao da plataforma', '{}'::text[], NULL, true, NULL)`;

  // Configs de visibilidade de tipos globais por tenant/departamento.
  // Tenant A vê GLOBAL_VISIBLE em DEPT_A1 e GLOBAL_HIDDEN só em DEPT_A2.
  await sql`INSERT INTO global_type_tenant_depts (id, global_type_id, tenant_id, department_ids) VALUES
    (${CONFIG_VISIBLE}, ${GLOBAL_VISIBLE}, ${TENANT_A}, ${[DEPT_A1]}::uuid[]),
    (${CONFIG_HIDDEN}, ${GLOBAL_HIDDEN}, ${TENANT_A}, ${[DEPT_A2]}::uuid[])`;

  // Tenant B tem config do MESMO tipo global apontando para DEPT_B1 — não deve
  // vazar quando consultamos o tenant A / DEPT_A1.
  await sql`INSERT INTO global_type_tenant_depts (id, global_type_id, tenant_id, department_ids) VALUES
    (${CONFIG_TENANT_B}, ${GLOBAL_VISIBLE}, ${TENANT_B}, ${[DEPT_B1]}::uuid[])`;

  // Tipos de empresa (denormalizados com department_ids).
  await sql`INSERT INTO document_types (id, tenant_id, name, description, is_global, department_ids, deleted) VALUES
    (${TYPE_A_DEPT1}, ${TENANT_A}, 'Nota Fiscal A', 'NF do financeiro', false, ${[DEPT_A1]}::uuid[], false),
    (${TYPE_A_DEPT2}, ${TENANT_A}, 'Peticao A', 'Peticao do juridico', false, ${[DEPT_A2]}::uuid[], false),
    (${TYPE_A_DELETED}, ${TENANT_A}, 'Tipo Excluido A', 'nao deve aparecer', false, ${[DEPT_A1]}::uuid[], true),
    (${TYPE_B_DEPT1}, ${TENANT_B}, 'Nota Fiscal B', 'NF do tenant B', false, ${[DEPT_B1]}::uuid[], false)`;
});

afterAll(async () => {
  await cleanup();
  await sql.end();
});

describe('resolveDepartmentDocumentTypeCatalog', () => {
  it('(a) retorna globais visíveis + tipos da empresa associados ao departamento, com description', async () => {
    const result = await resolveDepartmentDocumentTypeCatalog(sql, TENANT_A, DEPT_A1);

    const ids = result.map((r) => r.id);
    expect(ids).toContain(GLOBAL_VISIBLE);
    expect(ids).toContain(TYPE_A_DEPT1);

    const contrato = result.find((r) => r.id === GLOBAL_VISIBLE);
    expect(contrato).toEqual<DepartmentDocumentTypeCatalogItem>({
      id: GLOBAL_VISIBLE,
      name: 'Contrato Global',
      description: 'Contrato padrao da plataforma',
      recognitionKeywords: ['clausula', 'partes contratantes'],
      recognitionRules: 'NAO classifique como Recibo.',
    });

    const nf = result.find((r) => r.id === TYPE_A_DEPT1);
    expect(nf?.description).toBe('NF do financeiro');
    // Tipo de empresa sem sinais definidos: defaults seguros do banco.
    expect(nf?.recognitionKeywords).toEqual([]);
    expect(nf?.recognitionRules).toBeNull();
  });

  it('(b) tipo GLOBAL entra mesmo sem associação ao departamento; tipo de EMPRESA de outro departamento fica fora', async () => {
    const result = await resolveDepartmentDocumentTypeCatalog(sql, TENANT_A, DEPT_A1);
    const ids = result.map((r) => r.id);

    // Tipo da empresa associado só a DEPT_A2 — escopo por departamento continua
    // valendo integralmente para tipos de empresa.
    expect(ids).not.toContain(TYPE_A_DEPT2);
    // Global cuja config no tenant A aponta só para DEPT_A2: a associação não
    // restringe mais o catálogo da IA, então ele É candidato aqui.
    expect(ids).toContain(GLOBAL_HIDDEN);
  });

  it('(c) NÃO retorna tipo de EMPRESA de outro tenant (mas globais, que não têm dono, aparecem)', async () => {
    const result = await resolveDepartmentDocumentTypeCatalog(sql, TENANT_A, DEPT_A1);
    const ids = result.map((r) => r.id);

    // Tipo de empresa do tenant B: isolamento multi-tenant inegociável.
    expect(ids).not.toContain(TYPE_B_DEPT1);

    // Consultar o tenant B com o departamento do tenant A não traz NENHUM tipo
    // de empresa (nem de A nem de B, que é de outro departamento) — só globais,
    // que pertencem à plataforma e não a uma empresa.
    const crossTenant = await resolveDepartmentDocumentTypeCatalog(sql, TENANT_B, DEPT_A1);
    const crossIds = crossTenant.map((r) => r.id);
    expect(crossIds).not.toContain(TYPE_A_DEPT1);
    expect(crossIds).not.toContain(TYPE_A_DEPT2);
    expect(crossIds).not.toContain(TYPE_B_DEPT1);
    expect(crossTenant.every((r) => r.id === GLOBAL_VISIBLE || r.id === GLOBAL_HIDDEN)).toBe(true);
  });

  it('(d) exclui tipos com deleted = true', async () => {
    const result = await resolveDepartmentDocumentTypeCatalog(sql, TENANT_A, DEPT_A1);
    const ids = result.map((r) => r.id);
    expect(ids).not.toContain(TYPE_A_DELETED);
  });

  it('DEPT_A2 vê os globais e o tipo de empresa daquele departamento', async () => {
    const result = await resolveDepartmentDocumentTypeCatalog(sql, TENANT_A, DEPT_A2);
    const ids = result.map((r) => r.id);

    // Ambos os globais são candidatos em qualquer departamento.
    expect(ids).toContain(GLOBAL_HIDDEN);
    expect(ids).toContain(GLOBAL_VISIBLE);
    expect(ids).toContain(TYPE_A_DEPT2);
    // O tipo de EMPRESA de DEPT_A1 continua fora.
    expect(ids).not.toContain(TYPE_A_DEPT1);
  });
});
