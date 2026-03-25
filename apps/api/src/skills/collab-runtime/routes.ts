import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { redactValue } from "@openslin/shared";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission, requireSubject } from "../../modules/auth/guard";
import { createCollabRun, getCollabRun, listCollabRunsByTask, setCollabRunPrimaryRun, updateCollabRunStatus } from "./modules/collabRepo";
import { appendCollabRunEvent, listCollabRunEvents } from "./modules/collabEventRepo";
import { appendCollabEnvelope, listCollabEnvelopes } from "./modules/collabEnvelopeRepo";
import { runPlanningPipeline, type PlanFailureCategory } from "../../kernel/planningKernel";
import { getTask } from "../task-manager/modules/taskRepo";
import { appendAgentMessage } from "../task-manager/modules/agentMessageRepo";
import { getTaskState, upsertTaskState } from "../memory-manager/modules/repo";
import { createApproval } from "../../modules/workflow/approvalRepo";
import { createJobRun } from "../../modules/workflow/jobRepo";
import { acquireWriteLease } from "../../modules/workflow/writeLease";
import { digestInputV1 } from "../../lib/digest";
import { enqueueWorkflowStep, setRunAndJobStatus } from "../../modules/workflow/queue";
import { createTaskAssignment, registerAgentRole, updateAgentRoleStatus, upsertPermissionContext, updateTaskAssignmentStatus, validateRoleConstraints } from "./modules/collabProtocolRepo";
import { listAgentRoles, listPermissionContexts, listTaskAssignments } from "./modules/collabProtocolRepo";
import { executeCollabPipeline } from "./collabExecutor";

function toSafeEnvelope(env: any) {
  if (!env || typeof env !== "object") return env;
  return { ...(env as any), payloadRedacted: null };
}

function toDigestRef(d: any) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return d;
  return { sha256_8: (d as any).sha256_8 ?? null, keyCount: (d as any).keyCount ?? null };
}

function normalizeBudgetV1(b: any) {
  const out: any = {};
  const maxSteps = b?.maxSteps ? Number(b.maxSteps) : null;
  const maxWallTimeMs = b?.maxWallTimeMs ? Number(b.maxWallTimeMs) : null;
  const maxTokens = b?.maxTokens ? Number(b.maxTokens) : null;
  const maxCostUsd = b?.maxCostUsd ? Number(b.maxCostUsd) : null;
  if (maxSteps && Number.isFinite(maxSteps)) out.maxSteps = Math.max(1, Math.min(50, Math.floor(maxSteps)));
  if (maxWallTimeMs && Number.isFinite(maxWallTimeMs)) out.maxWallTimeMs = Math.max(1000, Math.min(60 * 60 * 1000, Math.floor(maxWallTimeMs)));
  if (maxTokens && Number.isFinite(maxTokens)) out.maxTokens = Math.max(1, Math.min(10_000_000, Math.floor(maxTokens)));
  if (maxCostUsd !== null && Number.isFinite(maxCostUsd)) out.maxCostUsd = Math.max(0, Math.min(100_000, Number(maxCostUsd)));
  return Object.keys(out).length ? out : null;
}

