import { ROLE_LEVEL, type Role } from '@dmdoc/shared-types';

/**
 * Papéis visíveis a um ator segundo a regra "inferior ou igual": todos os
 * papéis cujo nível (`ROLE_LEVEL`) seja MENOR OU IGUAL ao do ator.
 *
 * SUPER_ADMIN (100) devolve os 5 papéis; TENANT_ADMIN (60) exclui
 * MULTI_TENANT_ADMIN (80) e SUPER_ADMIN (100). Usado em toda LEITURA que expõe
 * identidade de usuário (listagens, seletores, rótulos de relatório) para não
 * revelar nome/e-mail de contas de nível ACIMA do solicitante. Ver wiki
 * "Hierarquia de papéis e gestão de usuários (quem cria quem)".
 */
export function rolesVisibleTo(actorRole: Role): Role[] {
  const actorLevel = ROLE_LEVEL[actorRole];
  return (Object.keys(ROLE_LEVEL) as Role[]).filter((r) => ROLE_LEVEL[r] <= actorLevel);
}
