import type { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission, requireSubject } from "../../modules/auth/guard";
import { getTask } from "../task-manager/modules/taskRepo";
import { appendAgentMessage } from "../task-manager/modules/agentMessageRepo";
import { getTaskState, upsertTaskState } from "../memory-manager/modules/repo";
import { createApproval } from "../../modules/workflow/approvalRepo";
import { appendStepToRun, createJobRun, getRunForSpace, listSteps } from "../../modules/workflow/jobRepo";
import { enqueueWorkflowStep, setRunAndJobStatus } from "../../modules/workflow/queue";
import { resolveAndValidateTool, admitAndBuildStepEnvelope, buildStepInputPayload } from "../../kernel/executionKernel";
import { runPlanningPipeline, type PlanFailureCategory } from "../../kernel/planningKernel";

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

    /* ── Use planning kernel: discover + LLM + parse + validate ── */
    const planResult = await runPlanningPipeline({
      app, pool: app.db, subject, spaceId: subject.spaceId, locale: req.ctx.locale,
      authorization: (req.headers.authorization as string | undefined) ?? null,
      traceId: req.ctx.traceId, userMessage: body.message, maxSteps,
      purpose: "agent-runtime.plan", plannerRole: "agent",
    });

    const planSteps = planResult.planSteps;

    if (!planResult.ok) {
      const planFailureCategory = planResult.failureCategory as PlanFailureCategory;
      const statusCode = planFailureCategory === "model_error" ? 503 : planFailureCategory === "parse_error" ? 422 : 409;
      req.ctx.audit!.errorCategory = planFailureCategory === "model_error" ? "upstream" : "policy_violation";
      app.metrics.incAgentPlanFailed({ runtime: "agent-runtime", category: planFailureCategory });
      return reply.status(statusCode).send({
        errorCode:
          planFailureCategory === "model_error"
            ? "AGENT_PLAN_MODEL_ERROR"
            : planFailureCategory === "parse_error"
              ? "AGENT_PLAN_PARSE_ERROR"
              : planFailureCategory === "no_tools"
                ? "AGENT_PLAN_NO_TOOLS"
                : planFailureCategory === "no_enabled_suggestion"
                  ? "AGENT_PLAN_SUGGESTION_DISABLED"
                  : "AGENT_PLAN_EMPTY",
        message: {
          "zh-CN":
            planFailureCategory === "model_error"
              ? "规划阶段模型调用失败"
              : planFailureCategory === "parse_error"
                ? "规划阶段模型输出无法解析为 tool_call"
                : planFailureCategory === "no_tools"
                  ? "当前空间没有可用工具"
                  : planFailureCategory === "no_enabled_suggestion"
                    ? "模型建议的工具均不可用或未启用"
                    : "未找到可执行的计划步骤",
          "en-US":
            planFailureCategory === "model_error"
              ? "Planner model invocation failed"
              : planFailureCategory === "parse_error"
                ? "Planner output cannot be parsed into tool_call"
                : planFailureCategory === "no_tools"
                  ? "No tools available in current space"
                  : planFailureCategory === "no_enabled_suggestion"
                    ? "Suggested tools are not enabled/available"
                    : "No executable plan step found",
        },
        details: { category: planFailureCategory, toolCatalogAvailable: Boolean(planResult.toolCatalog), suggestedCount: planResult.rawSuggestionCount, pickedCount: planResult.filteredSuggestionCount },
        traceId: req.ctx.traceId,
      });
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

      // ── Use execution kernel: resolve & validate ──
      const resolved = await resolveAndValidateTool({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, rawToolRef: toolRef });

      const opDecision = await requirePermission({ req, resourceType: resolved.resourceType, action: resolved.action });
      const idempotencyKey = resolved.scope === "write" && resolved.idempotencyRequired ? `idem-agent-${run.runId}-${i + 1}` : null;

      // ── Use execution kernel: admit & build envelope ──
      const admitted = await admitAndBuildStepEnvelope({
        pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? null, subjectId: subject.subjectId ?? null,
        resolved, opDecision, limits: {}, requireRequestedEnvelope: false,
      });

      // ── Use execution kernel: build step input ──
      const stepInput = buildStepInputPayload({
        kind: "agent.run.step", resolved, admitted, input: p.inputDraft ?? {},
        idempotencyKey, tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId, traceId: req.ctx.traceId,
        extra: { planStepId: p.stepId, actorRole: String(p.actorRole ?? "executor"), dependsOn: Array.isArray(p.dependsOn) ? p.dependsOn : [] },
      });

      const step = await appendStepToRun({
        pool: app.db, tenantId: subject.tenantId, jobType: "agent.run", runId: run.runId,
        toolRef: resolved.toolRef, policySnapshotRef: opDecision.snapshotRef, masterKey: app.cfg.secrets.masterKey,
        input: stepInput,
      });
      createdSteps.push(step);
    }

    const step = createdSteps[0];
    const stepRow = await app.db.query("SELECT tool_ref, input, policy_snapshot_ref, input_digest FROM steps WHERE step_id = $1 LIMIT 1", [step.stepId]);
    const stepInput = stepRow.rowCount ? (stepRow.rows[0].input as any) : null;
    const approvalRequired = Boolean(stepInput?.toolContract?.approvalRequired) || stepInput?.toolContract?.riskLevel === "high";

    if (approvalRequired) {
      await setRunAndJobStatus({ pool: app.db, tenantId: subject.tenantId, runId: run.runId, jobId: job.jobId, runStatus: "needs_approval", jobStatus: "needs_approval" });
      const approval = await createApproval({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        runId: run.runId,
        stepId: step.stepId,
        requestedBySubjectId: subject.subjectId,
        toolRef: step.toolRef ?? null,
        policySnapshotRef: step.policySnapshotRef ?? null,
        inputDigest: step.inputDigest ?? null,
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
      return { runtime: "agent-runtime" as const, runId: run.runId, jobId: job.jobId, stepId: step.stepId, approvalId: approval.approvalId, status: "needs_approval" as const, taskState: taskState1 };
    }

    await setRunAndJobStatus({ pool: app.db, tenantId: subject.tenantId, runId: run.runId, jobId: job.jobId, runStatus: "queued", jobStatus: "queued" });
    await enqueueWorkflowStep({ queue: app.queue, pool: app.db, jobId: job.jobId, runId: run.runId, stepId: step.stepId });
    req.ctx.audit!.outputDigest = { runId: run.runId, jobId: job.jobId, stepId: step.stepId, status: "queued" };
    return { runtime: "agent-runtime" as const, runId: run.runId, jobId: job.jobId, stepId: step.stepId, status: "queued" as const, taskState: taskState0 };
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
    return { runtime: "agent-runtime" as const, runId: params.runId, status: "canceled" as const };
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
    if (!stepRes.rowCount) return { runtime: "agent-runtime" as const, runId: params.runId, status: "noop" as const };
    const stepId = String(stepRes.rows[0].step_id ?? "");
    const bj = await app.queue.add("step", { jobId, runId: params.runId, stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });
    await app.db.query("UPDATE steps SET queue_job_id = $1, updated_at = now() WHERE step_id = $2", [String((bj as any).id), stepId]);
    req.ctx.audit!.outputDigest = { runId: params.runId, jobId, stepId, status: "queued" };
    return { runtime: "agent-runtime" as const, runId: params.runId, jobId, stepId, status: "queued" as const };
  });
};
