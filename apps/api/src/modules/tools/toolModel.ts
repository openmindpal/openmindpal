import { z } from "zod";
import { fieldDefSchema, i18nTextSchema } from "../metadata/schemaModel";

export const riskLevelSchema = z.enum(["low", "medium", "high"]);

export const toolScopeSchema = z.enum(["read", "write"]);

export const toolIoSchema = z.object({
  displayName: i18nTextSchema.optional(),
  description: i18nTextSchema.optional(),
  fields: z.record(z.string(), fieldDefSchema).optional(),
});

export const toolPublishSchema = z.object({
  displayName: i18nTextSchema.optional(),
  description: i18nTextSchema.optional(),
  scope: toolScopeSchema.optional(),
  resourceType: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  idempotencyRequired: z.boolean().optional(),
  riskLevel: riskLevelSchema.optional(),
  approvalRequired: z.boolean().optional(),
  inputSchema: toolIoSchema.optional(),
  outputSchema: toolIoSchema.optional(),
  artifactId: z.string().uuid().optional(),
  artifactRef: z.string().min(1).optional(),
  depsDigest: z.string().min(1).optional(),
  scanSummary: z.any().optional(),
  trustSummary: z.any().optional(),
  sbomSummary: z.any().optional(),
  sbomDigest: z.string().min(1).optional(),
});

export type ToolPublish = z.infer<typeof toolPublishSchema>;
