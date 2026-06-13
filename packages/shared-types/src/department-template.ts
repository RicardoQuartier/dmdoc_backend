import { z } from 'zod';

/**
 * Nó de um template de departamentos. Representa um departamento dentro da
 * estrutura pré-definida. `refId` e `parentRefId` são identidades INTERNAS
 * ao template (não ids reais de departamentos) — usados para construir a
 * árvore antes da criação efetiva ao aplicar o template num tenant.
 *
 * Spec §5.3 (coleção `department_templates`).
 */
export const TemplateNodeSchema = z.object({
  refId: z.string().uuid(),
  parentRefId: z.string().uuid().nullable(),
  name: z.string().min(1).max(200),
  tags: z.array(z.string()).default([]),
});

export type TemplateNode = z.infer<typeof TemplateNodeSchema>;

/**
 * Template de departamentos completo (documento do banco).
 */
export const DepartmentTemplateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  nodes: z.array(TemplateNodeSchema).max(200),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type DepartmentTemplate = z.infer<typeof DepartmentTemplateSchema>;

/**
 * Valida que todo `parentRefId` não-null aponta para um `refId` existente
 * no mesmo array de nodes. Garante integridade da árvore antes de persistir.
 */
function validateParentRefs(nodes: TemplateNode[]): boolean {
  const refIds = new Set(nodes.map((n) => n.refId));
  return nodes.every((n) => n.parentRefId === null || refIds.has(n.parentRefId));
}

const nodesArraySchema = z
  .array(TemplateNodeSchema)
  .max(200)
  .refine(validateParentRefs, {
    message:
      'parentRefId inválido: todo nó com parentRefId não-null deve referenciar um refId existente no mesmo array',
  });

/**
 * Body para criação de template. Exportado para uso nas rotas e no frontend.
 */
export const CreateDepartmentTemplateBodySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  nodes: nodesArraySchema,
});

export type CreateDepartmentTemplateBody = z.infer<typeof CreateDepartmentTemplateBodySchema>;

/**
 * Body para atualização parcial de template. Todos os campos são opcionais;
 * quando `nodes` é enviado, a validação de referências internas é aplicada
 * ao novo array completo.
 */
export const UpdateDepartmentTemplateBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(500).optional(),
    nodes: nodesArraySchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Pelo menos um campo deve ser fornecido para atualização',
  });

export type UpdateDepartmentTemplateBody = z.infer<typeof UpdateDepartmentTemplateBodySchema>;

/**
 * Query params para listagem de templates (paginação por cursor).
 */
export const ListDepartmentTemplatesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

export type ListDepartmentTemplatesQuery = z.infer<typeof ListDepartmentTemplatesQuerySchema>;
