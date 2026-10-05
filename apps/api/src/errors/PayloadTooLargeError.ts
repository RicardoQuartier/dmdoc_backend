import { AppError } from './AppError.js';

/**
 * Arquivo declarado acima de `MAX_UPLOAD_MB` na abertura do upload em partes
 * (ADR 0004). Mapeia para HTTP 413 com corpo JSON — diferente do 413 em HTML
 * da borda, que nem chega à API.
 */
export class PayloadTooLargeError extends AppError {
  public readonly statusCode = 413;
  public readonly code = 'FILE_TOO_LARGE';

  constructor(message: string) {
    super(message);
  }
}
