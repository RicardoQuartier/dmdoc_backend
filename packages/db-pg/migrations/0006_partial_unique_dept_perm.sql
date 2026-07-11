-- Torna o índice único de `department_permissions` PARCIAL (apenas
-- `deleted = false`), espelhando o padrão já aplicado em 0002 para `documents`.
--
-- O índice total sobre (user_id, department_id) ignorava a coluna `deleted`:
-- uma linha soft-deletada (fisicamente presente na tabela) colidia (23505) com
-- a reinserção do mesmo par no padrão soft-delete + reinserção usado por
-- `PUT /users/:id/permissions`. Isso obrigava um workaround de upsert por rota.
--
-- Com o índice parcial, apenas concessões ATIVAS competem pela unicidade;
-- linhas soft-deletadas (`deleted = true`) ficam fora do índice e não bloqueiam
-- a reinserção — blindando o padrão de forma genérica para qualquer consumidor.
--
-- Compatibilidade: nenhuma colisão é possível ao recriar. O índice total
-- anterior já garantia no máximo UMA linha por (user_id, department_id), logo o
-- subconjunto `deleted = false` tem, no máximo, uma linha por par.

DROP INDEX IF EXISTS uniq_dept_perm_user_dept;

CREATE UNIQUE INDEX uniq_dept_perm_user_dept
  ON department_permissions (user_id, department_id)
  WHERE deleted = false;
