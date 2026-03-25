/**
 * Unified Runtime State Machine.
 *
 * Defines canonical status enums, legal transition tables, and transition
 * functions for Step, Run, and CollabPhase statuses.
 *
 * Shared across API and Worker.
 */

/* ================================================================== */
/*  Step Status                                                         */
/* ================================================================== */

export const STEP_STATUSES = [
  "pending",
  "running",
  "needs_approval",
  "needs_device",
  "needs_arbiter",
  "succeeded",
  "failed",
  "deadletter",
  "canceled",
] as const;

export type StepStatus = (typeof STEP_STATUSES)[number];

export const STEP_TERMINAL: ReadonlySet<StepStatus> = new Set(["succeeded", "deadletter"]);
export const STEP_BLOCKING: ReadonlySet<StepStatus> = new Set(["needs_approval", "needs_device", "needs_arbiter"]);

export const STEP_TRANSITIONS: Readonly<Record<StepStatus, ReadonlySet<StepStatus>>> = {
  pending:        new Set(["running", "needs_approval", "needs_device", "needs_arbiter", "canceled"]),
  running:        new Set(["succeeded", "failed", "canceled", "deadletter"]),
  needs_approval: new Set(["pending", "canceled"]),
  needs_device:   new Set(["pending", "canceled"]),
  needs_arbiter:  new Set(["pending", "canceled"]),
  succeeded:      new Set([]),
  failed:         new Set(["pending", "deadletter", "canceled"]),
  deadletter:     new Set([]),
  canceled:       new Set(["pending"]),
};

/* ================================================================== */
/*  Run Status                                                          */
/* ================================================================== */

export const RUN_STATUSES = [
  "created",
  "queued",
  "running",
  "needs_approval",
  "needs_device",
  "needs_arbiter",
  "succeeded",
  "failed",
  "canceled",
  "stopped",
  "compensating",
  "compensated",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_TERMINAL: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "canceled", "stopped", "compensated"]);

export const RUN_TRANSITIONS: Readonly<Record<RunStatus, ReadonlySet<RunStatus>>> = {
  created:        new Set(["queued", "canceled"]),
  queued:         new Set(["running", "needs_approval", "needs_device", "needs_arbiter", "canceled", "failed"]),
  running:        new Set(["succeeded", "failed", "needs_approval", "needs_device", "needs_arbiter", "canceled", "stopped", "compensating"]),
  needs_approval: new Set(["queued", "canceled", "failed"]),
  needs_device:   new Set(["queued", "canceled", "failed"]),
  needs_arbiter:  new Set(["queued", "canceled", "failed"]),
  succeeded:      new Set([]),
  failed:         new Set(["queued", "compensating"]),
  canceled:       new Set([]),
  stopped:        new Set([]),
  compensating:   new Set(["compensated", "failed"]),
  compensated:    new Set([]),
};

/* ================================================================== */
/*  CollabPhase                                                         */
/* ================================================================== */

export const COLLAB_PHASES = [
  "planning",
  "executing",
  "needs_approval",
  "needs_device",
  "needs_arbiter",
  "succeeded",
  "failed",
  "stopped",
] as const;

export type CollabPhase = (typeof COLLAB_PHASES)[number];

export const COLLAB_TERMINAL: ReadonlySet<CollabPhase> = new Set(["succeeded", "failed", "stopped"]);

export const COLLAB_TRANSITIONS: Readonly<Record<CollabPhase, ReadonlySet<CollabPhase>>> = {
  planning:       new Set(["executing", "needs_approval", "failed", "stopped"]),
  executing:      new Set(["needs_approval", "needs_device", "needs_arbiter", "succeeded", "failed", "stopped"]),
  needs_approval: new Set(["executing", "failed", "stopped"]),
  needs_device:   new Set(["executing", "failed", "stopped"]),
  needs_arbiter:  new Set(["executing", "failed", "stopped"]),
  succeeded:      new Set([]),
  failed:         new Set([]),
  stopped:        new Set([]),
};

/* ================================================================== */
/*  Transition Functions                                                */
/* ================================================================== */

export interface TransitionViolation {
  entity: "step" | "run" | "collab";
  from: string;
  to: string;
  message: string;
}

function createTransitionViolation(entity: "step" | "run" | "collab", from: string, to: string): TransitionViolation {
  return { entity, from, to, message: `Illegal ${entity} transition: ${from} → ${to}` };
}

export function transitionStep(from: StepStatus, to: StepStatus): StepStatus {
  if (from === to) return to;
  const allowed = STEP_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) throw createTransitionViolation("step", from, to);
  return to;
}

export function transitionRun(from: RunStatus, to: RunStatus): RunStatus {
  if (from === to) return to;
  const allowed = RUN_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) throw createTransitionViolation("run", from, to);
  return to;
}

export function transitionCollab(from: CollabPhase, to: CollabPhase): CollabPhase {
  if (from === to) return to;
  const allowed = COLLAB_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) throw createTransitionViolation("collab", from, to);
  return to;
}

/* ================================================================== */
/*  Safe transition (non-throwing)                                      */
/* ================================================================== */

