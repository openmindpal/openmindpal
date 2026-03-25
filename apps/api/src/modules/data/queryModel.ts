import { z } from "zod";

export const queryOpSchema = z.enum(["eq", "in", "contains", "gt", "gte", "lt", "lte"]);
export const queryDirectionSchema = z.enum(["asc", "desc"]);

export const filterCondSchema = z.object({
  field: z.string().min(1),
  op: queryOpSchema,
  value: z.any(),
});

export const filterExprSchema: z.ZodType<any> = z.lazy(() =>
  z.union([
    z.object({ and: z.array(filterExprSchema).min(1) }),
    z.object({ or: z.array(filterExprSchema).min(1) }),
    filterCondSchema,
  ]),
);

export const entityQueryRequestSchema = z.object({
  schemaName: z.string().min(1).optional(),
  filters: filterExprSchema.optional(),
  orderBy: z.array(z.object({ field: z.string().min(1), direction: queryDirectionSchema })).max(2).optional(),
  select: z.array(z.string().min(1)).max(200).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  cursor: z
    .object({
      updatedAt: z.string().min(1),
      id: z.string().min(1),
    })
    .optional(),
});

export type EntityQueryRequest = z.infer<typeof entityQueryRequestSchema>;

