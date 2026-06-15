import { AppError } from './AppError.js';

/**
 * Erro de validação de entrada de negócio — ex.: um departmentId informado não
 * é uma raiz (nível 0). Mapeia para HTTP 422 com `code: VALIDATION_ERROR`,
 * mesmo contrato dos erros de validação de schema (Zod).
 */
export class ValidationError extends AppError {
  public readonly statusCode = 422;
  public readonly code = 'VALIDATION_ERROR';

  constructor(message: string) {
    super(message);
  }
}
