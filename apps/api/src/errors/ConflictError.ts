import { AppError } from './AppError.js';

/**
 * Conflito de negócio — ex.: cota atingida, email duplicado, restrição de
 * unicidade violada. Mapeia para HTTP 409.
 */
export class ConflictError extends AppError {
  public readonly statusCode = 409;
  public readonly code = 'CONFLICT';

  constructor(message: string) {
    super(message);
  }
}
