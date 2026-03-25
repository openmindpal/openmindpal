import type { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";
import type { CapabilityEnvelopeV1 } from "@openslin/shared";
import { normalizeNetworkPolicyV1, normalizeRuntimeLimitsV1, redactValue } from "@openslin/shared";
import { Errors } from "../lib/errors";
import { setAuditContext } from "../modules/audit/context";
import { requirePermission, requireSubject } from "../modules/auth/guard";
import { createCollabRun, getCollabRun, setCollabRunPrimaryRun, updateCollabRunStatus } from "../modules/agentRuntime/collabRepo";
import { appendCollabRunEvent, listCollabRunEvents } from "../modules/agentRuntime/collabEventRepo";
import { appendCollabEnvelope, listCollabEnvelopes } from "../modules/agentRuntime/collabEnvelopeRepo";
import { orchestrateTurn } from "../modules/orchestrator/orchestrator";
import { getToolDefinition, getToolVersionByRef } from "../modules/tools/toolRepo";
import { resolveEffectiveToolRef } from "../modules/tools/resolve";
import { isToolEnabled } from "../modules/governance/toolGovernanceRepo";
import { getEffectiveToolNetworkPolicy } from "../modules/governance/toolNetworkPolicyRepo";
import { getTask } from "../modules/tasks/taskRepo";
import { appendAgentMessage } from "../modules/tasks/agentMessageRepo";
import { getTaskState, upsertTaskState } from "../modules/memory/repo";
import { createApproval } from "../modules/workflow/approvalRepo";
import { appendStepToRun, createJobRun } from "../modules/workflow/jobRepo";
import { acquireWriteLease } from "../modules/workflow/writeLease";
import { digestInputV1 } from "../modules/notifications/digest";

function isPlainObject(v: any): v is Record<string, any> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function toSafeEnvelope(env: any) {
  if (!env || typeof env !== "object") return env;
  return { ...(env as any), payloadRedacted: null };
}

function toDigestRef(d: any) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return d;
  return { sha256_8: (d as any).sha256_8 ?? null, keyCount: (d as any).keyCount ?? null };
}

