/**
 * Unified Execution Submission Kernel.
 *
 * Extracts the common "resolve → validate → admit → build step → submit → enqueue"
 * pipeline that was previously duplicated across:
 *   - orchestrator/routes.execute.ts
 *   - orchestrator/routes.closedLoop.ts
 *   - agent-runtime/routes.ts
 *   - collab-runtime/routes.ts
 *   - routes/tools.ts (POST /tools/:toolRef/execute)
 *
 * Each runtime still owns its own request parsing, planning, and response shaping.
 * This kernel provides three composable phases:
 *   Phase 1 — resolveAndValidateTool()
 *   Phase 2 — admitAndBuildStepInput()
 *   Phase 3 — submitToolStep()
 */
import type { Pool } from "pg";
import type { Queue } from "bullmq";
import type { CapabilityEnvelopeV1 } from "@openslin/shared";
import { Errors } from "../lib/errors";
import { getLatestReleasedToolVersion, getToolDefinition, getToolVersionByRef, type ToolDefinition, type ToolVersion } from "../modules/tools/toolRepo";
import { resolveEffectiveToolRef } from "../modules/tools/resolve";
import { isToolEnabled } from "../modules/governance/toolGovernanceRepo";
import { admitToolExecution, networkPolicyDigest, type ExecutionAdmissionResult } from "../modules/tools/executionAdmission";
import { validateToolInput } from "../modules/tools/validate";
import { createApproval } from "../modules/workflow/approvalRepo";
import { appendStepToRun, createJobRunStep } from "../modules/workflow/jobRepo";
import { enqueueWorkflowStep, setRunAndJobStatus } from "../modules/workflow/queue";
import { insertAuditEvent } from "../modules/audit/auditRepo";

/* ================================================================== */
/*  Phase 1 — Resolve & Validate Tool                                  */
/* ================================================================== */

export interface ResolveToolParams {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  /** Raw tool reference (may or may not include @version). */
  rawToolRef: string;
}

export interface ResolvedTool {
  toolName: string;
  toolRef: string;
  version: ToolVersion;
  definition: ToolDefinition;
  scope: "read" | "write";
  resourceType: string;
  action: string;
  idempotencyRequired: boolean;
}

/**
 * Phase 1: Resolve a raw tool reference into a fully validated tool context.
 *
 * Steps:
 *  1. Parse toolName from rawToolRef
 *  2. Resolve effective toolRef if no @version
 *  3. Validate version exists and status is "released"
 *  4. Validate tool is enabled for the scope (tenant+space)
 *  5. Validate tool definition contract is complete
 *
 * Throws AppError on any validation failure.
 */
export async function resolveAndValidateTool(params: ResolveToolParams): Promise<ResolvedTool> {
  const { pool, tenantId, spaceId, rawToolRef } = params;

  const idx = rawToolRef.lastIndexOf("@");
  const toolName = idx > 0 ? rawToolRef.slice(0, idx) : rawToolRef;

  // Resolve effective toolRef
  let toolRef = idx > 0 ? rawToolRef : await resolveEffectiveToolRef({ pool, tenantId, spaceId, name: toolName });
  if (!toolRef) {
    throw Errors.notFound("工具版本");
  }

  // Validate version
  let version = await getToolVersionByRef(pool, tenantId, toolRef);
  if (!version) {
    throw Errors.notFound("工具版本");
  }
  if (version.status !== "released") {
    throw Errors.badRequest("工具未发布");
  }

  // Validate enabled
  let enabled = await isToolEnabled({ pool, tenantId, spaceId, toolRef });
  if (!enabled && idx <= 0) {
    const latest = await getLatestReleasedToolVersion(pool, tenantId, toolName);
    const latestRef = latest?.toolRef ?? null;
    if (latestRef && latestRef !== toolRef) {
      const latestEnabled = await isToolEnabled({ pool, tenantId, spaceId, toolRef: latestRef });
      if (latestEnabled && latest) {
        toolRef = latestRef;
        version = latest;
        enabled = true;
      }
    }
  }
  if (!enabled) {
    throw Errors.toolDisabled();
  }

  // Validate contract
  const definition = await getToolDefinition(pool, tenantId, toolName);
  if (!definition) {
    throw Errors.badRequest("工具定义不存在");
  }
  const { scope, resourceType, action, idempotencyRequired } = definition;
  if (!scope || !resourceType || !action || idempotencyRequired === null) {
    throw Errors.badRequest("工具契约缺失");
  }

  return {
    toolName,
    toolRef,
    version,
    definition,
    scope: scope as "read" | "write",
    resourceType,
    action,
    idempotencyRequired: Boolean(idempotencyRequired),
  };
}

/* ================================================================== */
/*  Phase 2 — Admit & Build Step Input                                 */
/* ================================================================== */

export interface AdmitToolParams {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  resolved: ResolvedTool;
  /** Permission decision from requirePermission(). */
  opDecision: { snapshotRef?: string; fieldRules?: any; rowFilters?: any; [k: string]: any };
  /** Runtime-supplied limits (e.g. from request body). */
  limits?: any;
  /** Optional requested capability envelope from client. */
  requestedCapabilityEnvelope?: any;
  /** Whether the caller must provide a capability envelope. */
  requireRequestedEnvelope?: boolean;
}

