import { AppError } from './AppError.js';

/**
 * Falha ao chamar um serviço externo do qual a operação depende (ex.: o
 * provedor de LLM). Diferente de um bug interno do DMDoc — retorna 502
 * (Bad Gateway) com uma mensagem que deixa claro que o problema é upstream
 * (chave de API ausente/inválida, provedor fora do ar, etc.), não um defeito
 * na aplicação.
 */
export class UpstreamServiceError extends AppError {
  public readonly statusCode = 502;
  public readonly code = 'UPSTREAM_SERVICE_ERROR';

  constructor(message = 'Falha ao chamar um serviço externo. Tente novamente em instantes.') {
    super(message);
  }
}
