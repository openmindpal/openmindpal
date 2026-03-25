/**
 * Shared types and utility functions for the closed-loop execution runtime.
 * Extracted from routes.closedLoop.ts to reduce file size and enable reuse.
 */
import { sha256Hex } from "../../lib/digest";

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

export type ClosedLoopPhase = "planning" | "executing" | "reviewing" | "needs_approval" | "succeeded" | "failed" | "stopped";
export type ClosedLoopNextActionKind = "wait" | "continue" | "needs_approval" | "stop";
export type PlanningMode = "plan_execute" | "react";
export type ExecutionSemantics = "execute" | "dry_run" | "replay_only";

/* ================================================================== */
/*  Utility Functions                                                   */
/* ================================================================== */

export function normalizeStepStatus(v: unknown) {
  const s = String(v ?? "");
  if (["created", "pending", "running", "succeeded", "failed", "deadletter", "canceled"].includes(s)) return s;
  return s || "unknown";
}

export function buildClosedLoopSummaryV1(params: { plan: any; steps: any[]; cursor: number; maxSteps: number; maxWallTimeMs: number; runStatus?: string | null }) {
  const planSteps: any[] = Array.isArray(params.plan?.steps) ? params.plan.steps : [];
  const stepStatuses = planSteps.map((p, i) => {
    const s = params.steps[i] ?? null;
    const status = normalizeStepStatus(s?.status ?? (i < params.cursor ? "created" : "pending"));
    const errorCategory = typeof s?.errorCategory === "string" ? s.errorCategory : null;
    const retryable = Boolean(errorCategory && ["retryable", "timeout", "resource_exhausted"].includes(errorCategory) && ["failed", "deadletter"].includes(status));
    return {
      index: i,
      planStepId: typeof p?.stepId === "string" ? p.stepId : null,
      runStepId: typeof s?.stepId === "string" ? s.stepId : null,
      toolRef: String(p?.toolRef ?? s?.toolRef ?? ""),
      status,
      attempt: typeof s?.attempt === "number" ? s.attempt : 0,
      policySnapshotRef: typeof s?.policySnapshotRef === "string" ? s.policySnapshotRef : null,
      errorCategory,
      retryable,
      inputDigest: s?.inputDigest ?? null,
      outputDigest: s?.outputDigest ?? null,
      lastErrorDigest: s?.lastErrorDigest ?? null,
      updatedAt: s?.updatedAt ?? null,
    };
  });

  const limit = Math.min(params.maxSteps, planSteps.length);
  const runStatus = params.runStatus ? String(params.runStatus) : "";
  let phase: ClosedLoopPhase = "planning";
  if (runStatus === "needs_approval") {
    phase = "needs_approval";
  } else if (params.cursor >= limit) {
    const slice = stepStatuses.slice(0, limit);
    const allSucceeded = slice.length > 0 && slice.every((x) => x.status === "succeeded");
    phase = allSucceeded && params.cursor >= planSteps.length ? "succeeded" : "stopped";
  } else if (params.cursor > 0) {
    const prev = stepStatuses[params.cursor - 1] ?? null;
    if (prev && ["pending", "running", "created"].includes(prev.status)) phase = "executing";
    else phase = "reviewing";
  }

  let nextAction: { kind: ClosedLoopNextActionKind; reason?: string } = { kind: "continue" };
  if (phase === "needs_approval") nextAction = { kind: "needs_approval", reason: "approval_required" };
  else if (phase === "executing") nextAction = { kind: "wait", reason: "step_pending" };
  else if (phase === "reviewing") nextAction = { kind: "continue", reason: "next_step" };
  else if (phase === "succeeded") nextAction = { kind: "stop", reason: "succeeded" };
  else if (phase === "stopped") nextAction = { kind: "stop", reason: "stopped" };

  const lastIdx = Math.min(params.cursor, stepStatuses.length) - 1;
  const lastStep = lastIdx >= 0 ? stepStatuses[lastIdx] : null;
  const stopReason =
    phase === "succeeded"
      ? "plan_end"
      : phase === "stopped"
        ? params.cursor >= limit
          ? "max_steps_or_end"
          : "stopped"
        : undefined;

  return {
    summaryVersion: "v1",
    phase,
    cursor: params.cursor,
    maxSteps: params.maxSteps,
    maxWallTimeMs: params.maxWallTimeMs,
    stepStatuses,
    executionSummary: {
      lastStep: lastStep
        ? {
            index: lastStep.index,
            runStepId: lastStep.runStepId,
            toolRef: lastStep.toolRef,
            status: lastStep.status,
            policySnapshotRef: (lastStep as any).policySnapshotRef ?? null,
            errorCategory: lastStep.errorCategory,
          }
        : null,
      nextAction,
      stopReason,
    },
  };
}

export function sha256_8(input: string) {
  return sha256Hex(input).slice(0, 8);
}

export function digestText(input: unknown) {
  const s = typeof input === "string" ? input : input === null || input === undefined ? "" : String(input);
  return { len: s.length, sha256_8: sha256_8(s) };
}

export function digestToolRefs(toolRefs: string[]) {
  const canon = toolRefs.map((x) => String(x ?? "").trim()).filter(Boolean).sort();
  return { count: canon.length, sha256_8: sha256_8(canon.join("\n")) };
}

export function normalizePlanningMode(v: unknown): PlanningMode {
  const s = String(v ?? "");
  if (s === "react") return "react";
  return "plan_execute";
}

export function normalizeExecutionSemantics(v: unknown): ExecutionSemantics {
  const s = String(v ?? "");
  if (s === "dry_run") return "dry_run";
  if (s === "replay_only") return "replay_only";
  return "execute";
}

export function buildEvalCaseResultSummary(params: { semantics: ExecutionSemantics; phase: string; plannedSteps: number; queuedSteps: number; blockedSteps: number; observedSteps: number; planDigest?: any }) {
  return { semantics: params.semantics, phase: params.phase, plannedSteps: params.plannedSteps, queuedSteps: params.queuedSteps, blockedSteps: params.blockedSteps, observedSteps: params.observedSteps, planDigest: params.planDigest ?? null };
}
