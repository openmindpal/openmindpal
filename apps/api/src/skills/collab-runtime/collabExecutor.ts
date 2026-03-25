/**
 * Collab Runtime Executor
 *
 * Extracted from collab-runtime/routes.ts POST endpoint.
 * Encapsulates the execution pipeline:
 *   resolve special tools → create assignments → topological sort →
 *   create steps via execution kernel → permission contexts → enqueue.
 *
 * The route handler remains responsible for HTTP parsing, planning,
 * job/run creation, audit output, and response shaping.
 */
import type { Pool } from "pg";
import type { Queue } from "bullmq";
import { Errors } from "../../lib/errors";
import { resolveEffectiveToolRef } from "../../modules/tools/resolve";
import { isToolEnabled } from "../../modules/governance/toolGovernanceRepo";
import { resolveAndValidateTool, admitAndBuildStepEnvelope, buildStepInputPayload, generateIdempotencyKey } from "../../kernel/executionKernel";
import { appendStepToRun } from "../../modules/workflow/jobRepo";
import { enqueueWorkflowStep, setRunAndJobStatus } from "../../modules/workflow/queue";
import { updateCollabRunStatus } from "./modules/collabRepo";
import { appendCollabRunEvent } from "./modules/collabEventRepo";
import { createTaskAssignment, upsertPermissionContext, listTaskAssignments } from "./modules/collabProtocolRepo";
import type { PlanStep } from "../../kernel/planningKernel";

/* ================================================================== */
/*  Types                                                              */
/* ================================================================== */

export interface CollabRole {
  roleName: string;
  mode?: string;
  toolPolicy?: { allowedTools?: string[] } | null;
  budget?: any;
}

export interface CollabExecutionParams {
  pool: Pool;
  queue: Queue;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  collabRunId: string;
  taskId: string;
  runId: string;
  jobId: string;
  masterKey: string;
  traceId: string;
  planSteps: PlanStep[];
  roles: CollabRole[];
  limits: any;
  message: string;
  correlationId: string;
  arbiterAuto: boolean;
  /** Wraps req-level permission check — returns opDecision-like object. */
  checkPermission: (params: { resourceType: string; action: string }) => Promise<{
    snapshotRef?: string;
    fieldRules?: any;
    rowFilters?: any;
    [k: string]: any;
  }>;
}

export type CollabPipelineResult =
  | {
      ok: true;
      retrieverToolRef: string;
      createdSteps: any[];
      firstStepId: string;
      updated: any;
    }
  | {
      ok: false;
      reason: "retriever_disabled";
      retrieverToolRef: string;
    };

/* ================================================================== */
/*  Internal: topological sort                                         */
/* ================================================================== */

interface StepNode {
  planStepId: string;
  actorRole: string;
  stepKind: string;
  toolRef: string;
  dependsOn: string[];
}

function topologicalSort(steps: StepNode[]): StepNode[] {
  const nodes = new Map<string, { step: StepNode; in: number; outs: Set<string> }>();
  for (const s of steps) nodes.set(s.planStepId, { step: s, in: 0, outs: new Set<string>() });
  for (const s of steps) {
    for (const d of s.dependsOn) {
      const dep = nodes.get(d);
      const cur = nodes.get(s.planStepId);
      if (!dep || !cur) continue;
      dep.outs.add(s.planStepId);
      cur.in += 1;
    }
  }
  const queue: string[] = Array.from(nodes.entries())
    .filter(([, v]) => v.in === 0)
    .map(([k]) => k)
    .sort();
  const ordered: StepNode[] = [];
  while (queue.length) {
    const id = queue.shift() as string;
    const n = nodes.get(id);
    if (!n) continue;
    ordered.push(n.step);
    for (const out of Array.from(n.outs).sort()) {
      const target = nodes.get(out);
      if (!target) continue;
      target.in -= 1;
      if (target.in === 0) queue.push(out);
    }
    queue.sort();
  }
  if (ordered.length !== steps.length) throw Errors.badRequest("协作任务分派存在循环依赖");
  return ordered;
}

/* ================================================================== */
/*  Main executor                                                      */
/* ================================================================== */

/**
 * Execute the full collab pipeline:
 *   1. Resolve retriever / guard / review tool refs
 *   2. Check retriever is enabled
 *   3. Create task assignments (idempotent — skips if already exist)
 *   4. Build execution pipeline via topological sort
 *   5. Create steps via execution kernel (resolve + admit + append)
 *   6. Build per-role permission contexts
 *   7. Set run/job status → "queued", collab status → "executing"
 *   8. Enqueue the first step
 */
