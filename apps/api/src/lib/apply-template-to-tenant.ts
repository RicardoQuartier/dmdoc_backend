import type { Db } from 'mongodb';
import type { FastifyBaseLogger } from 'fastify';
import { newId } from '@dmdoc/db-mongo';
import type { TemplateNode } from '@dmdoc/shared-types';
import { NotFoundError } from '../errors/index.js';

/**
 * Documento de departamento criado a partir de um nó de template.
 * Todos os campos injetados manualmente — sem TenantRepository — pois a
 * inserção acontece dentro de uma transação MongoDB já em andamento
 * (a própria transação de criação do tenant).
 */
interface DepartmentInsertDoc {
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
 * os nós do template como departamentos reais na coleção `departments`.
 *
 * Deve ser chamada com uma `session` MongoDB ativa (dentro de withTransaction)
 * para garantir atomicidade em relação à criação do tenant.
 *
 * Invariantes:
 * - `templateId` deve existir em `department_templates`; se não, lança
 *   `NotFoundError` (a transação faz rollback automático).
 * - Cada nó recebe um `id` uuid novo — os `refId`/`parentRefId` do template
 *   são internos e nunca aparecem nos documentos finais.
 * - A ordem do array `nodes` garante que o pai já foi mapeado antes do filho
 *   (conforme spec §5.3 e validação no schema `TemplateNodeSchema`).
 * - `level` é calculado recursivamente pelo mapa: raiz = 0, filho = pai + 1.
 *
 * @param db          Instância `Db` do driver MongoDB.
 * @param tenantId    UUID do tenant para o qual os departamentos serão criados.
 * @param templateId  UUID do template a aplicar.
 * @param session     `ClientSession` MongoDB ativa (para transação atômica).
 * @param logger      Logger Fastify com contexto já pré-formatado (tenantId, etc.).
 */
export async function applyTemplateToTenant(
  db: Db,
  tenantId: string,
  templateId: string,
  session: import('mongodb').ClientSession,
  logger: FastifyBaseLogger,
): Promise<void> {
  // 1. Buscar o template (sem filtro de tenant — templates são globais).
  const templateDoc = await db
    .collection('department_templates')
    .findOne({ id: templateId }, { session });

  if (!templateDoc) {
    throw new NotFoundError('Template de departamentos não encontrado');
  }

  const nodes = templateDoc['nodes'] as TemplateNode[];

  if (nodes.length === 0) {
    logger.info({ tenantId, templateId, deptCount: 0 }, 'template sem nós; nenhum departamento criado');
    return;
  }

  // 2. Sort topológico: garante que pais aparecem antes dos filhos.
  //    O array do template já deve estar ordenado (spec §5.3), mas fazemos o
  //    sort aqui por segurança — evita falhas se a ordem for alterada no PATCH.
  const sorted = topologicalSort(nodes);

  // 3. Mapear refId → novoId e calcular level de cada nó.
  //    refIdToNewId: resolve parentRefId → parentId real.
  //    refIdToLevel: deriva level filho = level pai + 1.
  const refIdToNewId = new Map<string, string>();
  const refIdToLevel = new Map<string, number>();

  const now = new Date();
  const docs: DepartmentInsertDoc[] = [];

  for (const node of sorted) {
    const newDeptId = newId();
    refIdToNewId.set(node.refId, newDeptId);

    let level = 0;
    let parentId: string | null = null;

    if (node.parentRefId !== null) {
      const resolvedParentId = refIdToNewId.get(node.parentRefId);
      const parentLevel = refIdToLevel.get(node.parentRefId);

      // A validação do schema TemplateNodeSchema garante que parentRefId aponta
      // para um refId existente. O sort topológico garante que o pai já foi
      // processado. Esta checagem é uma salvaguarda de runtime.
      if (resolvedParentId === undefined || parentLevel === undefined) {
        throw new Error(
          `Template inválido: parentRefId "${node.parentRefId}" do nó "${node.refId}" não foi encontrado após sort topológico`,
        );
      }

      parentId = resolvedParentId;
      level = parentLevel + 1;
    }

    refIdToLevel.set(node.refId, level);

    docs.push({
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

  // 4. Bulk insert na coleção departments — dentro da session/transação ativa.
  await db.collection('departments').insertMany(docs, { session });

  logger.info(
    { tenantId, templateId, deptCount: docs.length },
    'tenant criado com template; departamentos inseridos',
  );
}

/**
 * Ordena os nós do template topologicamente: raízes primeiro, filhos depois.
 *
 * Algoritmo BFS (Kahn): percorre nós sem parent pendente na fila, depois
 * processa os filhos cujos pais já foram emitidos. Detecta ciclos (embora o
 * schema Zod já impeça parentRefId circular por construção).
 *
 * Complexidade: O(n) em tempo e espaço.
 */
function topologicalSort(nodes: TemplateNode[]): TemplateNode[] {
  // Mapas auxiliares
  const nodeByRefId = new Map<string, TemplateNode>();
  const childrenOf = new Map<string, string[]>(); // parentRefId → [refId filhos]
  const inDegree = new Map<string, number>();       // refId → número de pais pendentes

  for (const node of nodes) {
    nodeByRefId.set(node.refId, node);
    inDegree.set(node.refId, node.parentRefId === null ? 0 : 1);

    if (node.parentRefId !== null) {
      const siblings = childrenOf.get(node.parentRefId) ?? [];
      siblings.push(node.refId);
      childrenOf.set(node.parentRefId, siblings);
    }
  }

  // Fila inicial: nós sem pai (raízes)
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
