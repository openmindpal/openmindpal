/**
 * Unified Runtime State Machine (P1-8).
 *
 * Re-exports from @openslin/shared so both API and Worker can use the
 * same state machine definitions.
 */
export {
  STEP_STATUSES, STEP_TERMINAL, STEP_BLOCKING, STEP_TRANSITIONS,
  RUN_STATUSES, RUN_TERMINAL, RUN_TRANSITIONS,
  COLLAB_PHASES, COLLAB_TERMINAL, COLLAB_TRANSITIONS,
  transitionStep, transitionRun, transitionCollab,
  tryTransitionStep, tryTransitionRun, tryTransitionCollab,
  normalizeStepStatus, normalizeRunStatus, normalizeCollabPhase,
  checkStateInvariant,
} from "@openslin/shared";
export type {
  StepStatus, RunStatus, CollabPhase,
  TransitionViolation, TransitionResult, StateInvariantViolation,
} from "@openslin/shared";

