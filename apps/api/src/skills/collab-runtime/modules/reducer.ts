import type { CollabPhase, StepStatus } from "../../../kernel/stateMachine";
import { normalizeStepStatus, normalizeCollabPhase, checkStateInvariant } from "../../../kernel/stateMachine";

export type CollabInvariant = { code: string; severity: "error" | "warn"; message: string; details?: any };

export type CollabDerivedState = {
  phase: CollabPhase;
  expectedNextAction: "wait" | "queue" | "needs_approval" | "needs_device" | "needs_arbiter" | "terminal";
  runStatus: string | null;
  stepSummary: { total: number; pending: number; running: number; succeeded: number; failed: number; deadletter: number; canceled: number };
};

export function deriveCollabState(params: {
  collabStatus: string;
  primaryRunId: string | null;
  runStatus: string | null;
  steps: Array<{ stepId: string; status: string; toolRef: string | null; seq: number }>;
  events: Array<{ type: string; stepId: string | null; runId: string | null; createdAt?: string | null }>;
}) {
  const invariants: CollabInvariant[] = [];
  const collabStatus = String(params.collabStatus ?? "");
  const runStatus = params.runStatus ? String(params.runStatus) : null;
  const steps = params.steps ?? [];
  const events = params.events ?? [];

  const stepSummary = {
    total: steps.length,
    pending: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    deadletter: 0,
    canceled: 0,
  };
  for (const s of steps) {
    const st = normalizeStepStatus(s.status);
    if (st === "pending") stepSummary.pending += 1;
    else if (st === "running") stepSummary.running += 1;
    else if (st === "succeeded") stepSummary.succeeded += 1;
    else if (st === "failed") stepSummary.failed += 1;
    else if (st === "deadletter") stepSummary.deadletter += 1;
    else if (st === "canceled") stepSummary.canceled += 1;
  }

  function hasEvent(type: string, stepId?: string | null) {
    if (!stepId) return events.some((e) => String(e.type ?? "") === type);
    return events.some((e) => String(e.type ?? "") === type && String(e.stepId ?? "") === String(stepId));
  }

  if (params.primaryRunId && !runStatus) invariants.push({ code: "run.missing", severity: "error", message: "primaryRunId 存在但 runs 记录缺失" });

  if (collabStatus === "executing") {
    if (runStatus && ["needs_approval", "needs_device", "needs_arbiter", "canceled"].includes(runStatus)) {
      invariants.push({ code: "status.mismatch", severity: "error", message: "collab 执行中但 run 已进入阻塞/取消状态", details: { collabStatus, runStatus } });
    }
  }
  if (collabStatus === "needs_approval" && runStatus && runStatus !== "needs_approval") {
    invariants.push({ code: "status.mismatch", severity: "warn", message: "collab 需要审批但 run.status 非 needs_approval", details: { collabStatus, runStatus } });
  }
  if (collabStatus === "needs_device" && runStatus && runStatus !== "needs_device") {
    invariants.push({ code: "status.mismatch", severity: "warn", message: "collab 需要设备但 run.status 非 needs_device", details: { collabStatus, runStatus } });
  }
  if (collabStatus === "needs_arbiter" && runStatus && runStatus !== "needs_arbiter") {
    invariants.push({ code: "status.mismatch", severity: "warn", message: "collab 需要仲裁但 run.status 非 needs_arbiter", details: { collabStatus, runStatus } });
  }
  if (collabStatus === "succeeded" && runStatus && runStatus !== "succeeded") {
    invariants.push({ code: "status.mismatch", severity: "error", message: "collab 已成功但 run.status 非 succeeded", details: { collabStatus, runStatus } });
  }
  if (collabStatus === "failed" && runStatus && runStatus !== "failed") {
    invariants.push({ code: "status.mismatch", severity: "warn", message: "collab failed 但 run.status 非 failed", details: { collabStatus, runStatus } });
  }

  for (const s of steps) {
    if (String(s.status) === "running" && hasEvent("collab.step.completed", s.stepId)) {
      invariants.push({ code: "step.event_mismatch", severity: "error", message: "step 仍在 running 但已出现 completed 事件", details: { stepId: s.stepId } });
    }
    if (String(s.status) === "succeeded" && !hasEvent("collab.step.completed", s.stepId)) {
      invariants.push({ code: "step.event_missing", severity: "warn", message: "step succeeded 但缺少 completed 事件", details: { stepId: s.stepId } });
    }
    if (String(s.status) === "failed" && !hasEvent("collab.step.failed", s.stepId)) {
      invariants.push({ code: "step.event_missing", severity: "warn", message: "step failed 但缺少 failed 事件", details: { stepId: s.stepId } });
    }
  }

  let phase: CollabPhase = (normalizeCollabPhase(collabStatus) ?? "planning");
  if (collabStatus === "executing") phase = "executing";

  let expectedNextAction: CollabDerivedState["expectedNextAction"] = "wait";
  if (phase === "needs_approval") expectedNextAction = "needs_approval";
  else if (phase === "needs_device") expectedNextAction = "needs_device";
  else if (phase === "needs_arbiter") expectedNextAction = "needs_arbiter";
  else if (phase === "succeeded" || phase === "failed" || phase === "stopped") expectedNextAction = "terminal";
  else if (phase === "planning") expectedNextAction = "queue";
  else if (phase === "executing") expectedNextAction = stepSummary.pending > 0 ? "wait" : "wait";

  const derived: CollabDerivedState = { phase, expectedNextAction, runStatus, stepSummary };

  // Run state machine invariant check if we have a run
  if (runStatus) {
    const smInvariants = checkStateInvariant({
      runStatus,
      steps: steps.map((s) => ({ stepId: s.stepId, status: s.status })),
      collabPhase: phase,
    });
    for (const v of smInvariants) {
      invariants.push({ code: `sm.${v.code}`, severity: v.severity, message: v.message, details: v.details });
    }
  }

  return { derived, invariants };
}
