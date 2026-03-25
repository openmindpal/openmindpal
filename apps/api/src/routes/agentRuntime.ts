import type { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";
import type { CapabilityEnvelopeV1 } from "@openslin/shared";
import { normalizeNetworkPolicyV1, normalizeRuntimeLimitsV1 } from "@openslin/shared";
import { Errors } from "../lib/errors";
import { setAuditContext } from "../modules/audit/context";
import { requirePermission, requireSubject } from "../modules/auth/guard";
import { getEffectiveToolNetworkPolicy } from "../modules/governance/toolNetworkPolicyRepo";
import { isToolEnabled } from "../modules/governance/toolGovernanceRepo";
import { getTask } from "../modules/tasks/taskRepo";
import { appendAgentMessage } from "../modules/tasks/agentMessageRepo";
import { orchestrateTurn } from "../modules/orchestrator/orchestrator";
import { getToolDefinition, getToolVersionByRef } from "../modules/tools/toolRepo";
import { resolveEffectiveToolRef } from "../modules/tools/resolve";
import { getTaskState, upsertTaskState } from "../modules/memory/repo";
import { createApproval } from "../modules/workflow/approvalRepo";
import { appendStepToRun, createJobRun, getRunForSpace, listSteps } from "../modules/workflow/jobRepo";

function isPlainObject(v: any): v is Record<string, any> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

export const agentRuntimeRoutes: FastifyPluginAsync = async (app) => {
  app.post("/tasks/:taskId/agent-runs", async (req, reply) => {
    const params = z.object({ taskId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "agent_runtime", action: "run.create" });
    const decision = await requirePermission({ req, resourceType: "agent_runtime", action: "run.create" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const task = await getTask({ pool: app.db, tenantId: subject.tenantId, taskId: params.taskId });
    if (!task) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Task 不存在", "en-US": "Task not found" }, traceId: req.ctx.traceId });
    if (task.spaceId && task.spaceId !== subject.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const body = z
      .object({
        message: z.string().min(1).max(4000),
        limits: z
          .object({
            maxSteps: z.number().int().positive().max(20).optional(),
            maxWallTimeMs: z.number().int().positive().max(60 * 60 * 1000).optional(),
          })
          .optional(),
      })
      .parse(req.body);

    const maxSteps = body.limits?.maxSteps ?? 3;
    const maxWallTimeMs = body.limits?.maxWallTimeMs ?? 5 * 60 * 1000;

    const out = await orchestrateTurn({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? undefined, message: body.message });
    const suggestions = Array.isArray((out as any).toolSuggestions) ? ((out as any).toolSuggestions as any[]) : [];
    const picked = suggestions.slice(0, Math.max(0, maxSteps));

    const planSteps: any[] = [];
    for (const s of picked) {
      const rawToolRef = typeof s?.toolRef === "string" ? String(s.toolRef) : "";
      if (!rawToolRef) continue;
      const at = rawToolRef.lastIndexOf("@");
      const toolName = at > 0 ? rawToolRef.slice(0, at) : rawToolRef;
      const effToolRef =
        at > 0 ? rawToolRef : await resolveEffectiveToolRef({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, name: toolName });
      if (!effToolRef) continue;

      const ver = await getToolVersionByRef(app.db, subject.tenantId, effToolRef);
      if (!ver || String(ver.status) !== "released") continue;

      const enabled = await isToolEnabled({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, toolRef: effToolRef });
      if (!enabled) continue;

      const def = await getToolDefinition(app.db, subject.tenantId, toolName);
      const approvalRequired = Boolean(def?.approvalRequired) || def?.riskLevel === "high";
      const inputDraft = isPlainObject(s?.inputDraft) ? s.inputDraft : {};
      planSteps.push({
        stepId: crypto.randomUUID(),
        actorRole: "executor",
        kind: "tool",
        toolRef: effToolRef,
        inputDraft,
        dependsOn: [],
        approvalRequired,
      });
    }

    if (!planSteps.length) {
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply.status(409).send({ errorCode: "AGENT_PLAN_EMPTY", message: { "zh-CN": "未找到可执行的计划步骤（工具可能未启用）", "en-US": "No executable plan step found (tool may be disabled)" }, traceId: req.ctx.traceId });
    }

    const { job, run } = await createJobRun({
      pool: app.db,
      tenantId: subject.tenantId,
      jobType: "agent.run",
      runToolRef: "agent.run@1",
      inputDigest: {
        taskId: params.taskId,
        kind: "agent.run",
        limits: { maxSteps, maxWallTimeMs },
        messageDigest: { len: body.message.length },
      },
      createdBySubjectId: subject.subjectId,
      trigger: "agent_runtime",
    });

    const plan = { goal: body.message, limits: { maxSteps, maxWallTimeMs }, roles: [{ roleName: "executor", mode: "auto" }], steps: planSteps };
    const { taskState: taskState0, dlpSummary } = await upsertTaskState({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      runId: run.runId,
      phase: "planned",
      plan,
      artifactsDigest: { taskId: params.taskId },
    });

    await appendAgentMessage({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      taskId: params.taskId,
      fromAgentId: null,
      fromRole: "agent_runtime",
      intent: "plan",
      correlation: { runId: run.runId, jobId: job.jobId, dlpSummary },
      inputs: { messageDigest: { len: body.message.length }, limits: { maxSteps, maxWallTimeMs } },
      outputs: { planSummary: { steps: planSteps.map((x) => ({ toolRef: x.toolRef, approvalRequired: x.approvalRequired })) } },
    });

    const createdSteps: any[] = [];
    for (let i = 0; i < planSteps.length; i++) {
      const p = planSteps[i];
      const toolRef = String(p.toolRef);
      const at = toolRef.lastIndexOf("@");
      const toolName = at > 0 ? toolRef.slice(0, at) : toolRef;

      const def = await getToolDefinition(app.db, subject.tenantId, toolName);
      const scope = def?.scope ?? null;
      const resourceType = def?.resourceType ?? null;
      const action = def?.action ?? null;
      const idempotencyRequired = def?.idempotencyRequired ?? null;
      if (!scope || !resourceType || !action || idempotencyRequired === null) throw Errors.badRequest("工具契约缺失");

      const opDecision = await requirePermission({ req, resourceType, action });
      const idempotencyKey = scope === "write" && idempotencyRequired ? `idem-agent-${run.runId}-${i + 1}` : null;
      const effPol = await getEffectiveToolNetworkPolicy({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? undefined, toolRef });
      const effAllowedDomains = effPol?.allowedDomains ?? [];
      const effRules = (effPol as any)?.rules ?? [];
      const effNetworkPolicy = Array.isArray(effRules) && effRules.length ? { allowedDomains: effAllowedDomains, rules: effRules } : { allowedDomains: effAllowedDomains };
      const limits = {};
      const env: CapabilityEnvelopeV1 = {
        format: "capabilityEnvelope.v1",
        dataDomain: {
          tenantId: subject.tenantId,
          spaceId: subject.spaceId ?? null,
          subjectId: subject.subjectId ?? null,
          toolContract: { scope, resourceType, action, fieldRules: (opDecision as any).fieldRules ?? null, rowFilters: (opDecision as any).rowFilters ?? null },
        },
        secretDomain: { connectorInstanceIds: [] },
        egressDomain: { networkPolicy: normalizeNetworkPolicyV1(effNetworkPolicy) },
        resourceDomain: { limits: normalizeRuntimeLimitsV1(limits) },
      };

      const step = await appendStepToRun({
        pool: app.db,
        tenantId: subject.tenantId,
        jobType: "agent.run",
        runId: run.runId,
        toolRef,
        policySnapshotRef: opDecision.snapshotRef,
        masterKey: app.cfg.secrets.masterKey,
        input: {
          kind: "agent.run.step",
          planStepId: p.stepId,
          actorRole: String(p.actorRole ?? "executor"),
          dependsOn: Array.isArray(p.dependsOn) ? p.dependsOn : [],
          toolRef,
          idempotencyKey: idempotencyKey ?? undefined,
          toolContract: {
            scope,
            resourceType,
            action,
            idempotencyRequired,
            riskLevel: def?.riskLevel,
            approvalRequired: def?.approvalRequired,
            fieldRules: env.dataDomain.toolContract.fieldRules ?? null,
            rowFilters: env.dataDomain.toolContract.rowFilters ?? null,
          },
          input: p.inputDraft ?? {},
          limits: env.resourceDomain.limits,
          networkPolicy: env.egressDomain.networkPolicy,
          capabilityEnvelope: env,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId,
          subjectId: subject.subjectId,
          traceId: req.ctx.traceId,
        },
      });
      createdSteps.push(step);
    }

    const step = createdSteps[0];
    const stepRow = await app.db.query("SELECT tool_ref, input, policy_snapshot_ref, input_digest FROM steps WHERE step_id = $1 LIMIT 1", [step.stepId]);
    const stepToolRef = stepRow.rowCount ? (stepRow.rows[0].tool_ref as string | null) : null;
    const stepInput = stepRow.rowCount ? (stepRow.rows[0].input as any) : null;
    const stepPolicySnapshotRef = stepRow.rowCount ? (stepRow.rows[0].policy_snapshot_ref as string | null) : null;
    const stepInputDigest = stepRow.rowCount ? (stepRow.rows[0].input_digest as any) : null;
    const approvalRequired = Boolean(stepInput?.toolContract?.approvalRequired) || stepInput?.toolContract?.riskLevel === "high";

    if (approvalRequired) {
      await app.db.query("UPDATE runs SET status = 'needs_approval', updated_at = now() WHERE tenant_id = $1 AND run_id = $2", [subject.tenantId, run.runId]);
      await app.db.query("UPDATE jobs SET status = 'needs_approval', updated_at = now() WHERE tenant_id = $1 AND job_id = $2", [subject.tenantId, job.jobId]);
      const approval = await createApproval({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        runId: run.runId,
        stepId: step.stepId,
        requestedBySubjectId: subject.subjectId,
        toolRef: stepToolRef,
        policySnapshotRef: stepPolicySnapshotRef ?? null,
        inputDigest: stepInputDigest ?? null,
      });
      const { taskState: taskState1 } = await upsertTaskState({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        runId: run.runId,
        stepId: step.stepId,
        phase: "needs_approval",
        plan,
        artifactsDigest: { taskId: params.taskId, approvalId: approval.approvalId },
      });
      req.ctx.audit!.outputDigest = { runId: run.runId, jobId: job.jobId, stepId: step.stepId, status: "needs_approval" };
      return { runId: run.runId, jobId: job.jobId, stepId: step.stepId, approvalId: approval.approvalId, status: "needs_approval" as const, taskState: taskState1 };
    }

    await app.db.query("UPDATE runs SET status = 'queued', updated_at = now() WHERE tenant_id = $1 AND run_id = $2", [subject.tenantId, run.runId]);
    await app.db.query("UPDATE jobs SET status = 'queued', updated_at = now() WHERE tenant_id = $1 AND job_id = $2", [subject.tenantId, job.jobId]);
    const bj = await app.queue.add("step", { jobId: job.jobId, runId: run.runId, stepId: step.stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });
    await app.db.query("UPDATE steps SET queue_job_id = $1, updated_at = now() WHERE step_id = $2", [String((bj as any).id), step.stepId]);
    req.ctx.audit!.outputDigest = { runId: run.runId, jobId: job.jobId, stepId: step.stepId, status: "queued" };
    return { runId: run.runId, jobId: job.jobId, stepId: step.stepId, status: "queued" as const, taskState: taskState0 };
  });

  app.get("/tasks/:taskId/agent-runs/:runId", async (req, reply) => {
    const params = z.object({ taskId: z.string().uuid(), runId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "agent_runtime", action: "run.read" });
    const decision = await requirePermission({ req, resourceType: "agent_runtime", action: "run.read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) return reply.status(400).send({ errorCode: "BAD_REQUEST", message: { "zh-CN": "缺少 spaceId", "en-US": "Missing spaceId" }, traceId: req.ctx.traceId });

    const task = await getTask({ pool: app.db, tenantId: subject.tenantId, taskId: params.taskId });
    if (!task) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Task 不存在", "en-US": "Task not found" }, traceId: req.ctx.traceId });
    if (task.spaceId && task.spaceId !== subject.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const run = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, params.runId);
    if (!run) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Run 不存在", "en-US": "Run not found" }, traceId: req.ctx.traceId });

    const runsByTask = await app.db.query("SELECT 1 FROM runs WHERE tenant_id = $1 AND run_id = $2 AND (input_digest->>'taskId') = $3 LIMIT 1", [
      subject.tenantId,
      run.runId,
      params.taskId,
    ]);
    if (!runsByTask.rowCount) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const steps = await listSteps(app.db, run.runId);
    const taskState = await getTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId: run.runId });
    req.ctx.audit!.outputDigest = { runId: run.runId, status: run.status, stepCount: steps.length };
    return { run, taskState, steps };
  });

  app.post("/tasks/:taskId/agent-runs/:runId/cancel", async (req, reply) => {
    const params = z.object({ taskId: z.string().uuid(), runId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "agent_runtime", action: "run.cancel" });
    const decision = await requirePermission({ req, resourceType: "agent_runtime", action: "run.cancel" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) return reply.status(400).send({ errorCode: "BAD_REQUEST", message: { "zh-CN": "缺少 spaceId", "en-US": "Missing spaceId" }, traceId: req.ctx.traceId });
    const task = await getTask({ pool: app.db, tenantId: subject.tenantId, taskId: params.taskId });
    if (!task) throw Errors.badRequest("Task 不存在");
    if (task.spaceId && task.spaceId !== subject.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const visible = await app.db.query("SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 AND (input_digest->>'taskId') = $3 LIMIT 1", [
      subject.tenantId,
      params.runId,
      params.taskId,
    ]);
    if (!visible.rowCount) throw Errors.badRequest("Run 不存在");
    const status = String(visible.rows[0].status ?? "");
    if (["succeeded", "failed", "canceled"].includes(status)) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.runNotCancelable();
    }

    await app.db.query("UPDATE runs SET status = 'canceled', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE tenant_id = $1 AND run_id = $2", [
      subject.tenantId,
      params.runId,
    ]);
    await app.db.query("UPDATE jobs SET status = 'canceled', updated_at = now() WHERE tenant_id = $1 AND run_id = $2", [subject.tenantId, params.runId]);
    await app.db.query(
      "UPDATE steps SET status = 'canceled', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1 AND status IN ('pending','running')",
      [params.runId],
    );
    await upsertTaskState({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      runId: params.runId,
      phase: "canceled",
      artifactsDigest: { taskId: params.taskId },
    });
    req.ctx.audit!.outputDigest = { runId: params.runId, status: "canceled" };
    return { runId: params.runId, status: "canceled" as const };
  });

  app.post("/tasks/:taskId/agent-runs/:runId/continue", async (req, reply) => {
    const params = z.object({ taskId: z.string().uuid(), runId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "agent_runtime", action: "run.continue" });
    const decision = await requirePermission({ req, resourceType: "agent_runtime", action: "run.continue" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) return reply.status(400).send({ errorCode: "BAD_REQUEST", message: { "zh-CN": "缺少 spaceId", "en-US": "Missing spaceId" }, traceId: req.ctx.traceId });

    const task = await getTask({ pool: app.db, tenantId: subject.tenantId, taskId: params.taskId });
    if (!task) throw Errors.badRequest("Task 不存在");
    if (task.spaceId && task.spaceId !== subject.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const runRow = await app.db.query("SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 AND (input_digest->>'taskId') = $3 LIMIT 1", [
      subject.tenantId,
      params.runId,
      params.taskId,
    ]);
    if (!runRow.rowCount) throw Errors.badRequest("Run 不存在");
    const runStatus = String(runRow.rows[0].status ?? "");
    if (["succeeded", "failed", "canceled"].includes(runStatus)) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.badRequest("Run 已结束");
    }

    if (runStatus === "needs_approval") {
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply.status(409).send({ errorCode: "NEEDS_APPROVAL", message: { "zh-CN": "该 Run 需要审批后才能继续", "en-US": "Run requires approval before continuing" }, traceId: req.ctx.traceId });
    }

    const jobRes = await app.db.query("SELECT job_id FROM jobs WHERE tenant_id = $1 AND run_id = $2 ORDER BY created_at DESC LIMIT 1", [
      subject.tenantId,
      params.runId,
    ]);
    if (!jobRes.rowCount) throw Errors.badRequest("Job 不存在");
    const jobId = String(jobRes.rows[0].job_id ?? "");

    const stepRes = await app.db.query(
      "SELECT step_id FROM steps WHERE run_id = $1 AND status = 'pending' AND (queue_job_id IS NULL OR queue_job_id = '') ORDER BY seq ASC LIMIT 1",
      [params.runId],
    );
    if (!stepRes.rowCount) return { runId: params.runId, status: "noop" as const };
    const stepId = String(stepRes.rows[0].step_id ?? "");
    const bj = await app.queue.add("step", { jobId, runId: params.runId, stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });
    await app.db.query("UPDATE steps SET queue_job_id = $1, updated_at = now() WHERE step_id = $2", [String((bj as any).id), stepId]);
    req.ctx.audit!.outputDigest = { runId: params.runId, jobId, stepId, status: "queued" };
    return { runId: params.runId, jobId, stepId, status: "queued" as const };
  });
};