export const collabRuntimeRoutes: FastifyPluginAsync = async (app) => {
  app.get("/tasks/:taskId/collab-runs", async (req, reply) => {
    const params = z.object({ taskId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "agent_runtime", action: "collab.read" });
    const decision = await requirePermission({ req, resourceType: "agent_runtime", action: "collab.read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const task = await getTask({ pool: app.db, tenantId: subject.tenantId, taskId: params.taskId });
    if (!task) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Task 不存在", "en-US": "Task not found" }, traceId: req.ctx.traceId });
    if (task.spaceId && task.spaceId !== subject.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const q = req.query as any;
    const limit = z.coerce.number().int().positive().max(200).optional().parse(q?.limit) ?? 20;
    const before = z.string().min(1).max(50).optional().parse(q?.before) ?? null;
    const status = z.string().min(1).max(50).optional().parse(q?.status) ?? null;

    const items = await listCollabRunsByTask({ pool: app.db, tenantId: subject.tenantId, taskId: params.taskId, status, before, limit: limit + 1 });
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const nextBefore = hasMore ? page[page.length - 1]!.createdAt : null;
    req.ctx.audit!.outputDigest = { taskId: params.taskId, count: page.length };
    return { items: page, nextBefore };
  });

  app.post("/tasks/:taskId/collab-runs", async (req, reply) => {
    const params = z.object({ taskId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "agent_runtime", action: "collab.create" });
    const decision = await requirePermission({ req, resourceType: "agent_runtime", action: "collab.create" });
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
        roles: z
          .array(
            z.object({
              roleName: z.string().min(1).max(50),
              mode: z.enum(["auto", "assist"]).optional(),
              toolPolicy: z
                .object({
                  allowedTools: z.array(z.string().min(1).max(200)).max(200).optional(),
                })
                .optional(),
              budget: z
                .object({
                  maxSteps: z.number().int().positive().max(50).optional(),
                  maxWallTimeMs: z.number().int().positive().max(60 * 60 * 1000).optional(),
                  maxTokens: z.number().int().positive().max(10_000_000).optional(),
                  maxCostUsd: z.number().positive().max(100_000).optional(),
                })
                .optional(),
            }),
          )
          .max(20)
          .optional(),
        limits: z
          .object({
            maxSteps: z.number().int().positive().max(20).optional(),
            maxWallTimeMs: z.number().int().positive().max(60 * 60 * 1000).optional(),
            maxTokens: z.number().int().positive().max(10_000_000).optional(),
            maxCostUsd: z.number().positive().max(100_000).optional(),
          })
          .optional(),
      })
      .parse(req.body);

    const requiredRoleNames = ["planner", "retriever", "guard", "executor", "reviewer", "arbiter"] as const;
    const providedRoles = body.roles?.length
      ? body.roles.map((r) => ({ roleName: r.roleName, mode: r.mode ?? "auto", toolPolicy: r.toolPolicy ?? null, budget: r.budget ?? null }))
      : null;

    const rolesAdded: string[] = [];
    const rolesSeen = new Set<string>();

    const rolesBase = providedRoles
      ? providedRoles.filter((r) => {
          const k = String(r.roleName ?? "").trim();
          if (!k) return false;
          if (rolesSeen.has(k)) return false;
          rolesSeen.add(k);
          return true;
        })
      : requiredRoleNames.map((roleName) => ({ roleName, mode: "auto" as const, toolPolicy: null, budget: null }));

    const roles = [...rolesBase];
    if (providedRoles) {
      for (const rn of requiredRoleNames) {
        if (!rolesSeen.has(rn)) {
          rolesAdded.push(rn);
          rolesSeen.add(rn);
          roles.push({ roleName: rn, mode: "auto", toolPolicy: null, budget: null });
        }
      }
    }

    const maxSteps = body.limits?.maxSteps ?? 3;
    const maxWallTimeMs = body.limits?.maxWallTimeMs ?? 5 * 60 * 1000;
    const limits = normalizeBudgetV1({ maxSteps, maxWallTimeMs, maxTokens: body.limits?.maxTokens, maxCostUsd: body.limits?.maxCostUsd }) ?? { maxSteps, maxWallTimeMs };

    for (const r of roles) {
      (r as any).budget = normalizeBudgetV1((r as any).budget);
    }

    const collab = await createCollabRun({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId ?? null,
      taskId: params.taskId,
      createdBySubjectId: subject.subjectId,
      status: "planning",
      roles,
      limits,
    });

    for (const r of roles) {
      const roleName = String((r as any)?.roleName ?? "").trim();
      if (!roleName) continue;
      const mode = String((r as any)?.mode ?? "auto");
      const toolPolicy = (r as any)?.toolPolicy ?? null;
      const budget = (r as any)?.budget ?? null;
      const constraints0 = validateRoleConstraints({
        maxSteps: budget?.maxSteps,
        maxWallTimeMs: budget?.maxWallTimeMs,
        maxTokens: budget?.maxTokens,
        maxCostUsd: budget?.maxCostUsd,
        allowedTools: Array.isArray(toolPolicy?.allowedTools) ? toolPolicy.allowedTools : undefined,
      });
      await registerAgentRole({
        pool: app.db,
        tenantId: subject.tenantId,
        collabRunId: collab.collabRunId,
        roleName,
        agentType: mode === "assist" ? "human" : "llm",
        capabilities: { mode, toolPolicy, budget },
        constraints: constraints0.constraints,
        policySnapshotRef: decision.snapshotRef ?? null,
      });
    }

    await appendCollabRunEvent({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId ?? null,
      collabRunId: collab.collabRunId,
      taskId: params.taskId,
      type: "collab.run.created",
      actorRole: null,
      payloadDigest: { limits: { maxSteps, maxWallTimeMs }, messageDigest: { len: body.message.length }, rolesSummary: { roles: roles.map((r) => r.roleName), added: rolesAdded } },
    });

    /* ── Use planning kernel: discover + LLM + parse + validate ── */
    const budgetPrefix = `collab:${collab.collabRunId}`;
    const budgetHeaders =
      limits.maxTokens || limits.maxCostUsd
        ? {
            "x-budget-purpose-prefix": budgetPrefix,
            ...(limits.maxTokens ? { "x-budget-max-tokens": String(limits.maxTokens) } : {}),
            ...(limits.maxCostUsd ? { "x-budget-max-cost-usd": String(limits.maxCostUsd) } : {}),
          }
        : undefined;
    const planResult = await runPlanningPipeline({
      app, pool: app.db, subject, spaceId: subject.spaceId, locale: req.ctx.locale,
      authorization: (req.headers.authorization as string | undefined) ?? null,
      traceId: req.ctx.traceId, userMessage: body.message, maxSteps,
      purpose: limits.maxTokens || limits.maxCostUsd ? `${budgetPrefix}:collab-runtime.plan` : "collab-runtime.plan",
      plannerRole: "collaborative agent",
      headers: budgetHeaders,
    });

    const planSteps = planResult.planSteps;

    if (!planResult.ok) {
      const planFailureCategory = planResult.failureCategory as PlanFailureCategory;
      app.metrics.incAgentPlanFailed({ runtime: "collab-runtime", category: planFailureCategory });
      await updateCollabRunStatus({ pool: app.db, tenantId: subject.tenantId, collabRunId: collab.collabRunId, status: "stopped" });
      await appendCollabRunEvent({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId ?? null,
        collabRunId: collab.collabRunId,
        taskId: params.taskId,
        type: "collab.run.stopped",
        payloadDigest: { reason: "plan_failed", category: planFailureCategory, suggestedCount: planResult.rawSuggestionCount, pickedCount: planResult.filteredSuggestionCount, toolCatalogAvailable: Boolean(planResult.toolCatalog) },
      });
      req.ctx.audit!.outputDigest = { collabRunId: collab.collabRunId, status: "stopped", reason: "plan_empty" };
      return {
        collabRunId: collab.collabRunId,
        runId: null,
        jobId: null,
        stepId: null,
        status: "stopped" as const,
        errorCode:
          planFailureCategory === "model_error"
            ? ("COLLAB_PLAN_MODEL_ERROR" as const)
            : planFailureCategory === "parse_error"
              ? ("COLLAB_PLAN_PARSE_ERROR" as const)
              : planFailureCategory === "no_tools"
                ? ("COLLAB_PLAN_NO_TOOLS" as const)
                : planFailureCategory === "no_enabled_suggestion"
                  ? ("COLLAB_PLAN_SUGGESTION_DISABLED" as const)
                  : ("COLLAB_PLAN_EMPTY" as const),
        details: { category: planFailureCategory },
      };
    }

    const roleAllowed = new Map<string, Set<string> | null>();
    for (const r of roles) {
      const rn = typeof (r as any)?.roleName === "string" ? String((r as any).roleName) : "";
      const allowed = Array.isArray((r as any)?.toolPolicy?.allowedTools) ? (r as any).toolPolicy.allowedTools.map((x: any) => String(x)) : null;
      if (rn) roleAllowed.set(rn, allowed ? new Set<string>(allowed) : null);
    }
    for (const p of planSteps) {
      const actorRole = String(p.actorRole ?? "");
      const allowed = roleAllowed.get(actorRole) ?? null;
      if (allowed && !allowed.has(String(p.toolRef))) {
        await updateCollabRunStatus({ pool: app.db, tenantId: subject.tenantId, collabRunId: collab.collabRunId, status: "stopped" });
        await appendCollabRunEvent({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId ?? null,
          collabRunId: collab.collabRunId,
          taskId: params.taskId,
          type: "collab.policy.denied",
          actorRole,
          payloadDigest: { toolRef: p.toolRef, reason: "tool_not_allowed" },
        });
        req.ctx.audit!.errorCategory = "policy_violation";
        return reply
          .status(409)
          .send({ errorCode: "COLLAB_POLICY_DENIED", message: { "zh-CN": "角色策略拒绝执行该工具", "en-US": "Role policy denied tool execution" }, collabRunId: collab.collabRunId, traceId: req.ctx.traceId });
      }
    }

    const { job, run } = await createJobRun({
      pool: app.db,
      tenantId: subject.tenantId,
      jobType: "agent.run",
      runToolRef: "agent.run@1",
      inputDigest: { taskId: params.taskId, collabRunId: collab.collabRunId, kind: "collab.run", limits: { maxSteps, maxWallTimeMs }, messageDigest: { len: body.message.length } },
      createdBySubjectId: subject.subjectId,
      trigger: "collab_runtime",
    });

    await setCollabRunPrimaryRun({ pool: app.db, tenantId: subject.tenantId, collabRunId: collab.collabRunId, primaryRunId: run.runId });

    const plan = { goal: body.message, limits, roles, steps: planSteps };
    const { taskState: taskState0, dlpSummary } = await upsertTaskState({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      runId: run.runId,
      phase: "planned",
      plan,
      artifactsDigest: { taskId: params.taskId, collabRunId: collab.collabRunId },
    });

    await appendAgentMessage({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      taskId: params.taskId,
      fromAgentId: null,
      fromRole: "collab_runtime",
      intent: "plan",
      correlation: { collabRunId: collab.collabRunId, runId: run.runId, jobId: job.jobId, dlpSummary },
      inputs: { messageDigest: { len: body.message.length }, limits: { maxSteps, maxWallTimeMs } },
      outputs: { planSummary: { steps: planSteps.map((x) => ({ actorRole: x.actorRole, toolRef: x.toolRef, approvalRequired: x.approvalRequired })) } },
    });

    const correlationId = `plan:${collab.collabRunId}`;
    const planSummary = {
      stepCount: planSteps.length,
      steps: planSteps.map((x) => ({ actorRole: x.actorRole, toolRef: x.toolRef, approvalRequired: Boolean(x.approvalRequired) })),
      approvalRequiredCount: planSteps.filter((x) => Boolean(x.approvalRequired)).length,
    };
    const planDigest = toDigestRef(digestInputV1(planSummary));

    await appendCollabRunEvent({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId ?? null,
      collabRunId: collab.collabRunId,
      taskId: params.taskId,
      type: "collab.plan.generated",
      correlationId,
      payloadDigest: { ...planSummary, roles: roles.map((r) => r.roleName), planDigest },
      runId: run.runId,
    });

    await appendCollabRunEvent({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId ?? null,
      collabRunId: collab.collabRunId,
      taskId: params.taskId,
      type: "collab.role.planner.completed",
      actorRole: "planner",
      correlationId,
      payloadDigest: { planDigest, stepCount: planSteps.length },
      runId: run.runId,
    });

    const arbiterAuto = roles.some((r) => String((r as any)?.roleName ?? "") === "arbiter" && String((r as any)?.mode ?? "") === "auto");

    const pipelineResult = await executeCollabPipeline({
      pool: app.db, queue: app.queue,
      tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId,
      collabRunId: collab.collabRunId, taskId: params.taskId,
      runId: run.runId, jobId: job.jobId,
      masterKey: app.cfg.secrets.masterKey, traceId: req.ctx.traceId,
      planSteps, roles, limits, message: body.message,
      correlationId, arbiterAuto,
      checkPermission: (p) => requirePermission({ req, ...p }),
    });

    if (!pipelineResult.ok) {
      req.ctx.audit!.outputDigest = { collabRunId: collab.collabRunId, status: "stopped", reason: "retriever_tool_disabled", toolRef: pipelineResult.retrieverToolRef };
      return {
        collabRunId: collab.collabRunId,
        runId: null,
        jobId: null,
        stepId: null,
        status: "stopped" as const,
        errorCode: "COLLAB_RETRIEVER_DISABLED" as const,
      };
    }

    const { updated, firstStepId } = pipelineResult;

    const { taskState } = await upsertTaskState({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      runId: run.runId,
      stepId: firstStepId,
      phase: "retrieving",
      plan,
      artifactsDigest: { taskId: params.taskId, collabRunId: updated.collabRunId, correlationId, collabPlan: { planDigest, stepCount: planSteps.length } },
    });

    req.ctx.audit!.outputDigest = { collabRunId: updated.collabRunId, runId: run.runId, jobId: job.jobId, stepId: firstStepId, status: "queued", correlationId, planDigest };
    return { collabRunId: updated.collabRunId, runId: run.runId, jobId: job.jobId, stepId: firstStepId, status: "queued" as const, correlationId, taskState };
  });

  app.get("/tasks/:taskId/collab-runs/:collabRunId", async (req, reply) => {
    const params = z.object({ taskId: z.string().uuid(), collabRunId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "agent_runtime", action: "collab.read" });
    const decision = await requirePermission({ req, resourceType: "agent_runtime", action: "collab.read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) return reply.status(400).send({ errorCode: "BAD_REQUEST", message: { "zh-CN": "缺少 spaceId", "en-US": "Missing spaceId" }, traceId: req.ctx.traceId });

    const task = await getTask({ pool: app.db, tenantId: subject.tenantId, taskId: params.taskId });
    if (!task) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Task 不存在", "en-US": "Task not found" }, traceId: req.ctx.traceId });
    if (task.spaceId && task.spaceId !== subject.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const collab = await getCollabRun({ pool: app.db, tenantId: subject.tenantId, collabRunId: params.collabRunId });
    if (!collab) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "CollabRun 不存在", "en-US": "CollabRun not found" }, traceId: req.ctx.traceId });
    if (String(collab.taskId) !== String(params.taskId)) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    if (collab.spaceId && collab.spaceId !== subject.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const runsRes = await app.db.query(
      `
        SELECT run_id, status, tool_ref, policy_snapshot_ref, idempotency_key, created_at, updated_at
        FROM runs
        WHERE tenant_id = $1 AND (input_digest->>'taskId') = $2 AND (input_digest->>'collabRunId') = $3
        ORDER BY created_at DESC
        LIMIT 20
      `,
      [subject.tenantId, params.taskId, collab.collabRunId],
    );
    const related = runsRes.rows.map((r: any) => ({
      runId: r.run_id,
      status: r.status,
      toolRef: r.tool_ref,
      policySnapshotRef: r.policy_snapshot_ref,
      idempotencyKey: r.idempotency_key,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
    const events = await listCollabRunEvents({ pool: app.db, tenantId: subject.tenantId, collabRunId: collab.collabRunId, limit: 20 });
    const taskState = collab.primaryRunId ? await getTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId: collab.primaryRunId }) : null;
    req.ctx.audit!.outputDigest = { collabRunId: collab.collabRunId, status: collab.status, eventCount: events.length, runCount: related.length, phase: taskState?.phase ?? null };
    return { collabRun: collab, runs: related, latestEvents: events, taskState };
  });

  app.post("/tasks/:taskId/collab-runs/:collabRunId/envelopes", async (req, reply) => {
    const params = z.object({ taskId: z.string().uuid(), collabRunId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "agent_runtime", action: "collab.envelopes.write" });
    const decision = await requirePermission({ req, resourceType: "agent_runtime", action: "collab.envelopes.write" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) return reply.status(400).send({ errorCode: "BAD_REQUEST", message: { "zh-CN": "缺少 spaceId", "en-US": "Missing spaceId" }, traceId: req.ctx.traceId });

    const task = await getTask({ pool: app.db, tenantId: subject.tenantId, taskId: params.taskId });
    if (!task) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Task 不存在", "en-US": "Task not found" }, traceId: req.ctx.traceId });
    if (task.spaceId && task.spaceId !== subject.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const collab = await getCollabRun({ pool: app.db, tenantId: subject.tenantId, collabRunId: params.collabRunId });
    if (!collab) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "CollabRun 不存在", "en-US": "CollabRun not found" }, traceId: req.ctx.traceId });
    if (String(collab.taskId) !== String(params.taskId)) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    if (collab.spaceId && collab.spaceId !== subject.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const body = z
      .object({
        fromRole: z.string().min(1).max(50),
        toRole: z.string().min(1).max(50).optional(),
        broadcast: z.boolean().optional(),
        kind: z.enum(["proposal", "question", "answer", "observation", "command"]),
        correlationId: z.string().min(1).max(200),
        payloadRedacted: z.any().optional(),
      })
      .parse(req.body);

    const redacted = redactValue(body.payloadRedacted ?? null, { maxDepth: 8, maxStringLen: 20_000 });
    const payloadDigest = toDigestRef(digestInputV1(redacted.value));
    const env = await appendCollabEnvelope({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId ?? null,
      collabRunId: collab.collabRunId,
      taskId: params.taskId,
      fromRole: body.fromRole,
      toRole: body.toRole ?? null,
      broadcast: body.broadcast ?? false,
      kind: body.kind,
      correlationId: body.correlationId,
      policySnapshotRef: decision.snapshotRef ?? null,
      payloadDigest,
      payloadRedacted: null,
    });

    await appendCollabRunEvent({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId ?? null,
      collabRunId: collab.collabRunId,
      taskId: params.taskId,
      type: "collab.envelope.sent",
      actorRole: body.fromRole,
      policySnapshotRef: decision.snapshotRef ?? null,
      correlationId: body.correlationId,
      payloadDigest: { envelopeId: env.envelopeId, toRole: body.toRole ?? null, broadcast: body.broadcast ?? false, kind: body.kind, correlationId: body.correlationId, payloadDigest, dlpSummary: redacted.summary },
    });

    req.ctx.audit!.outputDigest = { collabRunId: collab.collabRunId, envelopeId: env.envelopeId, fromRole: body.fromRole, toRole: body.toRole ?? null, kind: body.kind, payloadDigest };
    return { envelope: toSafeEnvelope(env) };
  });

  app.get("/tasks/:taskId/collab-runs/:collabRunId/envelopes", async (req, reply) => {
    const params = z.object({ taskId: z.string().uuid(), collabRunId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "agent_runtime", action: "collab.envelopes.read" });
    const decision = await requirePermission({ req, resourceType: "agent_runtime", action: "collab.envelopes.read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) return reply.status(400).send({ errorCode: "BAD_REQUEST", message: { "zh-CN": "缺少 spaceId", "en-US": "Missing spaceId" }, traceId: req.ctx.traceId });

    const task = await getTask({ pool: app.db, tenantId: subject.tenantId, taskId: params.taskId });
    if (!task) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Task 不存在", "en-US": "Task not found" }, traceId: req.ctx.traceId });
    if (task.spaceId && task.spaceId !== subject.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const collab = await getCollabRun({ pool: app.db, tenantId: subject.tenantId, collabRunId: params.collabRunId });
    if (!collab) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "CollabRun 不存在", "en-US": "CollabRun not found" }, traceId: req.ctx.traceId });
    if (String(collab.taskId) !== String(params.taskId)) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    if (collab.spaceId && collab.spaceId !== subject.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const q = req.query as any;
    const limit = z.coerce.number().int().positive().max(200).optional().parse(q?.limit) ?? 50;
    const before = z.string().min(1).max(50).optional().parse(q?.before) ?? null;
    const fromRole = z.string().min(1).max(50).optional().parse(q?.fromRole) ?? null;
    const toRole = z.string().min(1).max(50).optional().parse(q?.toRole) ?? null;
    const kind = z.string().min(1).max(50).optional().parse(q?.kind) ?? null;
    const correlationId = z.string().min(1).max(200).optional().parse(q?.correlationId) ?? null;
    const items0 = await listCollabEnvelopes({ pool: app.db, tenantId: subject.tenantId, collabRunId: collab.collabRunId, limit, before, fromRole, toRole, kind, correlationId });
    const items = items0.map(toSafeEnvelope);
    const nextBefore = items.length ? items[items.length - 1]!.createdAt : null;
    req.ctx.audit!.outputDigest = { collabRunId: collab.collabRunId, count: items.length };
    return { items, nextBefore };
  });

  app.get("/tasks/:taskId/collab-runs/:collabRunId/protocol", async (req, reply) => {
    const params = z.object({ taskId: z.string().uuid(), collabRunId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "agent_runtime", action: "collab.read" });
    const decision = await requirePermission({ req, resourceType: "agent_runtime", action: "collab.read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) return reply.status(400).send({ errorCode: "BAD_REQUEST", message: { "zh-CN": "缺少 spaceId", "en-US": "Missing spaceId" }, traceId: req.ctx.traceId });

    const task = await getTask({ pool: app.db, tenantId: subject.tenantId, taskId: params.taskId });
    if (!task) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Task 不存在", "en-US": "Task not found" }, traceId: req.ctx.traceId });
    if (task.spaceId && task.spaceId !== subject.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const collab = await getCollabRun({ pool: app.db, tenantId: subject.tenantId, collabRunId: params.collabRunId });
    if (!collab) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "CollabRun 不存在", "en-US": "CollabRun not found" }, traceId: req.ctx.traceId });
    if (String(collab.taskId) !== String(params.taskId)) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    if (collab.spaceId && collab.spaceId !== subject.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const roles = await listAgentRoles({ pool: app.db, tenantId: subject.tenantId, collabRunId: collab.collabRunId });
    const assignments = await listTaskAssignments({ pool: app.db, tenantId: subject.tenantId, collabRunId: collab.collabRunId, status: null, limit: 200 });
    const permissionContexts = await listPermissionContexts({ pool: app.db, tenantId: subject.tenantId, collabRunId: collab.collabRunId });
    req.ctx.audit!.outputDigest = { collabRunId: collab.collabRunId, roleCount: roles.length, assignmentCount: assignments.length, permissionContextCount: permissionContexts.length };
    return { roles, assignments, permissionContexts };
  });

  app.post("/tasks/:taskId/collab-runs/:collabRunId/arbiter/commit", async (req, reply) => {
    const params = z.object({ taskId: z.string().uuid(), collabRunId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "agent_runtime", action: "collab.arbiter.commit" });
    const decision = await requirePermission({ req, resourceType: "agent_runtime", action: "collab.arbiter.commit" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) return reply.status(400).send({ errorCode: "BAD_REQUEST", message: { "zh-CN": "缺少 spaceId", "en-US": "Missing spaceId" }, traceId: req.ctx.traceId });

    const task = await getTask({ pool: app.db, tenantId: subject.tenantId, taskId: params.taskId });
    if (!task) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Task 不存在", "en-US": "Task not found" }, traceId: req.ctx.traceId });
    if (task.spaceId && task.spaceId !== subject.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const collab = await getCollabRun({ pool: app.db, tenantId: subject.tenantId, collabRunId: params.collabRunId });
    if (!collab) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "CollabRun 不存在", "en-US": "CollabRun not found" }, traceId: req.ctx.traceId });
    if (String(collab.taskId) !== String(params.taskId)) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    if (collab.spaceId && collab.spaceId !== subject.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const body = z
      .object({
        actorRole: z.string().min(1).max(50),
        status: z.enum(["planning", "executing", "needs_approval", "succeeded", "failed", "canceled", "stopped"]).optional(),
        correlationId: z.string().min(1).max(200).optional(),
        decisionRedacted: z.any().optional(),
        outputSummaryRedacted: z.any().optional(),
      })
      .parse(req.body);

    if (!body.correlationId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply
        .status(400)
        .send({ errorCode: "BAD_REQUEST", message: { "zh-CN": "缺少 correlationId", "en-US": "Missing correlationId" }, traceId: req.ctx.traceId });
    }
    const correlationId = body.correlationId;

    if (body.actorRole !== "arbiter") {
      const runId = collab.primaryRunId ?? null;
      await appendCollabRunEvent({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId ?? null,
        collabRunId: collab.collabRunId,
        taskId: params.taskId,
        type: "collab.single_writer.violation",
        actorRole: body.actorRole,
        runId,
        policySnapshotRef: decision.snapshotRef ?? null,
        correlationId,
        payloadDigest: { reason: "non_arbiter_commit" },
      });
      req.ctx.audit!.outputDigest = {
        errorCode: "SINGLE_WRITER_VIOLATION",
        collabRunId: collab.collabRunId,
        taskId: params.taskId,
        runId,
        correlationId,
        violation: { reason: "non_arbiter_commit", actorRole: body.actorRole },
      };
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply
        .status(409)
        .send({
          errorCode: "SINGLE_WRITER_VIOLATION",
          message: { "zh-CN": "仅 Arbiter 允许提交协作决议", "en-US": "Only arbiter can commit collab decision" },
          details: { violation: { reason: "non_arbiter_commit", actorRole: body.actorRole } },
          traceId: req.ctx.traceId,
        });
    }

    const roles = Array.isArray(collab.roles) ? (collab.roles as any[]) : [];
    if (roles.length && !roles.some((r) => String(r?.roleName ?? "") === "arbiter")) {
      const runId = collab.primaryRunId ?? null;
      await appendCollabRunEvent({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId ?? null,
        collabRunId: collab.collabRunId,
        taskId: params.taskId,
        type: "collab.single_writer.violation",
        actorRole: "arbiter",
        runId,
        policySnapshotRef: decision.snapshotRef ?? null,
        correlationId,
        payloadDigest: { reason: "arbiter_not_configured" },
      });
      req.ctx.audit!.outputDigest = {
        errorCode: "SINGLE_WRITER_VIOLATION",
        collabRunId: collab.collabRunId,
        taskId: params.taskId,
        runId,
        correlationId,
        violation: { reason: "arbiter_not_configured" },
      };
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply
        .status(409)
        .send({
          errorCode: "SINGLE_WRITER_VIOLATION",
          message: { "zh-CN": "该协作运行未配置 arbiter 角色", "en-US": "Arbiter role not configured for this collab run" },
          details: { violation: { reason: "arbiter_not_configured" } },
          traceId: req.ctx.traceId,
        });
    }

    const resourceRef = `collab_step:${collab.collabRunId}:${correlationId}`;
    const lease = await acquireWriteLease({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      resourceRef,
      owner: { runId: collab.collabRunId, stepId: correlationId, traceId: req.ctx.traceId },
      ttlMs: 30_000,
    });
    if (!lease.acquired) {
      const runId = collab.primaryRunId ?? null;
      await appendCollabRunEvent({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId ?? null,
        collabRunId: collab.collabRunId,
        taskId: params.taskId,
        type: "collab.single_writer.violation",
        actorRole: "arbiter",
        runId,
        policySnapshotRef: decision.snapshotRef ?? null,
        correlationId,
        payloadDigest: { reason: "lease_conflict", resourceRef, currentOwner: lease.currentOwner, expiresAt: lease.expiresAt },
      });
      req.ctx.audit!.outputDigest = {
        errorCode: "SINGLE_WRITER_VIOLATION",
        collabRunId: collab.collabRunId,
        taskId: params.taskId,
        runId,
        correlationId,
        violation: { reason: "lease_conflict", resourceRef, currentOwner: lease.currentOwner, expiresAt: lease.expiresAt },
      };
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply
        .status(409)
        .send({
          errorCode: "SINGLE_WRITER_VIOLATION",
          message: { "zh-CN": "该协作步骤已被其他写入者占用", "en-US": "This collab step is owned by another writer" },
          details: { violation: { reason: "lease_conflict", resourceRef, currentOwner: lease.currentOwner, expiresAt: lease.expiresAt } },
          traceId: req.ctx.traceId,
        });
    }

    const decisionVal = redactValue(body.decisionRedacted ?? null, { maxDepth: 8, maxStringLen: 20_000 });
    const outputVal = redactValue(body.outputSummaryRedacted ?? null, { maxDepth: 8, maxStringLen: 20_000 });
    const decisionDigest = toDigestRef(digestInputV1(decisionVal.value));
    const outputDigest = toDigestRef(digestInputV1(outputVal.value));

    const updated = body.status ? await updateCollabRunStatus({ pool: app.db, tenantId: subject.tenantId, collabRunId: collab.collabRunId, status: body.status }) : collab;
    if (!updated) throw Errors.internal();
    await updateAgentRoleStatus({ pool: app.db, tenantId: subject.tenantId, collabRunId: collab.collabRunId, roleName: "arbiter", status: "committed" });
    await appendCollabRunEvent({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId ?? null,
      collabRunId: collab.collabRunId,
      taskId: params.taskId,
      type: "collab.arbiter.decision",
      actorRole: "arbiter",
      runId: updated.primaryRunId ?? null,
      policySnapshotRef: decision.snapshotRef ?? null,
      correlationId,
      payloadDigest: { status: body.status ?? null, decisionDigest, outputDigest, dlpSummary: { decision: decisionVal.summary, output: outputVal.summary } },
    });

    let arbiterAssignment = (await listTaskAssignments({ pool: app.db, tenantId: subject.tenantId, collabRunId: collab.collabRunId, status: null, limit: 200 })).find(
      (a) => String((a as any)?.inputDigest?.planStepId ?? "") === "role.arbiter",
    );
    if (!arbiterAssignment) {
      arbiterAssignment = await createTaskAssignment({
        pool: app.db,
        tenantId: subject.tenantId,
        collabRunId: collab.collabRunId,
        taskId: params.taskId,
        assignedRole: "arbiter",
        assignedBy: subject.subjectId,
        priority: 10,
        inputDigest: { kind: "arbiter_decision", planStepId: "role.arbiter", correlationId },
      });
    }
    await updateTaskAssignmentStatus({
      pool: app.db,
      tenantId: subject.tenantId,
      assignmentId: arbiterAssignment.assignmentId,
      status: "succeeded",
      outputDigest: { correlationId, decisionDigest, outputDigest, status: body.status ?? null },
    });

    if (updated.primaryRunId) {
      const prev = await getTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId: updated.primaryRunId });
      const nextArtifacts = { ...(prev?.artifactsDigest ?? {}), collabRunId: collab.collabRunId, arbiter: { correlationId, decision: decisionVal.value, outputSummary: outputVal.value } };
      await upsertTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId: updated.primaryRunId, phase: "arbiter.committed", plan: prev?.plan ?? null, artifactsDigest: nextArtifacts });
    }

    const terminal = body.status ? ["succeeded", "failed", "canceled", "stopped"].includes(body.status) : false;
    const startRequested = !body.status || body.status === "executing";

    if (!terminal && startRequested) {
      if (!updated.primaryRunId) throw Errors.badRequest("缺少 primaryRunId");
      const jobRes = await app.db.query("SELECT job_id FROM jobs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1", [subject.tenantId, updated.primaryRunId]);
      const jobId = jobRes.rowCount ? String(jobRes.rows[0]!.job_id) : null;
      if (!jobId) throw Errors.internal();

      const succeededRes = await app.db.query("SELECT (input->>'planStepId') AS plan_step_id FROM steps WHERE run_id = $1 AND status = 'succeeded'", [updated.primaryRunId]);
      const succeededPlanStepIds = new Set<string>(succeededRes.rows.map((r: any) => String(r.plan_step_id ?? "")).filter(Boolean));
      const pendingRes = await app.db.query(
        "SELECT step_id, queue_job_id, tool_ref, input, policy_snapshot_ref, input_digest FROM steps WHERE run_id = $1 AND status = 'pending' AND (queue_job_id IS NULL OR queue_job_id = '') ORDER BY seq ASC LIMIT 50",
        [updated.primaryRunId],
      );
      const pending = pendingRes.rows as any[];
      const pick = pending.find((r) => {
        const deps = Array.isArray(r?.input?.dependsOn) ? (r.input.dependsOn as any[]) : [];
        return deps.every((d) => succeededPlanStepIds.has(String(d)));
      });
      if (!pick) {
        req.ctx.audit!.outputDigest = { collabRunId: collab.collabRunId, status: updated.status, correlationId, decisionDigest, outputDigest, resume: "no_ready_step" };
        return { ok: true, collabRun: updated };
      }

      const stepId = String(pick.step_id);
      const queueJobId = pick.queue_job_id ? String(pick.queue_job_id) : null;
      const stepToolRef = pick.tool_ref ? String(pick.tool_ref) : null;
      const stepInput = pick.input ?? null;
      const stepPolicySnapshotRef = pick.policy_snapshot_ref ? String(pick.policy_snapshot_ref) : null;
      const stepInputDigest = pick.input_digest ?? null;

      if (!queueJobId) {
        const approvalRequired = Boolean(stepInput?.toolContract?.approvalRequired) || stepInput?.toolContract?.riskLevel === "high";
        if (approvalRequired) {
          await setRunAndJobStatus({ pool: app.db, tenantId: subject.tenantId, runId: updated.primaryRunId, jobId, runStatus: "needs_approval", jobStatus: "needs_approval" });
          const approval = await createApproval({
            pool: app.db,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId,
            runId: updated.primaryRunId,
            stepId,
            requestedBySubjectId: subject.subjectId,
            toolRef: stepToolRef,
            policySnapshotRef: stepPolicySnapshotRef ?? null,
            inputDigest: stepInputDigest ?? null,
          });
          await updateCollabRunStatus({ pool: app.db, tenantId: subject.tenantId, collabRunId: collab.collabRunId, status: "needs_approval" });
          await appendCollabRunEvent({
            pool: app.db,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId ?? null,
            collabRunId: collab.collabRunId,
            taskId: params.taskId,
            type: "collab.run.needs_approval",
            actorRole: stepInput?.actorRole ? String(stepInput.actorRole) : null,
            runId: updated.primaryRunId,
            stepId,
            policySnapshotRef: decision.snapshotRef ?? null,
            correlationId,
            payloadDigest: { approvalId: approval.approvalId, toolRef: stepToolRef },
          });
          const prev = await getTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId: updated.primaryRunId });
          await upsertTaskState({
            pool: app.db,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId,
            runId: updated.primaryRunId,
            stepId,
            phase: "needs_approval",
            plan: prev?.plan ?? null,
            artifactsDigest: { ...(prev?.artifactsDigest ?? {}), collabRunId: collab.collabRunId, approvalId: approval.approvalId },
          });
          req.ctx.audit!.outputDigest = { collabRunId: collab.collabRunId, status: "needs_approval", correlationId, decisionDigest, outputDigest, runId: updated.primaryRunId, jobId, stepId, approvalId: approval.approvalId };
          return { ok: true, collabRun: { ...updated, status: "needs_approval" }, approvalId: approval.approvalId };
        }

        await updateCollabRunStatus({ pool: app.db, tenantId: subject.tenantId, collabRunId: collab.collabRunId, status: "executing" });
        await setRunAndJobStatus({ pool: app.db, tenantId: subject.tenantId, runId: updated.primaryRunId, jobId, runStatus: "queued", jobStatus: "queued" });
        await enqueueWorkflowStep({ queue: app.queue, pool: app.db, jobId, runId: updated.primaryRunId, stepId });
        await appendCollabRunEvent({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId ?? null,
          collabRunId: collab.collabRunId,
          taskId: params.taskId,
          type: "collab.run.queued",
          actorRole: stepInput?.actorRole ? String(stepInput.actorRole) : null,
          runId: updated.primaryRunId,
          stepId,
          policySnapshotRef: decision.snapshotRef ?? null,
          correlationId,
          payloadDigest: { toolRef: stepToolRef },
        });
        const prev = await getTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId: updated.primaryRunId });
        await upsertTaskState({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId,
          runId: updated.primaryRunId,
          stepId,
          phase: "queued",
          plan: prev?.plan ?? null,
          artifactsDigest: { ...(prev?.artifactsDigest ?? {}), collabRunId: collab.collabRunId, queued: { jobId, stepId } },
        });
        req.ctx.audit!.outputDigest = { collabRunId: collab.collabRunId, status: "queued", correlationId, decisionDigest, outputDigest, runId: updated.primaryRunId, jobId, stepId };
        return { ok: true, collabRun: { ...updated, status: "executing" }, queued: { jobId, runId: updated.primaryRunId, stepId } };
      }
    }

    req.ctx.audit!.outputDigest = { collabRunId: collab.collabRunId, status: updated.status, correlationId, decisionDigest, outputDigest };
    return { ok: true, collabRun: updated };
  });

  app.get("/tasks/:taskId/collab-runs/:collabRunId/events", async (req, reply) => {
    const params = z.object({ taskId: z.string().uuid(), collabRunId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "agent_runtime", action: "collab.events" });
    const decision = await requirePermission({ req, resourceType: "agent_runtime", action: "collab.events" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) return reply.status(400).send({ errorCode: "BAD_REQUEST", message: { "zh-CN": "缺少 spaceId", "en-US": "Missing spaceId" }, traceId: req.ctx.traceId });

    const task = await getTask({ pool: app.db, tenantId: subject.tenantId, taskId: params.taskId });
    if (!task) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Task 不存在", "en-US": "Task not found" }, traceId: req.ctx.traceId });
    if (task.spaceId && task.spaceId !== subject.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const collab = await getCollabRun({ pool: app.db, tenantId: subject.tenantId, collabRunId: params.collabRunId });
    if (!collab) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "CollabRun 不存在", "en-US": "CollabRun not found" }, traceId: req.ctx.traceId });
    if (String(collab.taskId) !== String(params.taskId)) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    if (collab.spaceId && collab.spaceId !== subject.spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const q = req.query as any;
    const limit = z.coerce.number().int().positive().max(200).optional().parse(q?.limit) ?? 50;
    const before = z.string().min(1).max(50).optional().parse(q?.before) ?? null;
    const type = z.string().min(1).max(100).optional().parse(q?.type) ?? null;
    const actorRole = z.string().min(1).max(50).optional().parse(q?.actorRole) ?? null;
    const correlationId = z.string().min(1).max(200).optional().parse(q?.correlationId) ?? null;
    const events = await listCollabRunEvents({ pool: app.db, tenantId: subject.tenantId, collabRunId: collab.collabRunId, limit, before, type, actorRole, correlationId });
    const nextBefore = events.length ? events[events.length - 1]!.createdAt : null;
    req.ctx.audit!.outputDigest = { collabRunId: collab.collabRunId, count: events.length };
    return { items: events, nextBefore };
  });
};
