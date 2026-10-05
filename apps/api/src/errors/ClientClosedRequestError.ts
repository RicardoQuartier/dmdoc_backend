import { AppError } from './AppError.js';

/**
 * O cliente fechou a conexão antes de terminar de enviar o corpo (ex.: o
 * usuário cancelou o upload). Não é falha do servidor: o error handler central
 * registra em nível info, como qualquer `AppError`. A resposta não chega a
 * ninguém — o status 499 (convenção do nginx) só aparece no log.
 */
export class ClientClosedRequestError extends AppError {
  public readonly statusCode = 499;
  public readonly code = 'CLIENT_CLOSED_REQUEST';

  constructor(message = 'Cliente encerrou a requisição antes do fim do corpo') {
    super(message);
  }
}
