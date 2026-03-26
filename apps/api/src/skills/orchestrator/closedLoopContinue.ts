/**
 * Closed-loop continuation handlers.
 * POST /orchestrator/closed-loop/continue
 * POST /orchestrator/closed-loop/retry
 * POST /orchestrator/closed-loop/skip
 * POST /orchestrator/closed-loop/stop
 *
 * Extracted from routes.closedLoop.ts to reduce file size.
 */
import type { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { requirePermission } from "../../modules/auth/guard";
import { setAuditContext } from "../../modules/audit/context";
import { validateToolInput } from "../../modules/tools/validate";
import { listSteps, retryDeadletterStep, retryFailedStep } from "../../modules/workflow/jobRepo";
import { enqueueWorkflowStep, setRunAndJobStatus } from "../../modules/workflow/queue";
import { getTaskState, upsertTaskState } from "../memory-manager/modules/repo";
import { safetyPreCheck } from "./modules/safetyPreCheck";
import { resolveAndValidateTool, admitAndBuildStepEnvelope, buildStepInputPayload, submitStepToExistingRun } from "../../kernel/executionKernel";
import {
  type ClosedLoopPhase,
  buildClosedLoopSummaryV1,
  normalizeStepStatus,
  digestToolRefs,
  normalizePlanningMode,
  normalizeExecutionSemantics,
  buildEvalCaseResultSummary,
} from "./closedLoopUtils";

export const closedLoopContinueRoutes: FastifyPluginAsync = async (app) => {
  app.post("/orchestrator/closed-loop/continue", async (req, reply) => {
    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    setAuditContext(req, { resourceType: "orchestrator", action: "closed_loop" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "orchestrator", action: "closed_loop" });

    const body = z
      .object({
        runId: z.string().min(10),
        planningMode: z.enum(["plan_execute", "react"]).optional(),
        executionSemantics: z.enum(["execute", "dry_run", "replay_only"]).optional(),
      })
      .parse(req.body);
    const runId = body.runId;

    await requirePermission({ req, resourceType: "memory", action: "task_state" });
    const state = await getTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId });
    if (!state?.plan) {
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "TaskState 不存在", "en-US": "TaskState not found" }, traceId: req.ctx.traceId });
    }

    const plan: any = state.plan;
    const stepsPlan: any[] = Array.isArray(plan.steps) ? plan.steps : [];
    const limits = plan.limits && typeof plan.limits === "object" ? plan.limits : {};
    const maxSteps = typeof limits.maxSteps === "number" ? limits.maxSteps : 3;
    const maxWallTimeMs = typeof limits.maxWallTimeMs === "number" ? limits.maxWallTimeMs : 5 * 60 * 1000;
    const maxReplans = typeof limits.maxReplans === "number" ? limits.maxReplans : 1;
    const planningMode = normalizePlanningMode(body.planningMode ?? (plan as any).planningMode);
    const executionSemantics = normalizeExecutionSemantics(body.executionSemantics ?? (plan as any).executionSemantics);

    const artifacts: any = state.artifactsDigest && typeof state.artifactsDigest === "object" ? state.artifactsDigest : {};
    const cursor = typeof artifacts.cursor === "number" && Number.isFinite(artifacts.cursor) ? Math.max(0, Math.floor(artifacts.cursor)) : 0;
    const createdAtMs = Date.parse(String(state.createdAt ?? ""));
    const elapsedMs = Number.isFinite(createdAtMs) ? Date.now() - createdAtMs : null;
    const steps = await listSteps(app.db, runId);
    const runStatusRes = await app.db.query("SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1", [subject.tenantId, runId]);
    const runStatus = runStatusRes.rowCount ? String((runStatusRes.rows[0] as any).status ?? "") : null;
    if (executionSemantics === "replay_only") {
      const closedLoop = buildClosedLoopSummaryV1({ plan, steps, cursor, maxSteps, maxWallTimeMs, runStatus });
      const planToolRefs = stepsPlan.map((s: any) => String(s?.toolRef ?? "")).filter(Boolean);
      const planDigest = { planVersion: String(plan?.planVersion ?? plan?.version ?? ""), stepCount: planToolRefs.length, toolRefsDigest: digestToolRefs(planToolRefs) };
      req.ctx.audit!.outputDigest = { runId, mode: "replay_only", phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction, planDigest };
      const evalCaseResult = { summary: buildEvalCaseResultSummary({ semantics: "replay_only", phase: closedLoop.phase, plannedSteps: planToolRefs.length, queuedSteps: 0, blockedSteps: 0, observedSteps: steps.length, planDigest }) };
      return { runtime: "closed-loop" as const, runId, mode: "replay_only", phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction, closedLoop, planDigest, evalCaseResult };
    }
    if (typeof elapsedMs === "number" && Number.isFinite(elapsedMs) && elapsedMs > maxWallTimeMs) {
      const base = buildClosedLoopSummaryV1({ plan, steps, cursor, maxSteps, maxWallTimeMs, runStatus });
      const closedLoop = { ...base, phase: "stopped" as const, executionSummary: { ...base.executionSummary, nextAction: { kind: "stop" as const, reason: "max_wall_time" }, stopReason: "max_wall_time" } };
      await upsertTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId, phase: closedLoop.phase, plan, artifactsDigest: { ...artifacts, cursor, elapsedMs, maxWallTimeMs, maxSteps, closedLoop } });
      req.ctx.audit!.outputDigest = { runId, phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction, elapsedMs, maxWallTimeMs };
      return { runtime: "closed-loop" as const, runId, phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction, closedLoop, elapsedMs, maxWallTimeMs };
    }
    if (cursor >= Math.min(maxSteps, stepsPlan.length)) {
      const closedLoop = buildClosedLoopSummaryV1({ plan, steps, cursor, maxSteps, maxWallTimeMs, runStatus });
      await upsertTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId, phase: closedLoop.phase, plan, artifactsDigest: { ...artifacts, cursor, maxWallTimeMs, maxSteps, closedLoop } });
      req.ctx.audit!.outputDigest = { runId, phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction };
      return { runtime: "closed-loop" as const, runId, phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction, closedLoop };
    }

    if (cursor > 0) {
      const prev = steps[cursor - 1] ?? null;
      const prevStatus = String((prev as any)?.status ?? "");
      if (prevStatus && ["pending", "running", "created"].includes(prevStatus)) {
        const closedLoop = buildClosedLoopSummaryV1({ plan, steps, cursor, maxSteps, maxWallTimeMs, runStatus });
        await upsertTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId, phase: closedLoop.phase, plan, artifactsDigest: { ...artifacts, cursor, maxWallTimeMs, maxSteps, closedLoop } });
        req.ctx.audit!.outputDigest = { runId, phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction };
        return { runtime: "closed-loop" as const, runId, phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction, closedLoop };
      }

      const replans = typeof artifacts.replans === "number" && Number.isFinite(artifacts.replans) ? Math.max(0, Math.floor(artifacts.replans)) : 0;
      const prevErrorCategory = typeof (prev as any)?.errorCategory === "string" ? String((prev as any).errorCategory) : typeof (prev as any)?.error_category === "string" ? String((prev as any).error_category) : "";
      const allowReplanForError = prevErrorCategory ? !["policy_violation", "validation_error"].includes(prevErrorCategory) : true;
      if (planningMode === "react" && replans < maxReplans && allowReplanForError && (prevStatus === "failed" || prevStatus === "deadletter")) {
        const attemptedToolRefs = Array.isArray(artifacts.attemptedToolRefs) ? (artifacts.attemptedToolRefs as any[]).map((x) => String(x)).filter(Boolean) : [];
        const prevToolRef = String((prev as any)?.toolRef ?? "");
        const attempted = new Set([...attemptedToolRefs, prevToolRef].filter(Boolean));
        const newSteps = stepsPlan.filter((s: any) => !attempted.has(String(s?.toolRef ?? "")));
        const replanDigest = { replans: replans + 1, attemptedCount: attempted.size, remainingSteps: newSteps.length };
        const newPlan = { ...(plan as any), planRevision: typeof (plan as any).planRevision === "number" ? (plan as any).planRevision + 1 : 1, steps: newSteps.length ? newSteps : stepsPlan };
        const closedLoop = buildClosedLoopSummaryV1({ plan: newPlan, steps, cursor, maxSteps, maxWallTimeMs, runStatus });
        await upsertTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId, phase: closedLoop.phase, plan: newPlan, artifactsDigest: { ...artifacts, replans: replans + 1, attemptedToolRefs: Array.from(attempted), replanDigest, cursor, maxWallTimeMs, maxSteps, closedLoop } });
        const planToolRefs = Array.isArray(newPlan.steps) ? newPlan.steps.map((s: any) => String(s?.toolRef ?? "")).filter(Boolean) : [];
        const planDigest = { planVersion: String(newPlan?.planVersion ?? newPlan?.version ?? ""), stepCount: planToolRefs.length, toolRefsDigest: digestToolRefs(planToolRefs) };
        req.ctx.audit!.outputDigest = { runId, phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction, replanDigest, planDigest };
        return { runtime: "closed-loop" as const, runId, phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction, closedLoop, replanDigest, planDigest };
      }
    }

    const t0 = Date.now();
    const stepPlan = stepsPlan[cursor] ?? null;
    if (!stepPlan) {
      const closedLoop = buildClosedLoopSummaryV1({ plan, steps, cursor, maxSteps, maxWallTimeMs, runStatus });
      await upsertTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId, phase: closedLoop.phase, plan, artifactsDigest: { ...artifacts, cursor, maxWallTimeMs, maxSteps, closedLoop } });
      req.ctx.audit!.outputDigest = { runId, phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction };
      return { runtime: "closed-loop" as const, runId, phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction, closedLoop };
    }

    const toolRef = String(stepPlan.toolRef ?? "");
    const at = toolRef.lastIndexOf("@");
    const toolName = at > 0 ? toolRef.slice(0, at) : toolRef;
    const allowed = Array.isArray((plan as any)?.constraints?.allowedTools) ? ((plan as any).constraints.allowedTools as any[]).map((x) => String(x).trim()).filter(Boolean) : [];
    if (allowed.length) {
      const set = new Set(allowed);
      if (!set.has(toolName) && !set.has(toolRef)) {
        req.ctx.audit!.errorCategory = "policy_violation";
        return reply.status(409).send({ errorCode: "ORCH_PLAN_EMPTY", message: { "zh-CN": "未找到可执行的计划步骤（工具可能未启用）", "en-US": "No executable plan step found (tool may be disabled)" }, traceId: req.ctx.traceId });
      }
    }
    const resolved = await resolveAndValidateTool({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, rawToolRef: toolRef });

    if (resolved.toolName === "memory.read") await requirePermission({ req, resourceType: "memory", action: "read" });
    if (resolved.toolName === "memory.write") await requirePermission({ req, resourceType: "memory", action: "write" });

    let inputDraft = stepPlan.inputDraft ?? {};
    if (resolved.toolName === "memory.write" && inputDraft && typeof inputDraft === "object") {
      const d: any = { ...(inputDraft as any) };
      if (d.contentText === undefined && d.content !== undefined) d.contentText = String(d.content);
      if (d.type === undefined) d.type = "note";
      if (d.content !== undefined) delete d.content;
      inputDraft = d;
    }
    validateToolInput(resolved.version.inputSchema, inputDraft);

    const opDecision = await requirePermission({ req, resourceType: resolved.resourceType, action: resolved.action });
    const idempotencyKey = resolved.scope === "write" && resolved.idempotencyRequired ? `idem-orch-${runId}-${cursor + 1}` : null;

    const admitted = await admitAndBuildStepEnvelope({
      pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? null, subjectId: subject.subjectId ?? null,
      resolved, opDecision, limits, requireRequestedEnvelope: false,
    });
    const effNetDigest = admitted.networkPolicyDigest;

    const safetyResultCont = await safetyPreCheck({ app, subject, authorization: (req.headers.authorization as string | undefined) ?? null, traceId: req.ctx.traceId, locale: req.ctx.locale ?? "zh-CN", toolRef: resolved.toolRef, scope: resolved.scope, riskLevel: resolved.definition.riskLevel ?? "low", input: inputDraft });
    if (!safetyResultCont.safe) {
      const latencyMs = Date.now() - t0;
      return {
        closedLoop: { summaryVersion: 1, runId, phase: "failed" as ClosedLoopPhase, cursor, execution: { status: "safety_denied", reason: safetyResultCont.reason ?? "operation may be risky", suggestion: safetyResultCont.suggestion, safetyPreCheck: { method: safetyResultCont.method, riskLevel: safetyResultCont.riskLevel, durationMs: safetyResultCont.durationMs } }, latencyMs },
        traceId: req.ctx.traceId,
      };
    }

    const stepInputPayload = buildStepInputPayload({
      kind: "agent.run.step", resolved, admitted, input: inputDraft,
      idempotencyKey, tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId, traceId: req.ctx.traceId,
      extra: { planStepId: String(stepPlan.stepId ?? crypto.randomUUID()), actorRole: "executor", dependsOn: [] },
    });

    const jobRes = await app.db.query("SELECT job_id FROM jobs WHERE tenant_id = $1 AND run_id = $2 ORDER BY created_at DESC LIMIT 1", [subject.tenantId, runId]);
    const jobId = jobRes.rowCount ? String(jobRes.rows[0].job_id ?? "") : "";
    if (!jobId) {
      req.ctx.audit!.errorCategory = "internal_error";
      return reply.status(500).send({ errorCode: "INTERNAL_ERROR", message: { "zh-CN": "Job 缺失", "en-US": "Job missing" }, traceId: req.ctx.traceId });
    }

    let execution: any;
    const allowWrites2 = Boolean((plan as any)?.constraints?.allowWrites);
    if (executionSemantics === "dry_run") {
      const scopeBlocked = resolved.scope === "write" && !allowWrites2;
      const toolApprovalRequired = Boolean(resolved.definition.approvalRequired) || resolved.definition.riskLevel === "high";
      execution = { status: "dry_run", toolRef: resolved.toolRef, blocked: toolApprovalRequired || scopeBlocked, reason: toolApprovalRequired ? "approval_required" : scopeBlocked ? "writes_not_allowed" : "ok" };
    } else {
      const resolvedForSubmit =
        resolved.scope === "write"
          ? { ...resolved, definition: { ...resolved.definition, approvalRequired: true } }
          : resolved;
      const submitResult = await submitStepToExistingRun({
        pool: app.db, queue: app.queue, tenantId: subject.tenantId, resolved: resolvedForSubmit, opDecision, stepInput: stepInputPayload,
        runId, jobId, masterKey: app.cfg.secrets.masterKey,
      });
      if (submitResult.outcome === "needs_approval") {
        execution = { status: "blocked", reason: "approval_required", toolRef: resolvedForSubmit.toolRef, runId, stepId: submitResult.stepId, approvalId: submitResult.approvalId, idempotencyKey, runtimePolicy: { networkPolicyDigest: effNetDigest } };
      } else {
        execution = { status: "queued", toolRef: resolvedForSubmit.toolRef, runId, stepId: submitResult.stepId, idempotencyKey, runtimePolicy: { networkPolicyDigest: effNetDigest } };
      }
    }

    const latencyMs = Date.now() - t0;
    const nextCursor = cursor + 1;
    const stepsAfter = await listSteps(app.db, runId);
    const runStatusRes2 = await app.db.query("SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1", [subject.tenantId, runId]);
    const runStatus2 = runStatusRes2.rowCount ? String((runStatusRes2.rows[0] as any).status ?? "") : null;
    const closedLoop = buildClosedLoopSummaryV1({ plan, steps: stepsAfter, cursor: nextCursor, maxSteps, maxWallTimeMs, runStatus: runStatus2 });
    await upsertTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId, phase: closedLoop.phase, plan, artifactsDigest: { ...artifacts, execution, cursor: nextCursor, latencyMs, maxWallTimeMs, maxSteps, closedLoop } });
    const planToolRefs = stepsPlan.map((s: any) => String(s?.toolRef ?? "")).filter(Boolean);
    const planDigest = { planVersion: String(plan?.planVersion ?? plan?.version ?? ""), stepCount: planToolRefs.length, toolRefsDigest: digestToolRefs(planToolRefs) };
    req.ctx.audit!.outputDigest = { runId, phase: closedLoop.phase, cursor: nextCursor, nextAction: closedLoop.executionSummary.nextAction, latencyMs, planningMode, executionSemantics, planDigest };
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
    return { runtime: "closed-loop" as const, runId, phase: closedLoop.phase, cursor: nextCursor, nextAction: closedLoop.executionSummary.nextAction, stepId: execution?.stepId, approvalId: execution?.approvalId, closedLoop, execution, latencyMs, planDigest, evalCaseResult };
  });

  app.post("/orchestrator/closed-loop/retry", async (req, reply) => {
    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    setAuditContext(req, { resourceType: "orchestrator", action: "closed_loop" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "orchestrator", action: "closed_loop" });

    const body = z.object({ runId: z.string().min(10) }).parse(req.body);
    const runId = body.runId;

    await requirePermission({ req, resourceType: "memory", action: "task_state" });
    const state = await getTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId });
    if (!state?.plan) {
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "TaskState 不存在", "en-US": "TaskState not found" }, traceId: req.ctx.traceId });
    }
    const plan: any = state.plan;
    const limits = plan.limits && typeof plan.limits === "object" ? plan.limits : {};
    const maxSteps = typeof limits.maxSteps === "number" ? limits.maxSteps : 3;
    const maxWallTimeMs = typeof limits.maxWallTimeMs === "number" ? limits.maxWallTimeMs : 5 * 60 * 1000;
    const artifacts: any = state.artifactsDigest && typeof state.artifactsDigest === "object" ? state.artifactsDigest : {};
    const cursor = typeof artifacts.cursor === "number" && Number.isFinite(artifacts.cursor) ? Math.max(0, Math.floor(artifacts.cursor)) : 0;
    const steps = await listSteps(app.db, runId);
    const idx = cursor > 0 ? cursor - 1 : 0;
    const target = steps[idx] ?? null;
    if (!target?.stepId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Step 不存在", "en-US": "Step not found" }, traceId: req.ctx.traceId });
    }
    const status = normalizeStepStatus(target.status);
    let retried: any = null;
    if (status === "deadletter") retried = await retryDeadletterStep({ pool: app.db, tenantId: subject.tenantId, stepId: target.stepId });
    else if (status === "failed") retried = await retryFailedStep({ pool: app.db, tenantId: subject.tenantId, stepId: target.stepId });
    else {
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply.status(409).send({ errorCode: "ORCH_CANNOT_RETRY", message: { "zh-CN": "当前步骤不可重试", "en-US": "Step cannot be retried" }, traceId: req.ctx.traceId });
    }
    if (!retried) {
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply.status(409).send({ errorCode: "ORCH_CANNOT_RETRY", message: { "zh-CN": "当前步骤不可重试", "en-US": "Step cannot be retried" }, traceId: req.ctx.traceId });
    }

    const jobRes = await app.db.query("SELECT job_id FROM jobs WHERE tenant_id = $1 AND run_id = $2 ORDER BY created_at DESC LIMIT 1", [subject.tenantId, runId]);
    const jobId = jobRes.rowCount ? String(jobRes.rows[0].job_id ?? "") : "";
    if (!jobId) {
      req.ctx.audit!.errorCategory = "internal_error";
      return reply.status(500).send({ errorCode: "INTERNAL_ERROR", message: { "zh-CN": "Job 缺失", "en-US": "Job missing" }, traceId: req.ctx.traceId });
    }
    await setRunAndJobStatus({ pool: app.db, tenantId: subject.tenantId, runId, jobId, runStatus: "queued", jobStatus: "queued" });
    await enqueueWorkflowStep({ queue: app.queue, pool: app.db, jobId, runId, stepId: retried.stepId });

    const runStatusRes = await app.db.query("SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1", [subject.tenantId, runId]);
    const runStatus = runStatusRes.rowCount ? String((runStatusRes.rows[0] as any).status ?? "") : null;
    const stepsAfter = await listSteps(app.db, runId);
    const closedLoop = buildClosedLoopSummaryV1({ plan, steps: stepsAfter, cursor, maxSteps, maxWallTimeMs, runStatus });
    await upsertTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId, phase: closedLoop.phase, plan, artifactsDigest: { ...artifacts, cursor, maxWallTimeMs, maxSteps, closedLoop } });
    req.ctx.audit!.outputDigest = { runId, cursor, stepId: retried.stepId, phase: closedLoop.phase, nextAction: closedLoop.executionSummary.nextAction };
    return { runtime: "closed-loop" as const, runId, phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction, closedLoop, stepId: retried.stepId };
  });

  app.post("/orchestrator/closed-loop/skip", async (req, reply) => {
    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    setAuditContext(req, { resourceType: "orchestrator", action: "closed_loop" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "orchestrator", action: "closed_loop" });

    const body = z.object({ runId: z.string().min(10) }).parse(req.body);
    const runId = body.runId;

    await requirePermission({ req, resourceType: "memory", action: "task_state" });
    const state = await getTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId });
    if (!state?.plan) {
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "TaskState 不存在", "en-US": "TaskState not found" }, traceId: req.ctx.traceId });
    }
    const plan: any = state.plan;
    const stepsPlan: any[] = Array.isArray(plan.steps) ? plan.steps : [];
    const limits = plan.limits && typeof plan.limits === "object" ? plan.limits : {};
    const maxSteps = typeof limits.maxSteps === "number" ? limits.maxSteps : 3;
    const maxWallTimeMs = typeof limits.maxWallTimeMs === "number" ? limits.maxWallTimeMs : 5 * 60 * 1000;
    const artifacts: any = state.artifactsDigest && typeof state.artifactsDigest === "object" ? state.artifactsDigest : {};
    const cursor = typeof artifacts.cursor === "number" && Number.isFinite(artifacts.cursor) ? Math.max(0, Math.floor(artifacts.cursor)) : 0;
    const nextCursor = Math.min(cursor + 1, Math.min(maxSteps, stepsPlan.length));
    const steps = await listSteps(app.db, runId);
    const runStatusRes = await app.db.query("SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1", [subject.tenantId, runId]);
    const runStatus = runStatusRes.rowCount ? String((runStatusRes.rows[0] as any).status ?? "") : null;
    const closedLoop = buildClosedLoopSummaryV1({ plan, steps, cursor: nextCursor, maxSteps, maxWallTimeMs, runStatus });
    await upsertTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId, phase: closedLoop.phase, plan, artifactsDigest: { ...artifacts, cursor: nextCursor, maxWallTimeMs, maxSteps, closedLoop } });
    req.ctx.audit!.outputDigest = { runId, fromCursor: cursor, toCursor: nextCursor, phase: closedLoop.phase, nextAction: closedLoop.executionSummary.nextAction };
    return { runtime: "closed-loop" as const, runId, phase: closedLoop.phase, cursor: nextCursor, nextAction: closedLoop.executionSummary.nextAction, closedLoop };
  });

  app.post("/orchestrator/closed-loop/stop", async (req, reply) => {
    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    setAuditContext(req, { resourceType: "orchestrator", action: "closed_loop" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "orchestrator", action: "closed_loop" });

    const body = z.object({ runId: z.string().min(10) }).parse(req.body);
    const runId = body.runId;

    await requirePermission({ req, resourceType: "memory", action: "task_state" });
    const state = await getTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId });
    if (!state?.plan) {
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "TaskState 不存在", "en-US": "TaskState not found" }, traceId: req.ctx.traceId });
    }
    const plan: any = state.plan;
    const limits = plan.limits && typeof plan.limits === "object" ? plan.limits : {};
    const maxSteps = typeof limits.maxSteps === "number" ? limits.maxSteps : 3;
    const maxWallTimeMs = typeof limits.maxWallTimeMs === "number" ? limits.maxWallTimeMs : 5 * 60 * 1000;
    const artifacts: any = state.artifactsDigest && typeof state.artifactsDigest === "object" ? state.artifactsDigest : {};
    const cursor = typeof artifacts.cursor === "number" && Number.isFinite(artifacts.cursor) ? Math.max(0, Math.floor(artifacts.cursor)) : 0;
    const steps = await listSteps(app.db, runId);
    const runStatusRes = await app.db.query("SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1", [subject.tenantId, runId]);
    const runStatus = runStatusRes.rowCount ? String((runStatusRes.rows[0] as any).status ?? "") : null;
    const base = buildClosedLoopSummaryV1({ plan, steps, cursor, maxSteps, maxWallTimeMs, runStatus });
    const closedLoop = { ...base, phase: "stopped" as const, executionSummary: { ...base.executionSummary, nextAction: { kind: "stop" as const, reason: "user_stop" } } };
    await upsertTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId, phase: closedLoop.phase, plan, artifactsDigest: { ...artifacts, cursor, maxWallTimeMs, maxSteps, closedLoop } });
    req.ctx.audit!.outputDigest = { runId, phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction };
    return { runtime: "closed-loop" as const, runId, phase: closedLoop.phase, cursor, nextAction: closedLoop.executionSummary.nextAction, closedLoop };
  });
};
