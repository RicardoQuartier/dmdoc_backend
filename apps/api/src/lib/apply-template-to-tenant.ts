import type { Sql } from '@dmdoc/db-pg';
import { newId } from '@dmdoc/db-pg';
import type { FastifyBaseLogger } from 'fastify';
import type { TemplateNode } from '@dmdoc/shared-types';
import { NotFoundError } from '../errors/index.js';

/**
 * Documento de departamento criado a partir de um nó de template.
 */
interface DepartmentInsertRow {
  id: string;
  tenantId: string;
  parentId: string | null;
  name: string;
  level: number;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  deleted: false;
}

/**
 * Aplica um template de departamentos a um tenant recém-criado, inserindo
 * os nós do template como departamentos reais na tabela `departments`.
 *
 * A atomicidade em relação à criação do tenant é garantida pelo chamador via
 * sql.begin() (postgres.js). O parâmetro `sql` deve ser o cliente já dentro
 * da transação quando aplicável.
 *
 * Invariantes:
 * - `templateId` deve existir em `department_templates`; se não, lança
 *   `NotFoundError` (a transação faz rollback automático).
 * - Cada nó recebe um `id` uuid novo — os `refId`/`parentRefId` do template
 *   são internos e nunca aparecem nos registros finais.
 * - A ordem do array `nodes` garante que o pai já foi mapeado antes do filho.
 * - `level` é calculado recursivamente pelo mapa: raiz = 0, filho = pai + 1.
 *
 * @param sql         Instância postgres.js (pool ou transação ativa).
 * @param tenantId    UUID do tenant para o qual os departamentos serão criados.
 * @param templateId  UUID do template a aplicar.
 * @param logger      Logger Fastify com contexto já pré-formatado.
 */
export async function applyTemplateToTenant(
  sql: Sql,
  tenantId: string,
  templateId: string,
  logger: FastifyBaseLogger,
): Promise<void> {
  // 1. Buscar o template (sem filtro de tenant — templates são globais).
  const templateRows = await sql<Array<{ id: string; nodes: unknown }>>`
    SELECT id, nodes
    FROM department_templates
    WHERE id = ${templateId}
    LIMIT 1
  `;

  const templateDoc = templateRows[0];
  if (!templateDoc) {
    throw new NotFoundError('Template de departamentos não encontrado');
  }

  const nodes = templateDoc.nodes as TemplateNode[];

  if (nodes.length === 0) {
    logger.info({ tenantId, templateId, deptCount: 0 }, 'template sem nós; nenhum departamento criado');
    return;
  }

  // 2. Sort topológico: garante que pais aparecem antes dos filhos.
  const sorted = topologicalSort(nodes);

  // 3. Mapear refId → novoId e calcular level de cada nó.
  const refIdToNewId = new Map<string, string>();
  const refIdToLevel = new Map<string, number>();

  const now = new Date();
  const rows: DepartmentInsertRow[] = [];

  for (const node of sorted) {
    const newDeptId = newId();
    refIdToNewId.set(node.refId, newDeptId);

    let level = 0;
    let parentId: string | null = null;

    if (node.parentRefId !== null) {
      const resolvedParentId = refIdToNewId.get(node.parentRefId);
      const parentLevel = refIdToLevel.get(node.parentRefId);

      if (resolvedParentId === undefined || parentLevel === undefined) {
        throw new Error(
          `Template inválido: parentRefId "${node.parentRefId}" do nó "${node.refId}" não foi encontrado após sort topológico`,
        );
      }

      parentId = resolvedParentId;
      level = parentLevel + 1;
    }

    refIdToLevel.set(node.refId, level);

    rows.push({
      id: newDeptId,
      tenantId,
      parentId,
      name: node.name,
      level,
      tags: node.tags,
      createdAt: now,
      updatedAt: now,
      deleted: false,
    });
  }

  // 4. Bulk insert na tabela departments.
  for (const row of rows) {
    await sql`
      INSERT INTO departments (id, tenant_id, parent_id, name, level, tags, created_at, updated_at, deleted)
      VALUES (
        ${row.id},
        ${row.tenantId},
        ${row.parentId},
        ${row.name},
        ${row.level},
        ${row.tags},
        ${row.createdAt},
        ${row.updatedAt},
        ${row.deleted}
      )
    `;
  }

  logger.info(
    { tenantId, templateId, deptCount: rows.length },
    'tenant criado com template; departamentos inseridos',
  );
}

/**
 * Ordena os nós do template topologicamente: raízes primeiro, filhos depois.
 *
 * Algoritmo BFS (Kahn): percorre nós sem parent pendente na fila, depois
 * processa os filhos cujos pais já foram emitidos.
 */
function topologicalSort(nodes: TemplateNode[]): TemplateNode[] {
  const nodeByRefId = new Map<string, TemplateNode>();
  const childrenOf = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const node of nodes) {
    nodeByRefId.set(node.refId, node);
    inDegree.set(node.refId, node.parentRefId === null ? 0 : 1);

    if (node.parentRefId !== null) {
      const siblings = childrenOf.get(node.parentRefId) ?? [];
      siblings.push(node.refId);
      childrenOf.set(node.parentRefId, siblings);
    }
  }

  const queue: string[] = [];
  for (const [refId, degree] of inDegree.entries()) {
    if (degree === 0) queue.push(refId);
  }

  const result: TemplateNode[] = [];

  while (queue.length > 0) {
    const refId = queue.shift()!;
    const node = nodeByRefId.get(refId);
    if (!node) continue;
    result.push(node);

    for (const childRefId of childrenOf.get(refId) ?? []) {
      const remaining = (inDegree.get(childRefId) ?? 1) - 1;
      inDegree.set(childRefId, remaining);
      if (remaining === 0) {
        queue.push(childRefId);
      }
    }
  }

  if (result.length !== nodes.length) {
    throw new Error('Template com ciclo detectado no sort topológico');
  }

  return result;
}
