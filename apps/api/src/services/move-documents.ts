import type { Sql } from '@dmdoc/db-pg';
import { RoleSchema, ROLE_LEVEL } from '@dmdoc/shared-types';
import { NotFoundError, ValidationError } from '../errors/index.js';
import { resolveAccessibleDepartmentIds } from '../auth/department-access.js';

/**
 * Serviço de MOVE de documentos entre departamentos.
 *
 * ---------------------------------------------------------------------------
 * POR QUE EXISTE UM CAMINHO DEDICADO (e não um campo no `PATCH /documents/:id`)
 * ---------------------------------------------------------------------------
 * `chunks.department_id` é uma coluna DENORMALIZADA e é ELA — não
 * `documents.department_id` — que a busca usa para filtrar acesso por
 * departamento (ver `lexicalSearch`, `vectorSearch`, `hybridSearch` e
 * `searchDocumentsPaged` em `packages/db-pg/src/search.ts`, além do
 * enriquecimento em `apps/api/src/routes/search.ts`).
 *
 * Mover o documento sem sincronizar os chunks produz dois defeitos de ACL:
 *   - VAZAMENTO: quem perdeu o acesso continua recebendo o TEXTO do chunk na
 *     busca por conteúdo e dentro do prompt do RAG;
 *   - SUMIÇO: quem ganhou o acesso não encontra o documento por conteúdo (só
 *     por metadado, que lê `documents`).
 *
 * Daí a invariante deste módulo: `UPDATE documents` e `UPDATE chunks` acontecem
 * SEMPRE na mesma transação. O `PATCH /documents/:id` não serviria: ele roda
 * fora de transação e ainda dispara uma chamada de LLM no meio (Gatilho 2 de
 * sugestão de índices), o que deixaria as duas tabelas dessincronizadas por
 * segundos — exatamente a janela de vazamento.
 *
 * ---------------------------------------------------------------------------
 * QUEM PODE MOVER — divergência deliberada do `bulk-delete`
 * ---------------------------------------------------------------------------
 * O `bulk-delete` exige `ADMIN_ROLES` porque é destrutivo e irreversível. Mover
 * NÃO exige: basta ter escrita na ORIGEM e no DESTINO. Um `UPLOADER` já pode
 * enviar documento em qualquer departamento onde tem ACL — mover é a mesma
 * capacidade, e é reversível (basta mover de volta). O papel `USER` continua
 * barrado, pelo gate de papel dentro de `assertCanWriteDepartment`.
 */

/** Documento resolvido dentro do escopo do ator, antes de qualquer escrita. */
export interface ScopedDocumentForMove {
  id: string;
  tenant_id: string;
  department_id: string;
  status: string;
}

export interface MoveDocumentsParams {
  sql: Sql;
  userId: string;
  role: string;
  /** Tenant do JWT; `null` para SUPER_ADMIN (que não tem tenant fixo). */
  requestTenantId: string | null;
  /** Tenants permitidos ao MULTI_TENANT_ADMIN. */
  allowedTenantIds: string[];
  documentIds: string[];
  toDepartmentId: string;
}

export interface MoveDocumentsOutcome {
  /** Tenant único de todos os documentos da operação. */
  tenantId: string;
  /** Ids efetivamente movidos (do `RETURNING`) — exclui os que já estavam no destino. */
  movedIds: string[];
  /** Departamentos de origem distintos, para o audit log. */
  fromDepartmentIds: string[];
  /** Quantas linhas de `chunks` tiveram o departamento sincronizado. */
  chunksUpdated: number;
  /** Documentos resolvidos (todos, movidos ou não) — usados pela rota individual. */
  documents: ScopedDocumentForMove[];
}

/**
 * Valida se o usuário pode ESCREVER em um departamento.
 *
 * Duplicata deliberada de `assertCanWriteDepartment` de `routes/documents.ts`:
 * aquela é local ao módulo de rotas. As duas camadas e as mensagens são as
 * mesmas — gate por papel (fail-closed, `USER` sempre negado) e depois a ACL —
 * e o erro é sempre `NotFoundError`, nunca 403 (spec §10, invariante 4).
 */
