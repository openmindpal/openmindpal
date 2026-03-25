import type { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";
import { digestParams, sha256Hex } from "../../lib/digest";
import { orchestratorTurnRequestSchema } from "./modules/model";
import { orchestrateChatTurn } from "./modules/orchestrator";
import { createOrchestratorTurn } from "./modules/turnRepo";
import { clearSessionContext } from "../memory-manager/modules/sessionContextRepo";
import { getPromptInjectionModeFromEnv, scanPromptInjection, summarizePromptInjection } from "../safety-policy/modules/promptInjectionGuard";

export const orchestratorTurnRoutes: FastifyPluginAsync = async (app) => {
  app.post("/orchestrator/turn", async (req) => {
    setAuditContext(req, { resourceType: "orchestrator", action: "turn" });
    const decision = await requirePermission({ req, resourceType: "orchestrator", action: "turn" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    const body = orchestratorTurnRequestSchema.parse(req.body);
    const piMode = getPromptInjectionModeFromEnv();
    const piTarget = "orchestrator:turn";
    const piScan = scanPromptInjection(body.message);
    const piSummary = summarizePromptInjection(piScan, piMode, piTarget, false);
    const out = await orchestrateChatTurn({
      app,
      pool: app.db,
      subject,
      message: body.message,
      locale: body.locale ?? req.ctx.locale,
      conversationId: body.conversationId ?? null,
      authorization: (req.headers.authorization as string | undefined) ?? null,
      traceId: req.ctx.traceId,
    });
    const toolSuggestions = (out.toolSuggestions ?? []).map((s: any) => ({ ...s, suggestionId: crypto.randomUUID() }));
    const messageDigest = { len: body.message.length, sha256_8: sha256Hex(body.message).slice(0, 8) };
    const toolSuggestionsDigest = toolSuggestions.map((s: any) => ({
      suggestionId: s.suggestionId,
      toolRef: s.toolRef,
      riskLevel: s.riskLevel,
      approvalRequired: s.approvalRequired,
      idempotencyKey: s.idempotencyKey,
      inputDigest: digestParams(s.inputDraft),
    }));

    const turn = await createOrchestratorTurn({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId ?? null,
      subjectId: subject.subjectId,
      message: "",
      toolSuggestions: null,
      messageDigest,
      toolSuggestionsDigest: toolSuggestionsDigest.length ? toolSuggestionsDigest : null,
    });

    req.ctx.audit!.outputDigest = {
      turnId: turn.turnId,
      suggestionCount: toolSuggestions.length,
      suggestions: toolSuggestions.map((s: any) => ({ suggestionId: s.suggestionId, toolRef: s.toolRef, riskLevel: s.riskLevel, approvalRequired: s.approvalRequired })),
      ui: out.uiDirective ? { openView: (out.uiDirective as any).openView } : undefined,
      safetySummary: { promptInjection: piSummary },
    };

    return { ...out, generatePageRequest: undefined, turnId: turn.turnId, toolSuggestions };
  });

  app.post("/orchestrator/conversations/clear", async (req) => {
    setAuditContext(req, { resourceType: "orchestrator", action: "conversation.clear" });
    const decision = await requirePermission({ req, resourceType: "orchestrator", action: "turn" });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const body = z.object({ conversationId: z.string().min(1).max(200) }).parse(req.body);
    const deleted = await clearSessionContext({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId, sessionId: body.conversationId });
    req.ctx.audit!.outputDigest = { conversationId: body.conversationId, deleted };
    return { deleted };
  });
};
