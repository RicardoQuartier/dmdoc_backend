import { AppError } from './AppError.js';

/**
 * Recurso inexistente — ou pertencente a outro tenant (isolamento multi-tenant
 * sempre responde 404, nunca 403, para não vazar a existência do recurso).
 */
export class NotFoundError extends AppError {
  public readonly statusCode = 404;
  public readonly code = 'NOT_FOUND';

  constructor(message = 'Recurso não encontrado') {
    super(message);
  }
}
