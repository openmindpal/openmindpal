import { z } from "zod";

export const i18nTextSchema = z.record(z.string(), z.string());

export const fieldDefSchema = z.object({
  type: z.enum(["string", "number", "boolean", "json", "datetime", "reference"]),
  required: z.boolean().optional(),
  displayName: i18nTextSchema.optional(),
  description: i18nTextSchema.optional(),
  /** For type=="reference": the target entity name (e.g. "customer") */
  referenceEntity: z.string().min(1).optional(),
  /** For type=="reference": which field of the target entity to display in the picker (e.g. "name") */
  displayField: z.string().min(1).optional(),
  /** For type=="reference": which fields to search against when filtering (defaults to [displayField]) */
  searchFields: z.array(z.string().min(1)).optional(),
  /**
   * Cascading dependency: when another field in the same entity changes,
   * this picker should re-filter its options.
   * - field: the sibling field name whose value this depends on (e.g. "customerId")
   * - filterField: the field on the referenced entity to match against (e.g. "customer_id")
   */
  dependsOn: z.object({
    field: z.string().min(1),
    filterField: z.string().min(1),
  }).optional(),
});

export const entityDefSchema = z.object({
  displayName: i18nTextSchema.optional(),
  description: i18nTextSchema.optional(),
  fields: z.record(z.string(), fieldDefSchema),
});

export const schemaDefSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().positive().optional(),
  displayName: i18nTextSchema.optional(),
  description: i18nTextSchema.optional(),
  entities: z.record(z.string(), entityDefSchema),
});

export type SchemaDef = z.infer<typeof schemaDefSchema>;