export interface AdmittedTool {
  envelope: CapabilityEnvelopeV1;
  limits: any;
  networkPolicy: any;
  networkPolicyDigest: ReturnType<typeof networkPolicyDigest>;
  effectiveEnvelope: CapabilityEnvelopeV1;
}

/**
 * Phase 2: Run execution admission and build the capability envelope.
 *
 * Delegates to admitToolExecution and returns the resolved envelope,
 * limits, and network policy. Throws on admission failure.
 */
export async function admitAndBuildStepEnvelope(params: AdmitToolParams): Promise<AdmittedTool> {
  const { pool, tenantId, spaceId, subjectId, resolved, opDecision } = params;
  const admitted = await admitToolExecution({
    pool,
    tenantId,
    spaceId,
    subjectId,
    toolRef: resolved.toolRef,
    toolContract: {
      scope: resolved.scope,
      resourceType: resolved.resourceType,
      action: resolved.action,
      fieldRules: opDecision.fieldRules ?? null,
      rowFilters: opDecision.rowFilters ?? null,
    },
    limits: params.limits ?? {},
    requestedCapabilityEnvelope: params.requestedCapabilityEnvelope ?? null,
    requireRequestedEnvelope: params.requireRequestedEnvelope ?? false,
  });

  if (!admitted.ok) {
    const reason = admitted.reason;
    if (reason === "missing") throw Errors.badRequest("缺少 capabilityEnvelope");
    if (reason === "invalid") throw Errors.badRequest("capabilityEnvelope 不合法");
    throw Errors.badRequest("capabilityEnvelope 不得扩大权限");
  }

  return {
    envelope: admitted.envelope,
    limits: admitted.limits,
    networkPolicy: admitted.networkPolicy,
    networkPolicyDigest: admitted.networkPolicyDigest,
    effectiveEnvelope: admitted.effectiveEnvelope,
  };
}

/**
 * Build the canonical step input payload.
 * Used by all runtimes to construct the step input stored in the DB.
 */
export function buildStepInputPayload(params: {
  kind: string;
  resolved: ResolvedTool;
  admitted: AdmittedTool;
  input: any;
  idempotencyKey?: string | null;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  traceId: string;
  /** Extra fields merged into the step input (e.g. planStepId, actorRole, dependsOn). */
  extra?: Record<string, any>;
}): Record<string, any> {
  const { kind, resolved, admitted, input, idempotencyKey, tenantId, spaceId, subjectId, traceId, extra } = params;
  return {
    ...(extra ?? {}),
    kind,
    toolRef: resolved.toolRef,
    idempotencyKey: idempotencyKey ?? undefined,
    toolContract: {
      scope: resolved.scope,
      resourceType: resolved.resourceType,
      action: resolved.action,
      idempotencyRequired: resolved.idempotencyRequired,
      riskLevel: resolved.definition.riskLevel,
      approvalRequired: resolved.definition.approvalRequired,
      fieldRules: admitted.envelope.dataDomain.toolContract.fieldRules ?? null,
      rowFilters: admitted.envelope.dataDomain.toolContract.rowFilters ?? null,
    },
    input,
    limits: admitted.limits,
    networkPolicy: admitted.networkPolicy,
    capabilityEnvelope: admitted.envelope,
    tenantId,
    spaceId,
    subjectId,
    traceId,
  };
}

/* ================================================================== */
/*  Phase 3 — Submit & Enqueue Tool Step                               */
/* ================================================================== */

export interface SubmitNewRunParams {
  pool: Pool;
  queue: Queue;
  tenantId: string;
  resolved: ResolvedTool;
  opDecision: { snapshotRef?: string; [k: string]: any };
  stepInput: Record<string, any>;
  idempotencyKey?: string | null;
  createdBySubjectId?: string;
  trigger: string;
  masterKey?: string;
  jobType?: string;
}

export interface SubmitStepToRunParams {
  pool: Pool;
  queue: Queue;
  tenantId: string;
  resolved: ResolvedTool;
  opDecision: { snapshotRef?: string; [k: string]: any };
  stepInput: Record<string, any>;
  runId: string;
  jobId: string;
  masterKey?: string;
  jobType?: string;
}

export type SubmitResult =
  | {
      outcome: "queued";
      jobId: string;
      runId: string;
      stepId: string;
      idempotencyKey?: string | null;
    }
  | {
      outcome: "needs_approval";
      jobId: string;
      runId: string;
      stepId: string;
      approvalId: string;
      idempotencyKey?: string | null;
    };

/**
 * Phase 3a: Create a new Run + Job + Step, then enqueue or request approval.
 *
 * Used by orchestrator/execute and routes/tools.ts execute.
 */
