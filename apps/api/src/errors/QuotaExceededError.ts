import { AppError } from './AppError.js';

/**
 * Lançado quando o tenant tenta ultrapassar a cota contratada de disco ou de
 * usuários (spec §10, invariante 6 — validação antes de aceitar upload ou
 * novo usuário).
 *
 * HTTP 422: a requisição é semanticamente inválida no contexto do tenant — não
 * é um erro de autenticação/autorização nem um recurso não encontrado.
 */
export class QuotaExceededError extends AppError {
  public readonly statusCode = 422;
  public readonly code = 'QUOTA_EXCEEDED';

  constructor(message = 'Cota de disco esgotada') {
    super(message);
  }
}