export interface TransitionResult<T extends string> {
  ok: boolean;
  status: T;
  violation?: TransitionViolation;
}

export function tryTransitionStep(from: StepStatus, to: StepStatus): TransitionResult<StepStatus> {
  if (from === to) return { ok: true, status: to };
  const allowed = STEP_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) return { ok: false, status: from, violation: createTransitionViolation("step", from, to) };
  return { ok: true, status: to };
}

export function tryTransitionRun(from: RunStatus, to: RunStatus): TransitionResult<RunStatus> {
  if (from === to) return { ok: true, status: to };
  const allowed = RUN_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) return { ok: false, status: from, violation: createTransitionViolation("run", from, to) };
  return { ok: true, status: to };
}

export function tryTransitionCollab(from: CollabPhase, to: CollabPhase): TransitionResult<CollabPhase> {
  if (from === to) return { ok: true, status: to };
  const allowed = COLLAB_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) return { ok: false, status: from, violation: createTransitionViolation("collab", from, to) };
  return { ok: true, status: to };
}

/* ================================================================== */
/*  Normalizer                                                          */
/* ================================================================== */

const STEP_STATUS_SET: ReadonlySet<string> = new Set(STEP_STATUSES);
const RUN_STATUS_SET: ReadonlySet<string> = new Set(RUN_STATUSES);
const COLLAB_PHASE_SET: ReadonlySet<string> = new Set(COLLAB_PHASES);

export function normalizeStepStatus(raw: unknown): StepStatus | null {
  const s = String(raw ?? "").trim();
  if (s === "created") return "pending";
  if (s === "compensating") return "running";
  return STEP_STATUS_SET.has(s) ? (s as StepStatus) : null;
}

export function normalizeRunStatus(raw: unknown): RunStatus | null {
  const s = String(raw ?? "").trim();
  return RUN_STATUS_SET.has(s) ? (s as RunStatus) : null;
}

export function normalizeCollabPhase(raw: unknown): CollabPhase | null {
  const s = String(raw ?? "").trim();
  if (s === "canceled") return "stopped";
  return COLLAB_PHASE_SET.has(s) ? (s as CollabPhase) : null;
}

/* ================================================================== */
/*  State Invariant Check                                               */
/* ================================================================== */

export interface StateInvariantViolation {
  code: string;
  severity: "error" | "warn";
  message: string;
  details?: Record<string, unknown>;
}

export function checkStateInvariant(params: {
  runStatus: string;
  steps: Array<{ stepId: string; status: string }>;
  collabPhase?: string | null;
}): StateInvariantViolation[] {
  const violations: StateInvariantViolation[] = [];
  const runSt = normalizeRunStatus(params.runStatus);

  if (!runSt) {
    violations.push({ code: "run.invalid_status", severity: "error", message: `Run has unknown status: "${params.runStatus}"`, details: { runStatus: params.runStatus } });
    return violations;
  }

  const stepStatuses = params.steps.map((s) => ({ stepId: s.stepId, status: normalizeStepStatus(s.status), raw: s.status }));

  for (const s of stepStatuses) {
    if (!s.status) {
      violations.push({ code: "step.invalid_status", severity: "error", message: `Step ${s.stepId} has unknown status: "${s.raw}"`, details: { stepId: s.stepId, status: s.raw } });
    }
  }

  const valid = stepStatuses.filter((s) => s.status !== null);
  const allTerminal = valid.length > 0 && valid.every((s) => STEP_TERMINAL.has(s.status!));
  const hasRunning = valid.some((s) => s.status === "running");
  const hasPending = valid.some((s) => s.status === "pending");
  const hasFailed = valid.some((s) => s.status === "failed");

  if (RUN_TERMINAL.has(runSt) && (hasRunning || hasPending)) {
    violations.push({ code: "run.terminal_with_active_steps", severity: "error", message: `Run is ${runSt} but has active steps`, details: { runStatus: runSt } });
  }
  if (runSt === "succeeded" && hasFailed) {
    violations.push({ code: "run.succeeded_with_failed_steps", severity: "warn", message: "Run is succeeded but has failed steps", details: { runStatus: runSt } });
  }
  if (allTerminal && !RUN_TERMINAL.has(runSt) && valid.length > 0) {
    violations.push({ code: "run.non_terminal_all_steps_done", severity: "warn", message: `All steps are terminal but run is still ${runSt}`, details: { runStatus: runSt } });
  }

  if (params.collabPhase) {
    const cp = normalizeCollabPhase(params.collabPhase);
    if (!cp) {
      violations.push({ code: "collab.invalid_phase", severity: "error", message: `CollabPhase has unknown value: "${params.collabPhase}"` });
    } else if (COLLAB_TERMINAL.has(cp) && !RUN_TERMINAL.has(runSt)) {
      violations.push({ code: "collab.terminal_run_active", severity: "warn", message: `CollabPhase is ${cp} (terminal) but run is ${runSt}` });
    } else if (!COLLAB_TERMINAL.has(cp) && RUN_TERMINAL.has(runSt)) {
      violations.push({ code: "collab.active_run_terminal", severity: "warn", message: `CollabPhase is ${cp} (active) but run is ${runSt}` });
    }
  }

  return violations;
}
