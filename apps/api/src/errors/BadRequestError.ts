import { AppError } from './AppError.js';

/**
 * Requisição malformada para o contrato da rota — ex.: número de parte fora do
 * intervalo no upload em partes (ADR 0004). Mapeia para HTTP 400.
 */
export class BadRequestError extends AppError {
  public readonly statusCode = 400;
  public readonly code = 'BAD_REQUEST';

  constructor(message: string) {
    super(message);
  }
}
