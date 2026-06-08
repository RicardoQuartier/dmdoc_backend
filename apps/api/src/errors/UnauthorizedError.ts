import { AppError } from './AppError.js';

/**
 * Falha de autenticação: credenciais inválidas, token ausente, inválido ou
 * expirado, ou usuário inativo.
 *
 * A mensagem é deliberadamente GENÉRICA ("Credenciais inválidas") no login —
 * nunca revela qual campo falhou (email inexistente vs. senha errada vs. conta
 * inativa). Revelar isso permitiria enumerar emails válidos.
 */
export class UnauthorizedError extends AppError {
  public readonly statusCode = 401;
  public readonly code = 'UNAUTHORIZED';

  constructor(message = 'Credenciais inválidas') {
    super(message);
  }
}
