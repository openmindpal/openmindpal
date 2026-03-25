import type { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";
import { getEffectiveSafetyPolicyVersion } from "../../lib/safetyContract";
import { getOrchestratorTurn } from "./modules/turnRepo";
import { safetyPreCheck } from "./modules/safetyPreCheck";
import { resolvePromptInjectionPolicy } from "@openslin/shared";
import { extractTextForPromptInjectionScan, getPromptInjectionPolicyFromEnv, scanPromptInjection, shouldDenyPromptInjectionForTarget, summarizePromptInjection } from "../../lib/promptInjection";
import { resolveAndValidateTool, admitAndBuildStepEnvelope, buildStepInputPayload, submitNewToolRun, generateIdempotencyKey } from "../../kernel/executionKernel";
import { validateToolInput } from "../../modules/tools/validate";
import { networkPolicyDigest } from "../../modules/tools/executionAdmission";

export const orchestratorExecuteRoutes: FastifyPluginAsync = async (app) => {
  app.post("/orchestrator/execute", async (req, reply) => {
    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = z
      .union([
        z.object({
          toolRef: z.string().min(3),
          input: z.unknown(),
          idempotencyKey: z.string().min(3).optional(),
          limits: z.unknown().optional(),
          networkPolicy: z.unknown().optional(),
        }),
        z.object({
          turnId: z.string().min(10),
          suggestionId: z.string().min(10),
          input: z.unknown(),
          idempotencyKey: z.string().min(3).optional(),
          limits: z.unknown().optional(),
          networkPolicy: z.unknown().optional(),
        }),
      ])
      .parse(req.body);

    const bindTurnId = "turnId" in body ? body.turnId : null;
    const bindSuggestionId = "suggestionId" in body ? body.suggestionId : null;

    let rawToolRef: string;
    if ("toolRef" in body) {
      rawToolRef = body.toolRef;
    } else {
      const turn = await getOrchestratorTurn({ pool: app.db, tenantId: subject.tenantId, turnId: body.turnId });
      if (!turn || turn.spaceId !== subject.spaceId || turn.subjectId !== subject.subjectId) {
        req.ctx.audit!.errorCategory = "policy_violation";
        return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Turn 不存在", "en-US": "Turn not found" }, traceId: req.ctx.traceId });
      }
      const list = Array.isArray(turn.toolSuggestionsDigest) ? turn.toolSuggestionsDigest : [];
      const s = list.find((x: any) => x?.suggestionId === body.suggestionId);
      const toolRef0 = s?.toolRef;
      if (!s) {
        req.ctx.audit!.errorCategory = "policy_violation";
        return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Suggestion 不存在", "en-US": "Suggestion not found" }, traceId: req.ctx.traceId });
      }
      if (typeof toolRef0 !== "string" || !toolRef0.trim()) {
        req.ctx.audit!.errorCategory = "policy_violation";
        return reply.status(409).send({ errorCode: "ORCH_SUGGESTION_MISMATCH", message: { "zh-CN": "Suggestion 绑定不一致", "en-US": "Suggestion binding mismatch" }, traceId: req.ctx.traceId });
      }
      rawToolRef = toolRef0;
    }

    // ── Phase 1: Resolve & validate tool (via execution kernel) ──────
    const resolved = await resolveAndValidateTool({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      rawToolRef,
    });

    // Artifact-ref check for non-builtin tools
    if (!["entity.create", "entity.update", "memory.read", "memory.write", "knowledge.search"].includes(resolved.toolName)) {
      if (!resolved.version.artifactRef) {
        req.ctx.audit!.errorCategory = "policy_violation";
        throw Errors.forbidden();
      }
    }
    if (resolved.toolName === "memory.read") await requirePermission({ req, resourceType: "memory", action: "read" });
    if (resolved.toolName === "memory.write") await requirePermission({ req, resourceType: "memory", action: "write" });

    const idempotencyKeyHeader = (req.headers["idempotency-key"] as string | undefined) ?? (req.headers["x-idempotency-key"] as string | undefined) ?? undefined;

    setAuditContext(req, { resourceType: "orchestrator", action: "execute", toolRef: resolved.toolRef, idempotencyKey: body.idempotencyKey ?? idempotencyKeyHeader });
    const decision = await requirePermission({ req, resourceType: "orchestrator", action: "execute" });
    req.ctx.audit!.policyDecision = decision;

    // ── Prompt injection scan ────────────────────────────────────────
    const injEff = await getEffectiveSafetyPolicyVersion({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? null, policyType: "injection" });
    const piPolicy = injEff?.policyJson ? resolvePromptInjectionPolicy(injEff.policyJson as any) : getPromptInjectionPolicyFromEnv();
    const piMode = piPolicy.mode;
    const piTarget = "orchestrator:execute";
    const piText = extractTextForPromptInjectionScan({ toolRef: rawToolRef, input: body.input });
    const piScan = scanPromptInjection(piText);
    const piDenied = shouldDenyPromptInjectionForTarget({ scan: piScan, target: piTarget, policy: piPolicy });
    const piSummary = summarizePromptInjection(piScan, piMode, piTarget, piDenied);
    if (piDenied) {
      req.ctx.audit!.errorCategory = "policy_violation";
      req.ctx.audit!.outputDigest = { safetySummary: { decision: "denied", target: piTarget, ruleIds: piSummary.ruleIds, promptInjection: piSummary, ...(injEff?.policyDigest ? { policyRefsDigest: { injectionPolicyDigest: String(injEff.policyDigest) } } : {}) } };
      throw Errors.safetyPromptInjectionDenied();
    }

    validateToolInput(resolved.version.inputSchema, body.input);

    // ── Phase 2: Admit & build step envelope (via execution kernel) ──
    const opDecision = await requirePermission({ req, resourceType: resolved.resourceType, action: resolved.action });

    let idempotencyKey = body.idempotencyKey ?? idempotencyKeyHeader ?? null;
    if (resolved.scope === "write" && resolved.idempotencyRequired && !idempotencyKey) idempotencyKey = crypto.randomUUID();

    const admitted = await admitAndBuildStepEnvelope({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId ?? null,
      subjectId: subject.subjectId ?? null,
      resolved,
      opDecision,
      limits: body.limits ?? {},
      requireRequestedEnvelope: false,
    });
    const effNetDigest = networkPolicyDigest(admitted.networkPolicy.allowedDomains, admitted.networkPolicy.rules ?? null);

    // ── Safety pre-check ─────────────────────────────────────────────
    const safetyResult = await safetyPreCheck({
      app,
      subject,
      authorization: (req.headers.authorization as string | undefined) ?? null,
      traceId: req.ctx.traceId,
      locale: req.ctx.locale ?? "zh-CN",
      toolRef: resolved.toolRef,
      scope: resolved.scope,
      riskLevel: resolved.definition.riskLevel ?? "low",
      input: body.input,
    });
    if (!safetyResult.safe) {
      req.ctx.audit!.errorCategory = "safety_denied";
      req.ctx.audit!.outputDigest = { safetyPreCheck: { decision: "denied", method: safetyResult.method, riskLevel: safetyResult.riskLevel, reason: safetyResult.reason, suggestion: safetyResult.suggestion, durationMs: safetyResult.durationMs } };
      return reply.status(403).send({
        errorCode: "ORCH_SAFETY_DENIED",
        message: { "zh-CN": `安全预检查未通过：${safetyResult.reason ?? "操作可能存在风险"}`, "en-US": `Safety pre-check denied: ${safetyResult.reason ?? "operation may be risky"}` },
        suggestion: safetyResult.suggestion,
        traceId: req.ctx.traceId,
      });
    }

    // ── Phase 3: Build step input & submit (via execution kernel) ────
    const stepInput = buildStepInputPayload({
      kind: "tool.execute",
      resolved,
      admitted,
      input: body.input,
      idempotencyKey,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      subjectId: subject.subjectId,
      traceId: req.ctx.traceId,
    });

    const result = await submitNewToolRun({
      pool: app.db,
      queue: app.queue,
      tenantId: subject.tenantId,
      resolved,
      opDecision,
      stepInput,
      idempotencyKey,
      createdBySubjectId: subject.subjectId,
      trigger: "orchestrator",
      masterKey: app.cfg.secrets.masterKey,
    });

    const receipt = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId, runId: result.runId, stepId: result.stepId }, status: result.outcome };

    if (result.outcome === "needs_approval") {
      req.ctx.audit!.outputDigest = {
        status: "needs_approval",
        toolRef: resolved.toolRef,
        runId: result.runId,
        stepId: result.stepId,
        approvalId: result.approvalId,
        turnId: bindTurnId ?? undefined,
        suggestionId: bindSuggestionId ?? undefined,
        safetySummary: { decision: "allowed", target: piTarget, ruleIds: piSummary.ruleIds, promptInjection: piSummary },
        runtimePolicy: { networkPolicyDigest: effNetDigest },
      };
      return { jobId: result.jobId, runId: result.runId, stepId: result.stepId, approvalId: result.approvalId, idempotencyKey, turnId: bindTurnId ?? undefined, suggestionId: bindSuggestionId ?? undefined, receipt: { ...receipt, status: "needs_approval" as const } };
    }

    req.ctx.audit!.outputDigest = {
      status: "queued",
      toolRef: resolved.toolRef,
      runId: result.runId,
      stepId: result.stepId,
      turnId: bindTurnId ?? undefined,
      suggestionId: bindSuggestionId ?? undefined,
      safetySummary: { decision: "allowed", target: piTarget, ruleIds: piSummary.ruleIds, promptInjection: piSummary },
      runtimePolicy: { networkPolicyDigest: effNetDigest },
    };
    return { jobId: result.jobId, runId: result.runId, stepId: result.stepId, idempotencyKey, turnId: bindTurnId ?? undefined, suggestionId: bindSuggestionId ?? undefined, receipt };
  });
};