export const collabRuntimeRoutes: FastifyPluginAsync = async (app) => {
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
    const limits = { maxSteps, maxWallTimeMs, maxTokens: body.limits?.maxTokens, maxCostUsd: body.limits?.maxCostUsd };

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

    const out = await orchestrateTurn({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? undefined, message: body.message });
    const suggestions = Array.isArray((out as any).toolSuggestions) ? ((out as any).toolSuggestions as any[]) : [];
    const picked = suggestions.slice(0, Math.max(0, maxSteps));

    const planSteps: any[] = [];
    for (const s of picked) {
      const rawToolRef = typeof s?.toolRef === "string" ? String(s.toolRef) : "";
      if (!rawToolRef) continue;
      const at = rawToolRef.lastIndexOf("@");
      const toolName = at > 0 ? rawToolRef.slice(0, at) : rawToolRef;
      const effToolRef = at > 0 ? rawToolRef : await resolveEffectiveToolRef({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, name: toolName });
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

    if (planSteps.length) {
      planSteps[0].actorRole = "planner";
      if (planSteps.length > 1) planSteps[planSteps.length - 1].actorRole = "reviewer";
    }

    if (!planSteps.length) {
      await updateCollabRunStatus({ pool: app.db, tenantId: subject.tenantId, collabRunId: collab.collabRunId, status: "stopped" });
      await appendCollabRunEvent({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId ?? null,
        collabRunId: collab.collabRunId,
        taskId: params.taskId,
        type: "collab.run.stopped",
        payloadDigest: { reason: "plan_empty" },
      });
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply.status(409).send({ errorCode: "COLLAB_PLAN_EMPTY", message: { "zh-CN": "未找到可执行的计划步骤（工具可能未启用）", "en-US": "No executable plan step found (tool may be disabled)" }, traceId: req.ctx.traceId });
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

    await appendCollabRunEvent({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId ?? null,
      collabRunId: collab.collabRunId,
      taskId: params.taskId,
      type: "collab.plan.generated",
      payloadDigest: { stepCount: planSteps.length, roles: roles.map((r) => r.roleName) },
      runId: run.runId,
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
      const idempotencyKey = scope === "write" && idempotencyRequired ? `idem-collab-${run.runId}-${i + 1}` : null;
      const effPol = await getEffectiveToolNetworkPolicy({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? undefined, toolRef });
      const effAllowedDomains = effPol?.allowedDomains ?? [];
      const effRules = (effPol as any)?.rules ?? [];
      const effNetworkPolicy = Array.isArray(effRules) && effRules.length ? { allowedDomains: effAllowedDomains, rules: effRules } : { allowedDomains: effAllowedDomains };
      const limitsStep = {};
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
        resourceDomain: { limits: normalizeRuntimeLimitsV1(limitsStep) },
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
          collabRunId: collab.collabRunId,
          taskId: params.taskId,
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

    const first = createdSteps[0];
    const stepRow = await app.db.query("SELECT tool_ref, input, policy_snapshot_ref, input_digest FROM steps WHERE step_id = $1 LIMIT 1", [first.stepId]);
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
        stepId: first.stepId,
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
        stepId: first.stepId,
        phase: "needs_approval",
        plan,
        artifactsDigest: { taskId: params.taskId, collabRunId: collab.collabRunId, approvalId: approval.approvalId },
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
        runId: run.runId,
        stepId: first.stepId,
        payloadDigest: { approvalId: approval.approvalId, toolRef: stepToolRef },
      });
      req.ctx.audit!.outputDigest = { collabRunId: collab.collabRunId, runId: run.runId, jobId: job.jobId, stepId: first.stepId, status: "needs_approval" };
      return { collabRunId: collab.collabRunId, runId: run.runId, jobId: job.jobId, stepId: first.stepId, approvalId: approval.approvalId, status: "needs_approval" as const, taskState: taskState1 };
    }

    await updateCollabRunStatus({ pool: app.db, tenantId: subject.tenantId, collabRunId: collab.collabRunId, status: "executing" });
    await app.db.query("UPDATE runs SET status = 'queued', updated_at = now() WHERE tenant_id = $1 AND run_id = $2", [subject.tenantId, run.runId]);
    await app.db.query("UPDATE jobs SET status = 'queued', updated_at = now() WHERE tenant_id = $1 AND job_id = $2", [subject.tenantId, job.jobId]);
    const bj = await app.queue.add("step", { jobId: job.jobId, runId: run.runId, stepId: first.stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });
    await app.db.query("UPDATE steps SET queue_job_id = $1, updated_at = now() WHERE step_id = $2", [String((bj as any).id), first.stepId]);
    req.ctx.audit!.outputDigest = { collabRunId: collab.collabRunId, runId: run.runId, jobId: job.jobId, stepId: first.stepId, status: "queued" };
    return { collabRunId: collab.collabRunId, runId: run.runId, jobId: job.jobId, stepId: first.stepId, status: "queued" as const, taskState: taskState0 };
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
    req.ctx.audit!.outputDigest = { collabRunId: collab.collabRunId, status: collab.status, eventCount: events.length, runCount: related.length };
    return { collabRun: collab, runs: related, latestEvents: events };
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
        .send({ errorCode: "SINGLE_WRITER_VIOLATION", message: { "zh-CN": "仅 Arbiter 允许提交协作决议", "en-US": "Only arbiter can commit collab decision" }, traceId: req.ctx.traceId });
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
        .send({ errorCode: "SINGLE_WRITER_VIOLATION", message: { "zh-CN": "该协作运行未配置 arbiter 角色", "en-US": "Arbiter role not configured for this collab run" }, traceId: req.ctx.traceId });
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
          traceId: req.ctx.traceId,
        });
    }

    const decisionVal = redactValue(body.decisionRedacted ?? null, { maxDepth: 8, maxStringLen: 20_000 });
    const outputVal = redactValue(body.outputSummaryRedacted ?? null, { maxDepth: 8, maxStringLen: 20_000 });
    const decisionDigest = toDigestRef(digestInputV1(decisionVal.value));
    const outputDigest = toDigestRef(digestInputV1(outputVal.value));

    const updated = body.status ? await updateCollabRunStatus({ pool: app.db, tenantId: subject.tenantId, collabRunId: collab.collabRunId, status: body.status }) : collab;
    if (!updated) throw Errors.internal();
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

    if (updated.primaryRunId) {
      const prev = await getTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId: updated.primaryRunId });
      const nextArtifacts = { ...(prev?.artifactsDigest ?? {}), collabRunId: collab.collabRunId, arbiter: { correlationId, decision: decisionVal.value, outputSummary: outputVal.value } };
      await upsertTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId: updated.primaryRunId, phase: "arbiter.committed", plan: prev?.plan ?? null, artifactsDigest: nextArtifacts });
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