async function assertCanWriteDepartment(
  sql: Sql,
  userId: string,
  tenantId: string,
  departmentId: string,
  role: string
): Promise<void> {
  const parsedRole = RoleSchema.safeParse(role);
  const roleLevel = parsedRole.success ? ROLE_LEVEL[parsedRole.data] : 0;
  if (roleLevel < ROLE_LEVEL.UPLOADER) {
    throw new NotFoundError('Departamento não encontrado ou sem permissão de escrita');
  }

  const accessible = await resolveAccessibleDepartmentIds(sql, userId, tenantId, role);
  if (accessible === null) {
    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM departments WHERE id = ${departmentId} AND tenant_id = ${tenantId} LIMIT 1
    `;
    if (rows.length === 0) {
      throw new NotFoundError('Departamento não encontrado');
    }
    return;
  }
  if (!accessible.includes(departmentId)) {
    throw new NotFoundError('Departamento não encontrado ou sem permissão de escrita');
  }
}

/**
 * Move um ou mais documentos para outro departamento.
 *
 * Ordem das validações — NENHUMA escrita acontece antes de todas passarem
 * (all-or-nothing, mesmo espírito do `bulk-delete`):
 *   1. resolve os documentos dentro do escopo do ator → 404 se faltar algum;
 *   2. exige tenant único → 422 em seleção cross-tenant;
 *   3. ACL de ESCRITA em cada departamento de ORIGEM distinto;
 *   4. ACL de ESCRITA no departamento de DESTINO;
 *   5. destino precisa existir, ser do mesmo tenant e estar ATIVO.
 *
 * Documento em `PENDING`/`PROCESSING` é aceito de propósito: a corrida com o
 * worker foi fechada no `persist` do pipeline (que relê o departamento sob
 * `FOR SHARE`), e reorganizar logo após o upload é o caso de uso mais natural.
 */
export async function moveDocumentsToDepartment(
  params: MoveDocumentsParams
): Promise<MoveDocumentsOutcome> {
  const { sql, userId, role, requestTenantId, allowedTenantIds, toDepartmentId } = params;

  // Ids repetidos inflariam a contagem de `requested` e a lista do audit.
  const dedupedIds = [...new Set(params.documentIds)];

  // Guarda de contrato, não de input externo: as duas rotas já validam
  // `min(1)` no Zod. Sem ela, uma lista vazia passaria pelo `length !== length`
  // do passo 1 e chegaria ao passo 2 sem nenhum tenant para resolver.
  if (dedupedIds.length === 0) {
    throw new ValidationError('Informe ao menos um documento para mover');
  }

  // ------------------------------------------------------------------
  // 1. Resolve os documentos DENTRO do escopo do ator (multi-tenant).
  //    Documento fora do escopo → 404 genérico (nunca revela qual id).
  // ------------------------------------------------------------------
  let foundDocs: ScopedDocumentForMove[];

  if (role === 'SUPER_ADMIN') {
    foundDocs = await sql<ScopedDocumentForMove[]>`
      SELECT id, tenant_id, department_id, status
      FROM documents
      WHERE id = ANY(${dedupedIds}::uuid[])
        AND deleted = false
    `;
  } else if (role === 'MULTI_TENANT_ADMIN') {
    foundDocs =
      allowedTenantIds.length === 0
        ? []
        : await sql<ScopedDocumentForMove[]>`
            SELECT id, tenant_id, department_id, status
            FROM documents
            WHERE id = ANY(${dedupedIds}::uuid[])
              AND tenant_id = ANY(${allowedTenantIds}::uuid[])
              AND deleted = false
          `;
  } else {
    // Fail-closed sem cast: papel não-admin SEM tenant no JWT não tem escopo
    // algum. Deixar o `null` chegar ao SQL geraria `tenant_id = NULL` (nunca
    // casa) — o resultado seria o mesmo 404, mas por acidente, não por decisão.
    if (requestTenantId === null) {
      throw new NotFoundError('Documento não encontrado');
    }
    const scopedTenantId = requestTenantId;
    foundDocs = await sql<ScopedDocumentForMove[]>`
      SELECT id, tenant_id, department_id, status
      FROM documents
      WHERE id = ANY(${dedupedIds}::uuid[])
        AND tenant_id = ${scopedTenantId}
        AND deleted = false
    `;
  }

  if (foundDocs.length !== dedupedIds.length) {
    // Uma seleção inválida não move NADA — nem os ids válidos que vieram junto.
    throw new NotFoundError('Documento não encontrado');
  }

  // ------------------------------------------------------------------
  // 2. Tenant único. Para SUPER_ADMIN/MTA, seleção cross-tenant é uso inválido
  //    da API (não vazamento) → 422.
  // ------------------------------------------------------------------
  const distinctTenantIds = [...new Set(foundDocs.map((d) => d.tenant_id))];
  if (distinctTenantIds.length > 1) {
    throw new ValidationError('Todos os documentos devem pertencer à mesma empresa');
  }
  const tenantId = distinctTenantIds[0]!;

  // ------------------------------------------------------------------
  // 3. ACL de ORIGEM — uma checagem por DEPARTAMENTO DISTINTO, não por
  //    documento. Cada chamada resolve a subárvore concedida (2 queries); no
  //    lote isso seria 2N queries para documentos que quase sempre
  //    compartilham poucos departamentos.
  // ------------------------------------------------------------------
  const fromDepartmentIds = [...new Set(foundDocs.map((d) => d.department_id))];
  for (const departmentId of fromDepartmentIds) {
    await assertCanWriteDepartment(sql, userId, tenantId, departmentId, role);
  }

  // ------------------------------------------------------------------
  // 4. ACL de DESTINO — mover exige escrita nos DOIS lados.
  // ------------------------------------------------------------------
  await assertCanWriteDepartment(sql, userId, tenantId, toDepartmentId, role);

  // ------------------------------------------------------------------
  // 5. Destino precisa estar ATIVO. Checagem obrigatória e INDEPENDENTE do
  //    passo 4: `resolveAccessibleDepartmentIds` deliberadamente não filtra
  //    `departments.deleted` (para preservar o acesso a documentos órfãos), e o
  //    ramo admin de `assertCanWriteDepartment` também não. Mesmo precedente do
  //    upload: arquivar conteúdo num ramo já removido da árvore é proibido.
  // ------------------------------------------------------------------
  const activeDest = await sql<Array<{ id: string }>>`
    SELECT id FROM departments
    WHERE id = ${toDepartmentId}
      AND tenant_id = ${tenantId}
      AND deleted = false
    LIMIT 1
  `;
  if (activeDest.length === 0) {
    throw new NotFoundError('Departamento não encontrado');
  }

  // ------------------------------------------------------------------
  // 6. Transação: `documents` e `chunks` juntos — a invariante do módulo.
  //
  //    `documents` PRIMEIRO: o row lock adquirido aqui serializa contra o
  //    `persist` do worker, que relê o departamento sob `FOR SHARE` antes de
  //    inserir os chunks. Nas duas ordens possíveis o resultado converge.
  //
  //    `AND department_id <> destino` dá idempotência: mover para o mesmo
  //    departamento não gera linha, nem WAL, nem audit.
  // ------------------------------------------------------------------
  const targetIds = foundDocs.map((doc) => doc.id);

  const outcome = await sql.begin(async (tx) => {
    const moved = await tx<Array<{ id: string }>>`
      UPDATE documents
      SET department_id = ${toDepartmentId}
      WHERE tenant_id = ${tenantId}
        AND id = ANY(${targetIds}::uuid[])
        AND deleted = false
        AND department_id <> ${toDepartmentId}
      RETURNING id
    `;

    // Roda sobre `targetIds` e NÃO sobre as linhas do RETURNING: um documento
    // que já estava no destino pode ainda ter chunks defasados (por exemplo, de
    // um move anterior que perdeu a corrida com o worker). Reconciliar aqui é
    // idempotente e fecha esse buraco de graça.
    const chunks = await tx`
      UPDATE chunks
      SET department_id = ${toDepartmentId}
      WHERE tenant_id = ${tenantId}
        AND document_id = ANY(${targetIds}::uuid[])
        AND department_id <> ${toDepartmentId}
    `;

    // Materializa em objetos simples: o resultado de postgres.js carrega
    // metadados que não sobrevivem ao unwrap do `begin`.
    return { movedIds: moved.map((r) => r.id), chunksUpdated: chunks.count };
  });

  return {
    tenantId,
    movedIds: outcome.movedIds,
    fromDepartmentIds,
    chunksUpdated: outcome.chunksUpdated,
    documents: foundDocs,
  };
}
