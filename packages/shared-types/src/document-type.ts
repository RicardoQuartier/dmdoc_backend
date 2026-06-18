import { z } from 'zod';

/** Tipos de campo de índice. Spec §5.2. */
export const FieldTypeSchema = z.enum(['TEXT', 'DATE', 'NUMBER']);

export type FieldType = z.infer<typeof FieldTypeSchema>;

/**
 * Campo de índice embutido em um tipo de documento. Sempre lido junto com o tipo.
 * Spec §5.3 (`document_types.indexFields[]`).
 */
export const IndexFieldSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  fieldType: FieldTypeSchema,
  required: z.boolean(),
  aiExtractionHint: z.string().nullable(),
  order: z.number().int().nonnegative(),
  showOnSearch: z.boolean(),
  deleted: z.boolean(),
});

export type IndexField = z.infer<typeof IndexFieldSchema>;

/**
 * Tipo de documento. Define os campos de índice de um documento.
 *
 * Escopo:
 * - Tipo global: `isGlobal: true` e `tenantId: null` — visível a todas as empresas.
 * - Tipo da empresa: `isGlobal: false` e `tenantId` preenchido — visível só na empresa.
 *
 * Unicidade `(tenantId, name)` por índice. Segue exclusão lógica (`deleted`).
 * Ver wiki "Tipos de documento globais e por empresa". Spec §5.3.
 *
 * Campo `departmentIds`: aplicável apenas a tipos de empresa (`isGlobal: false`).
 * Tipos globais nunca têm `departmentIds`. A validação condicional (obrigatório
 * quando `isGlobal: false`) é feita nos schemas de input da API, não aqui.
 */
export const DocumentTypeSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid().nullable(),
  name: z.string().min(1).max(200),
  description: z.string().nullable(),
  isGlobal: z.boolean(),
  deleted: z.boolean(),
  createdAt: z.date(),
  indexFields: z.array(IndexFieldSchema),
  departmentIds: z.array(z.string().uuid()).optional(),
});

export type DocumentType = z.infer<typeof DocumentTypeSchema>;