export async function submitNewToolRun(params: SubmitNewRunParams): Promise<SubmitResult> {
  const { pool, queue, tenantId, resolved, opDecision, stepInput, createdBySubjectId, trigger, masterKey } = params;
  const jobType = params.jobType ?? "tool.execute";
  const idempotencyKey = params.idempotencyKey ?? undefined;

  const { job, run, step } = await createJobRunStep({
    pool,
    tenantId,
    jobType,
    toolRef: resolved.toolRef,
    policySnapshotRef: opDecision.snapshotRef,
    idempotencyKey,
    createdBySubjectId,
    trigger,
    masterKey,
    input: stepInput,
  });

  return await _handleApprovalOrEnqueue({
    pool, queue, tenantId, resolved, opDecision, step, run, job,
    idempotencyKey: idempotencyKey ?? null,
    spaceId: stepInput.spaceId ?? null,
    subjectId: stepInput.subjectId ?? null,
    traceId: stepInput.traceId ?? null,
    requestId: null,
  });
}

/**
 * Phase 3b: Append a step to an existing Run, then enqueue or request approval.
 *
 * Used by closed-loop and agent-runtime.
 */
export async function submitStepToExistingRun(params: SubmitStepToRunParams): Promise<SubmitResult> {
  const { pool, queue, tenantId, resolved, opDecision, stepInput, runId, jobId, masterKey } = params;
  const jobType = params.jobType ?? "agent.run";

  const step = await appendStepToRun({
    pool,
    tenantId,
    jobType,
    runId,
    toolRef: resolved.toolRef,
    policySnapshotRef: opDecision.snapshotRef,
    masterKey,
    input: stepInput,
  });

  return await _handleApprovalOrEnqueue({
    pool, queue, tenantId, resolved, opDecision, step, run: { runId } as any, job: { jobId } as any,
    idempotencyKey: stepInput.idempotencyKey ?? null,
    spaceId: stepInput.spaceId ?? null,
    subjectId: stepInput.subjectId ?? null,
    traceId: stepInput.traceId ?? null,
    requestId: null,
  });
}

/* ------------------------------------------------------------------ */
/*  Internal: approval-or-enqueue                                      */
/* ------------------------------------------------------------------ */

async function _handleApprovalOrEnqueue(params: {
  pool: Pool;
  queue: Queue;
  tenantId: string;
  resolved: ResolvedTool;
  opDecision: any;
  step: any;
  run: any;
  job: any;
  idempotencyKey: string | null;
  spaceId: string | null;
  subjectId: string | null;
  traceId: string | null;
  requestId: string | null;
}): Promise<SubmitResult> {
  const { pool, queue, tenantId, resolved, opDecision, step, run, job, idempotencyKey, spaceId, subjectId, traceId, requestId } = params;
  const runId = run.runId ?? run.run_id;
  const jobId = job.jobId ?? job.job_id;
  const stepId = step.stepId ?? step.step_id;

  const approvalRequired = Boolean(resolved.definition.approvalRequired) || resolved.definition.riskLevel === "high";

  if (approvalRequired) {
    await setRunAndJobStatus({ pool, tenantId, runId, jobId, runStatus: "needs_approval", jobStatus: "needs_approval" });
    const approval = await createApproval({
      pool,
      tenantId,
      spaceId,
      runId,
      stepId,
      requestedBySubjectId: subjectId ?? "",
      toolRef: resolved.toolRef,
      policySnapshotRef: opDecision.snapshotRef ?? null,
      inputDigest: step.inputDigest ?? null,
    });
    await insertAuditEvent(pool, {
      subjectId: subjectId ?? undefined,
      tenantId,
      spaceId: spaceId ?? undefined,
      resourceType: "workflow",
      action: "approval.requested",
      policyDecision: opDecision,
      inputDigest: { approvalId: approval.approvalId, toolRef: resolved.toolRef },
      outputDigest: { status: "pending", runId, stepId },
      idempotencyKey: idempotencyKey ?? undefined,
      result: "success",
      traceId: traceId ?? "",
      requestId: requestId ?? undefined,
      runId,
      stepId,
    });
    return { outcome: "needs_approval", jobId, runId, stepId, approvalId: approval.approvalId, idempotencyKey };
  }

  await setRunAndJobStatus({ pool, tenantId, runId, jobId, runStatus: "queued", jobStatus: "queued" });
  await enqueueWorkflowStep({ queue, pool, jobId, runId, stepId });
  return { outcome: "queued", jobId, runId, stepId, idempotencyKey };
}

/* ================================================================== */
/*  Convenience: full pipeline in one call                             */
/* ================================================================== */

/**
 * Generate an idempotency key for a write tool if needed.
 */
export function generateIdempotencyKey(params: {
  resolved: ResolvedTool;
  existingKey?: string | null;
  prefix: string;
  runId?: string;
  seq?: number;
}): string | null {
  if (params.existingKey) return params.existingKey;
  if (params.resolved.scope === "write" && params.resolved.idempotencyRequired) {
    if (params.runId) return `${params.prefix}-${params.runId}-${params.seq ?? 1}`;
    return `${params.prefix}-${Date.now()}`;
  }
  return null;
}
