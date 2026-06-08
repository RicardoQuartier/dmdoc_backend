/**
 * Erro base da aplicação. Todo erro de domínio tipado herda desta classe,
 * carregando o status HTTP e um `code` estável para o cliente.
 *
 * O error handler central (ver `src/app.ts`) reconhece instâncias de
 * `AppError` e as mapeia diretamente para a resposta HTTP. Qualquer outro
 * erro é tratado como 500 (Internal Server Error) e tem a mensagem ocultada.
 */
export abstract class AppError extends Error {
  /** Status HTTP a ser retornado ao cliente. */
  public abstract readonly statusCode: number;

  /** Código estável e legível por máquina (ex.: `NOT_FOUND`). */
  public abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}
