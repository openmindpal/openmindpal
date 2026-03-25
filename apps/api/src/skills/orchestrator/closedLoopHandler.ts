/**
 * Closed-loop initial execution handler.
 * POST /orchestrator/closed-loop
 *
 * Extracted from routes.closedLoop.ts to reduce file size.
 */
import type { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { requirePermission } from "../../modules/auth/guard";
import { setAuditContext } from "../../modules/audit/context";
import { getToolDefinition } from "../../modules/tools/toolRepo";
import { validateToolInput } from "../../modules/tools/validate";
import { createJobRun, listSteps } from "../../modules/workflow/jobRepo";
import { sha256Hex } from "../../lib/digest";
import { createRetrievalLog, searchChunks } from "../knowledge-rag/modules/repo";
import { getTaskState, upsertTaskState } from "../memory-manager/modules/repo";
import { safetyPreCheck } from "./modules/safetyPreCheck";
import { orchestrateChatTurn } from "./modules/orchestrator";
import { buildHeuristicPlanV4 } from "./modules/planner";
import { resolveAndValidateTool, admitAndBuildStepEnvelope, buildStepInputPayload, submitStepToExistingRun } from "../../kernel/executionKernel";
import {
  type ClosedLoopPhase,
  buildClosedLoopSummaryV1,
  digestText,
  digestToolRefs,
  normalizePlanningMode,
  normalizeExecutionSemantics,
  buildEvalCaseResultSummary,
} from "./closedLoopUtils";

export const closedLoopHandlerRoutes: FastifyPluginAsync = async (app) => {
  app.post("/orchestrator/closed-loop", async (req, reply) => {
    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    setAuditContext(req, { resourceType: "orchestrator", action: "closed_loop" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "orchestrator", action: "closed_loop" });

    const body = z
      .object({
        goal: z.string().min(1).max(5000),
        purpose: z.string().min(1).max(100).optional(),
        planningMode: z.enum(["plan_execute", "react"]).optional(),
        executionSemantics: z.enum(["execute", "dry_run", "replay_only"]).optional(),
        constraints: z
          .object({
            allowedTools: z.array(z.string().min(1).max(200)).max(200).optional(),
            allowWrites: z.boolean().optional(),
          })
          .optional(),
        retriever: z
          .object({
            query: z.string().min(1).max(5000).optional(),
            limit: z.number().int().positive().max(20).optional(),
          })
          .optional(),
        limits: z
          .object({
            maxSteps: z.number().int().positive().max(10).optional(),
            maxWallTimeMs: z.number().int().positive().max(60 * 60 * 1000).optional(),
            maxReplans: z.number().int().positive().max(5).optional(),
          })
          .optional(),
        runId: z.string().min(10).optional(),
      })
      .parse(req.body);

    const purpose = body.purpose ?? "default";
    const goal = body.goal;
    const planningMode = normalizePlanningMode(body.planningMode);
    const executionSemantics = normalizeExecutionSemantics(body.executionSemantics);
    const allowWrites = executionSemantics === "execute" ? body.constraints?.allowWrites !== false : body.constraints?.allowWrites === true;
    const maxSteps = body.limits?.maxSteps ?? 3;
    const maxWallTimeMs = body.limits?.maxWallTimeMs ?? 5 * 60 * 1000;
    const maxReplans = body.limits?.maxReplans ?? 1;
    const allowedToolsList = Array.isArray(body.constraints?.allowedTools) ? body.constraints?.allowedTools.map((x) => String(x).trim()).filter(Boolean) : [];
    const allowedTools = allowedToolsList.length ? new Set(allowedToolsList) : null;

    if (executionSemantics === "replay_only") {
      const runId = String(body.runId ?? "").trim();
      if (!runId) throw Errors.badRequest("replay_only 需要 runId");
      await requirePermission({ req, resourceType: "memory", action: "task_state" });
      const state = await getTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId });
      const steps = await listSteps(app.db, runId);
      const plan = state?.plan ?? null;
      const limits = plan?.limits && typeof plan.limits === "object" ? plan.limits : { maxSteps: 3, maxWallTimeMs: 5 * 60 * 1000 };
      const maxSteps2 = typeof limits.maxSteps === "number" ? limits.maxSteps : 3;
      const maxWallTimeMs2 = typeof limits.maxWallTimeMs === "number" ? limits.maxWallTimeMs : 5 * 60 * 1000;
      const artifacts: any = state?.artifactsDigest && typeof state.artifactsDigest === "object" ? state.artifactsDigest : {};
      const cursor = typeof artifacts.cursor === "number" && Number.isFinite(artifacts.cursor) ? Math.max(0, Math.floor(artifacts.cursor)) : steps.length;
      const runStatusRes = await app.db.query("SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1", [subject.tenantId, runId]);
      const runStatus = runStatusRes.rowCount ? String((runStatusRes.rows[0] as any).status ?? "") : null;
      const closedLoop = buildClosedLoopSummaryV1({ plan, steps, cursor, maxSteps: maxSteps2, maxWallTimeMs: maxWallTimeMs2, runStatus });
      const planToolRefs = Array.isArray(plan?.steps) ? plan.steps.map((s: any) => String(s?.toolRef ?? "")).filter(Boolean) : [];
      const planDigest = { planVersion: String(plan?.planVersion ?? plan?.version ?? ""), stepCount: planToolRefs.length, toolRefsDigest: digestToolRefs(planToolRefs) };
      req.ctx.audit!.outputDigest = { runId, mode: "replay_only", phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction, planDigest };
      const evalCaseResult = { summary: buildEvalCaseResultSummary({ semantics: "replay_only", phase: closedLoop.phase, plannedSteps: planToolRefs.length, queuedSteps: 0, blockedSteps: 0, observedSteps: steps.length, planDigest }) };
      return { runtime: "closed-loop" as const, runId, mode: "replay_only", phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction, closedLoop, planDigest, evalCaseResult };
    }

    const jobRun = await createJobRun({
      pool: app.db,
      tenantId: subject.tenantId,
      jobType: "agent.run",
      runToolRef: "orchestrator.closed_loop@3",
      inputDigest: { purpose, goalDigest: digestText(goal), planningMode, executionSemantics, limits: { maxSteps, maxWallTimeMs, maxReplans }, constraints: { allowedToolsCount: allowedToolsList.length, allowWrites } },
      createdBySubjectId: subject.subjectId,
      trigger: "api",
    });
    const runId = jobRun.run.runId;
    const jobId = jobRun.job.jobId;
    const retrieverQuery = body.retriever?.query ?? goal;
    const retrieverLimit = body.retriever?.limit ?? 5;

    function pickActionFromGoal(goalText: string) {
      const raw = goalText.trim();
      if (!raw.startsWith("{")) return null;
      try {
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
        const toolRef = typeof (obj as any).toolRef === "string" ? String((obj as any).toolRef) : "";
        const input = (obj as any).input;
        const idempotencyKey = typeof (obj as any).idempotencyKey === "string" ? String((obj as any).idempotencyKey) : null;
        if (!toolRef) return null;
        return { toolRef, input, idempotencyKey };
      } catch {
        return null;
      }
    }

    const t0 = Date.now();
    const goalDigest = digestText(goal);
    let plan: any = {
      planVersion: "v4",
      planRevision: 0,
      goalDigest,
      purpose,
      planningMode,
      executionSemantics,
      constraints: { allowedTools: allowedToolsList.length ? allowedToolsList : undefined, allowWrites },
      limits: { maxSteps, maxWallTimeMs, maxReplans },
      steps: [],
    };
    await requirePermission({ req, resourceType: "memory", action: "task_state" });
    await requirePermission({ req, resourceType: "knowledge", action: "search" });
    const hits = await searchChunks({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId, query: retrieverQuery, limit: retrieverLimit });
    const rankPolicy = "substring_pos_created_at";
    const evidenceRefs = hits.map((h) => ({
      sourceRef: { documentId: h.document_id, version: h.document_version, chunkId: h.id },
      snippetDigest: { len: String(h.snippet ?? "").length, sha256_8: sha256Hex(String(h.snippet ?? "")).slice(0, 8) },
      location: { chunkIndex: h.chunk_index, startOffset: h.start_offset, endOffset: h.end_offset },
      rankReason: { kind: rankPolicy, matchPos: typeof h.match_pos === "number" ? h.match_pos : null },
    }));
    const retrievalLogId = await createRetrievalLog({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      queryDigest: { queryLen: retrieverQuery.length, rankPolicy },
      filtersDigest: { spaceId: subject.spaceId, runId, source: "orchestrator.closed-loop" },
      candidateCount: hits.length,
      citedRefs: evidenceRefs.map((e) => e.sourceRef),
    });
    await upsertTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId, phase: "retrieved", plan, artifactsDigest: { retrievalLogId, evidenceCount: evidenceRefs.length, evidenceRefs } });

    const approvalRequired = /(^|\\b)(delete|drop|truncate|rm\\s+-rf|destroy|erase)\\b/i.test(goal);
    const guard = approvalRequired ? { allow: false, approvalRequired: true, reasonSummary: "high_risk_intent" } : { allow: true, approvalRequired: false, reasonSummary: "ok" };
    await upsertTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId, phase: "guarded", plan, artifactsDigest: { retrievalLogId, evidenceCount: evidenceRefs.length, guard } });

    const explicit = guard.allow ? pickActionFromGoal(goal) : null;
    const suggestions = explicit
      ? [{ toolRef: explicit.toolRef, inputDraft: explicit.input ?? {}, idempotencyKey: explicit.idempotencyKey ?? null }]
      : (await orchestrateChatTurn({
          app,
          pool: app.db,
          subject,
          message: goal,
          locale: req.ctx.locale,
          authorization: (req.headers.authorization as string | undefined) ?? null,
          traceId: req.ctx.traceId,
          persistSession: false,
        })).toolSuggestions ?? [];

    const { planSteps } = await buildHeuristicPlanV4({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      subjectId: subject.subjectId,
      goal,
      suggestions,
      allowedTools,
      allowWrites,
      maxSteps,
    });

    if (!planSteps.length) {
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply.status(409).send({ errorCode: "ORCH_PLAN_EMPTY", message: { "zh-CN": "未找到可执行的计划步骤（工具可能未启用）", "en-US": "No executable plan step found (tool may be disabled)" }, traceId: req.ctx.traceId });
    }

    plan = { ...plan, steps: planSteps };
    await upsertTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId, phase: "planned", plan, artifactsDigest: { retrievalLogId, evidenceCount: evidenceRefs.length, guard, cursor: 0 } });

    const cursor = 0;
    const stepPlan = planSteps[cursor]!;
    let execution: any = guard.allow ? { status: "skipped", reason: "no_action" } : { status: "blocked", reason: "approval_required" };
    if (guard.allow && executionSemantics !== "dry_run") {
      try {
        const toolRef = String(stepPlan.toolRef);
        const resolved = await resolveAndValidateTool({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, rawToolRef: toolRef });

        if (resolved.toolName === "memory.read") await requirePermission({ req, resourceType: "memory", action: "read" });
        if (resolved.toolName === "memory.write") await requirePermission({ req, resourceType: "memory", action: "write" });

        validateToolInput(resolved.version.inputSchema, stepPlan.inputDraft);

        const opDecision = await requirePermission({ req, resourceType: resolved.resourceType, action: resolved.action });
        const idempotencyKey = resolved.scope === "write" && resolved.idempotencyRequired ? `idem-orch-${runId}-${cursor + 1}` : null;

        const admitted = await admitAndBuildStepEnvelope({
          pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? null, subjectId: subject.subjectId ?? null,
          resolved, opDecision, limits: {}, requireRequestedEnvelope: false,
        });
        const effNetDigest = admitted.networkPolicyDigest;

        const safetyResult = await safetyPreCheck({ app, subject, authorization: (req.headers.authorization as string | undefined) ?? null, traceId: req.ctx.traceId, locale: req.ctx.locale ?? "zh-CN", toolRef: resolved.toolRef, scope: resolved.scope, riskLevel: resolved.definition.riskLevel ?? "low", input: stepPlan.inputDraft });
        if (!safetyResult.safe) {
          execution = { status: "safety_denied", reason: safetyResult.reason ?? "operation may be risky", suggestion: safetyResult.suggestion, safetyPreCheck: { method: safetyResult.method, riskLevel: safetyResult.riskLevel, durationMs: safetyResult.durationMs } };
        } else {
          const stepInput = buildStepInputPayload({
            kind: "agent.run.step", resolved, admitted, input: stepPlan.inputDraft,
            idempotencyKey, tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId, traceId: req.ctx.traceId,
            extra: { planStepId: stepPlan.stepId, actorRole: "executor", dependsOn: [] },
          });

          const submitResult = await submitStepToExistingRun({
            pool: app.db, queue: app.queue, tenantId: subject.tenantId, resolved, opDecision, stepInput,
            runId, jobId, masterKey: app.cfg.secrets.masterKey,
          });

          if (submitResult.outcome === "needs_approval") {
            execution = { status: "blocked", reason: "approval_required", toolRef: resolved.toolRef, runId, stepId: submitResult.stepId, approvalId: submitResult.approvalId, idempotencyKey, runtimePolicy: { networkPolicyDigest: effNetDigest } };
          } else {
            execution = { status: "queued", toolRef: resolved.toolRef, runId, stepId: submitResult.stepId, idempotencyKey, runtimePolicy: { networkPolicyDigest: effNetDigest } };
          }
        }
      } catch (err: any) {
        execution = { status: "failed", reason: "executor_error", errorDigest: { message: String(err?.message ?? err) } };
      }
    }
    if (guard.allow && executionSemantics === "dry_run") {
      const toolRef = String(stepPlan.toolRef ?? "");
      const at = toolRef.lastIndexOf("@");
      const toolName = at > 0 ? toolRef.slice(0, at) : toolRef;
      const def = await getToolDefinition(app.db, subject.tenantId, toolName);
      const scope = def?.scope ?? null;
      const toolApprovalRequired = Boolean(def?.approvalRequired) || def?.riskLevel === "high";
      const scopeBlocked = scope === "write" && !allowWrites;
      execution = { status: "dry_run", toolRef, blocked: toolApprovalRequired || scopeBlocked, reason: toolApprovalRequired ? "approval_required" : scopeBlocked ? "writes_not_allowed" : "ok" };
    }

    const latencyMs = Date.now() - t0;
    const stepsAfter = await listSteps(app.db, runId);
    const runStatusRes = await app.db.query("SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1", [subject.tenantId, runId]);
    const runStatus = runStatusRes.rowCount ? String((runStatusRes.rows[0] as any).status ?? "") : null;
    const closedLoop = buildClosedLoopSummaryV1({ plan, steps: stepsAfter, cursor: 1, maxSteps, maxWallTimeMs, runStatus });
    await upsertTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId, phase: closedLoop.phase, plan, artifactsDigest: { retrievalLogId, evidenceCount: evidenceRefs.length, guard, execution, cursor: 1, latencyMs, maxWallTimeMs, maxSteps, closedLoop } });

    const planToolRefs = planSteps.map((s: any) => String(s?.toolRef ?? "")).filter(Boolean);
    const planDigest = { planVersion: "v4", stepCount: planToolRefs.length, toolRefsDigest: digestToolRefs(planToolRefs) };
    req.ctx.audit!.inputDigest = { purpose, goalDigest, planningMode, executionSemantics, retrieverQueryLen: retrieverQuery.length, retrieverLimit, limits: { maxSteps, maxWallTimeMs, maxReplans }, constraints: { allowedToolsCount: allowedToolsList.length, allowWrites } };
    req.ctx.audit!.outputDigest = { runId, phase: closedLoop.phase, cursor: 1, nextAction: closedLoop.executionSummary.nextAction, latencyMs, planDigest };
    const evalCaseResult =
      executionSemantics === "execute"
        ? undefined
        : {
            summary: buildEvalCaseResultSummary({
              semantics: executionSemantics,
              phase: closedLoop.phase,
              plannedSteps: planToolRefs.length,
              queuedSteps: execution?.status === "queued" ? 1 : 0,
              blockedSteps: execution?.status === "blocked" ? 1 : execution?.status === "dry_run" && execution?.blocked ? 1 : 0,
              observedSteps: stepsAfter.length,
              planDigest,
            }),
          };
    return { runtime: "closed-loop" as const, runId, plan, planDigest, phase: closedLoop.phase, cursor: 1, nextAction: closedLoop.executionSummary.nextAction, closedLoop, retrievalLogId, evidenceRefs, guard, execution, latencyMs, evalCaseResult };
  });
};
