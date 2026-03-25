import { z } from "zod";
import { i18nTextSchema } from "../../../modules/metadata/schemaModel";
import { entityQueryRequestSchema } from "../../../modules/data/queryModel";

export const pageTypeSchema = z.enum(["entity.list", "entity.detail", "entity.new", "entity.edit"]);

export const dataBindingSchema = z.discriminatedUnion("target", [
  z.object({
    target: z.literal("entities.list"),
    entityName: z.string().min(1),
  }),
  z.object({
    target: z.literal("entities.query"),
    entityName: z.string().min(1),
    schemaName: z.string().min(1).optional(),
    query: entityQueryRequestSchema.omit({ schemaName: true }).optional(),
  }),
  z.object({
    target: z.literal("entities.get"),
    entityName: z.string().min(1),
    idParam: z.string().min(1).optional(),
  }),
  z.object({
    target: z.literal("schema.effective"),
    entityName: z.string().min(1),
    schemaName: z.string().min(1).optional(),
  }),
]);

export const actionBindingSchema = z.object({
  action: z.enum(["create", "update"]).optional(),
  toolRef: z.string().min(3),
  idempotencyKeyStrategy: z.enum(["required", "optional", "none"]).optional(),
  approval: z.enum(["required", "optional", "none"]).optional(),
  confirmMessage: i18nTextSchema.optional(),
});

export const pageUiSchema = z
  .object({
    layout: z
      .object({
        variant: z.string().min(1).max(80).optional(),
        density: z.enum(["comfortable", "compact"]).optional(),
      })
      .optional(),
    blocks: z
      .array(
        z.object({
          slot: z.string().min(1).max(80),
          componentId: z.string().min(1).max(120),
          props: z.record(z.string(), z.any()).optional(),
        }),
      )
      .max(50)
      .optional(),
    list: z
      .object({
        columns: z.array(z.string().min(1)).max(50).optional(),
        filters: z.array(z.string().min(1)).max(50).optional(),
        sortOptions: z.array(z.object({ field: z.string().min(1), direction: z.enum(["asc", "desc"]) })).max(20).optional(),
        pageSize: z.coerce.number().int().positive().max(200).optional(),
      })
      .optional(),
    detail: z
      .object({
        fieldOrder: z.array(z.string().min(1)).max(200).optional(),
        groups: z
          .array(
            z.object({
              title: i18nTextSchema.optional(),
              fields: z.array(z.string().min(1)).min(1).max(200),
            }),
          )
          .max(50)
          .optional(),
      })
      .optional(),
    form: z
      .object({
        fieldOrder: z.array(z.string().min(1)).max(200).optional(),
        groups: z
          .array(
            z.object({
              title: i18nTextSchema.optional(),
              fields: z.array(z.string().min(1)).min(1).max(200),
            }),
          )
          .max(50)
          .optional(),
      })
      .optional(),
  })
  .strict();

export const pageDraftSchema = z.object({
  title: i18nTextSchema.optional(),
  pageType: pageTypeSchema,
  params: z.record(z.string(), z.any()).optional(),
  dataBindings: z.array(dataBindingSchema).optional(),
  actionBindings: z.array(actionBindingSchema).optional(),
  ui: pageUiSchema.optional(),
});

export type PageDraft = z.infer<typeof pageDraftSchema>;

export const pageViewPrefsSchema = z
  .object({
    layout: z
      .object({
        variant: z.string().min(1).max(80).optional(),
        density: z.enum(["comfortable", "compact"]).optional(),
      })
      .optional(),
    list: z
      .object({
        columns: z.array(z.string().min(1)).max(50).optional(),
        sort: z.string().min(1).max(100).optional(),
      })
      .optional(),
  })
  .strict();
