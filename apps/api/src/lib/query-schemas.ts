import { z } from 'zod';

/**
 * Lista de UUIDs em CSV na query string (`?userIds=a,b`). Ausente ou vazia →
 * `[]`; qualquer item que não seja UUID → erro de validação (422).
 *
 * Compartilhado pelas rotas de relatório (`routes/reports.ts` e
 * `routes/reports-evaluated-documents.ts`).
 */
export const csvUuids = z
  .string()
  .optional()
  .transform((raw) =>
    (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
  .pipe(z.array(z.string().uuid('cada id deve ser um UUID válido')));
