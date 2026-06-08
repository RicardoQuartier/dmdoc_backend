import { AppError } from './AppError.js';

/**
 * Acesso negado — o usuário autenticado não tem a role necessária para a
 * operação. Retorna 403 (diferente de 404 que é usado para isolamento
 * cross-tenant). Use este erro apenas para violações de role/permissão dentro
 * do tenant correto.
 */
export class ForbiddenError extends AppError {
  public readonly statusCode = 403;
  public readonly code = 'FORBIDDEN';

  constructor(message = 'Acesso negado') {
    super(message);
  }
}