export async function executeCollabPipeline(params: CollabExecutionParams): Promise<CollabPipelineResult> {
  const {
    pool, queue, tenantId, spaceId, subjectId,
    collabRunId, taskId, runId, jobId,
    masterKey, traceId,
    planSteps, roles, limits, message, correlationId, arbiterAuto,
    checkPermission,
  } = params;

  /* ── 1. Resolve special tool refs ── */
  const retrieverToolRef = await resolveEffectiveToolRef({ pool, tenantId, spaceId, name: "knowledge.search" });
  if (!retrieverToolRef) throw Errors.badRequest("缺少 knowledge.search 工具版本");

  const retrieverEnabled = await isToolEnabled({ pool, tenantId, spaceId, toolRef: retrieverToolRef });
  if (!retrieverEnabled) {
    await updateCollabRunStatus({ pool, tenantId, collabRunId, status: "stopped" });
    await appendCollabRunEvent({
      pool, tenantId, spaceId, collabRunId, taskId,
      type: "collab.run.stopped",
      payloadDigest: { reason: "retriever_tool_disabled", toolRef: retrieverToolRef },
    });
    return { ok: false, reason: "retriever_disabled", retrieverToolRef };
  }

  const guardToolRef = (await resolveEffectiveToolRef({ pool, tenantId, spaceId, name: "collab.guard" })) ?? "collab.guard@1";
  const reviewToolRef = (await resolveEffectiveToolRef({ pool, tenantId, spaceId, name: "collab.review" })) ?? "collab.review@1";

  /* ── 2. Create task assignments (if none exist) ── */
  const existingAssignments = await listTaskAssignments({ pool, tenantId, collabRunId, status: null, limit: 200 });
  const hasAssignments = existingAssignments.length > 0;

  if (!hasAssignments) {
    await createTaskAssignment({ pool, tenantId, collabRunId, taskId, assignedRole: "retriever", assignedBy: subjectId, priority: 100,
      inputDigest: { kind: "collab_step", planStepId: "role.retriever", stepKind: "retriever", toolRef: retrieverToolRef, dependsOn: [] } });
    await createTaskAssignment({ pool, tenantId, collabRunId, taskId, assignedRole: "guard", assignedBy: subjectId, priority: 90,
      inputDigest: { kind: "collab_step", planStepId: "role.guard", stepKind: "guard", toolRef: guardToolRef, dependsOn: ["role.retriever"] } });

    let prev = "role.guard";
    for (let i = 0; i < planSteps.length; i++) {
      const p = planSteps[i]!;
      await createTaskAssignment({ pool, tenantId, collabRunId, taskId,
        assignedRole: String(p.actorRole ?? "executor"), assignedBy: subjectId, priority: 80 - i,
        inputDigest: { kind: "collab_step", planStepId: p.stepId, stepKind: "executor", toolRef: p.toolRef, dependsOn: [prev], approvalRequired: Boolean(p.approvalRequired) } });
      prev = String(p.stepId);
    }

    await createTaskAssignment({ pool, tenantId, collabRunId, taskId, assignedRole: "reviewer", assignedBy: subjectId, priority: 10,
      inputDigest: { kind: "collab_step", planStepId: "role.reviewer", stepKind: "reviewer", toolRef: reviewToolRef, dependsOn: [prev] } });
    await createTaskAssignment({ pool, tenantId, collabRunId, taskId, assignedRole: "arbiter", assignedBy: subjectId, priority: 0,
      inputDigest: { kind: "arbiter_decision", planStepId: "role.arbiter", dependsOn: ["role.reviewer"], autoArbiter: arbiterAuto } });
  }

  /* ── 3. Build pipeline via topological sort ── */
  const assignments = hasAssignments
    ? existingAssignments
    : await listTaskAssignments({ pool, tenantId, collabRunId, status: null, limit: 200 });

  const collabSteps: StepNode[] = assignments
    .filter((a) => String((a as any)?.inputDigest?.kind ?? "") === "collab_step")
    .map((a) => ({
      planStepId: String((a as any).inputDigest.planStepId),
      actorRole: String((a as any).assignedRole ?? "executor"),
      stepKind: String((a as any).inputDigest.stepKind ?? "executor"),
      toolRef: String((a as any).inputDigest.toolRef),
      dependsOn: Array.isArray((a as any).inputDigest.dependsOn) ? ((a as any).inputDigest.dependsOn as any[]).map(String) : [],
    }));

  const ordered = topologicalSort(collabSteps);

  const planById = new Map(planSteps.map((p: any) => [String(p.stepId), p]));
  const pipeline = ordered.map((s) => {
    if (s.planStepId === "role.retriever") return { ...s, input: { query: message, limit: 5 } };
    if (s.planStepId === "role.guard") return { ...s, input: { plan: { steps: planSteps }, roles, limits, correlationId, autoArbiter: arbiterAuto } };
    if (s.planStepId === "role.reviewer") return { ...s, input: { mode: "respond" } };
    const p = planById.get(s.planStepId);
    return { ...s, input: (p?.inputDraft ?? {}) as any };
  });

  /* ── 4. Create steps via execution kernel ── */
  const createdSteps: any[] = [];
  const permByRole = new Map<string, any[]>();

  for (let i = 0; i < pipeline.length; i++) {
    const p = pipeline[i]!;

    const resolved = await resolveAndValidateTool({ pool, tenantId, spaceId, rawToolRef: String(p.toolRef) });
    const opDecision = await checkPermission({ resourceType: resolved.resourceType, action: resolved.action });
    const idempotencyKey = generateIdempotencyKey({ resolved, prefix: "idem-collab", runId, seq: i + 1 });
    const admitted = await admitAndBuildStepEnvelope({ pool, tenantId, spaceId, subjectId, resolved, opDecision });

    const roleKey = String(p.actorRole ?? "").trim();
    if (roleKey) {
      const list = permByRole.get(roleKey) ?? [];
      list.push({
        toolRef: resolved.toolRef,
        toolContract: { scope: resolved.scope, resourceType: resolved.resourceType, action: resolved.action, idempotencyRequired: resolved.idempotencyRequired },
        policySnapshotRef: opDecision.snapshotRef ?? null,
        fieldRules: (opDecision as any).fieldRules ?? null,
        rowFilters: (opDecision as any).rowFilters ?? null,
      });
      permByRole.set(roleKey, list);
    }

    const stepInput = buildStepInputPayload({
      kind: "agent.run.step", resolved, admitted,
      input: p.input ?? {}, idempotencyKey,
      tenantId, spaceId, subjectId, traceId,
      extra: {
        collabRunId, taskId,
        planStepId: p.planStepId, actorRole: p.actorRole, stepKind: p.stepKind, dependsOn: p.dependsOn,
        ...(p.stepKind === "guard" ? { autoArbiter: arbiterAuto, correlationId } : {}),
      },
    });

    const step = await appendStepToRun({
      pool, tenantId, jobType: "agent.run", runId,
      toolRef: resolved.toolRef, policySnapshotRef: opDecision.snapshotRef,
      masterKey, input: stepInput,
    });
    createdSteps.push(step);
  }

  /* ── 5. Build permission contexts ── */
  for (const [roleName, toolContracts] of permByRole.entries()) {
    if (!roleName) continue;
    const first = toolContracts.length ? toolContracts[0] : null;
    await upsertPermissionContext({
      pool, tenantId, collabRunId, roleName,
      effectivePermissions: { toolContracts },
      fieldRules: null, rowFilters: null,
      policySnapshotRef: first?.policySnapshotRef ?? null,
      expiresAt: null,
    });
  }

  /* ── 6. Set run/job status + enqueue first step ── */
  await setRunAndJobStatus({ pool, tenantId, runId, jobId, runStatus: "queued", jobStatus: "queued" });
  const updated = await updateCollabRunStatus({ pool, tenantId, collabRunId, status: "executing" });
  if (!updated) throw Errors.internal();

  const firstStep = createdSteps[0];
  await enqueueWorkflowStep({ queue, pool, jobId, runId, stepId: firstStep.stepId });

  await appendCollabRunEvent({
    pool, tenantId, spaceId, collabRunId: updated.collabRunId, taskId,
    type: "collab.run.queued",
    actorRole: "collab_runtime", runId,
    stepId: firstStep.stepId, correlationId,
    payloadDigest: { firstStepKind: "retriever", firstToolRef: retrieverToolRef },
  });

  return {
    ok: true,
    retrieverToolRef,
    createdSteps,
    firstStepId: firstStep.stepId,
    updated,
  };
}
