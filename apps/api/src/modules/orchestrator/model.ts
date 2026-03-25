import { z } from "zod";
import { i18nTextSchema } from "../metadata/schemaModel";

export const uiDirectiveSchema = z.object({
  openView: z.string().min(1),
  viewParams: z.record(z.string(), z.any()).optional(),
  openMode: z.enum(["page", "panel", "modal"]).optional(),
});

export const orchestratorTurnRequestSchema = z.object({
  message: z.string().min(1),
  conversationId: z.string().min(1).max(200).optional(),
  locale: z.string().optional(),
});

export const toolSuggestionSchema = z.object({
  suggestionId: z.string().min(10).optional(),
  toolRef: z.string().min(3),
  inputDraft: z.record(z.string(), z.any()).optional(),
  riskLevel: z.enum(["low", "medium", "high"]).optional(),
  approvalRequired: z.boolean().optional(),
  idempotencyKey: z.string().optional(),
});

export const orchestratorTurnResponseSchema = z.object({
  turnId: z.string().min(10).optional(),
  conversationId: z.string().min(1).max(200).optional(),
  replyText: i18nTextSchema.or(z.string()).optional(),
  toolSuggestions: z.array(toolSuggestionSchema).optional(),
  uiDirective: uiDirectiveSchema.optional(),
});

export type OrchestratorTurnRequest = z.infer<typeof orchestratorTurnRequestSchema>;
export type OrchestratorTurnResponse = z.infer<typeof orchestratorTurnResponseSchema>;
