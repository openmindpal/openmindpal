/**
 * Worker Skill Contribution Contract.
 *
 * Allows built-in skills to declare their worker-side handlers:
 * - Job processors (BullMQ job handlers)
 * - Tickers (setInterval-based periodic tasks)
 *
 * The worker's index.ts uses this to auto-discover skill worker handlers
 * instead of hardcoding all imports and registrations.
 */
import type { Pool } from "pg";
import type { Queue } from "bullmq";

/** A BullMQ job handler contributed by a skill. */
export interface SkillJobHandler {
  /** Job kind to match (e.g. "knowledge.index", "media.process"). */
  kind: string;
  /** Process the job. */
  process: (ctx: { pool: Pool; data: any; queue: Queue }) => Promise<void>;
}

/** A periodic ticker contributed by a skill. */
export interface SkillTicker {
  /** Human-readable name for logging. */
  name: string;
  /** Interval in milliseconds. */
  intervalMs: number;
  /** Tick function. */
  tick: (ctx: { pool: Pool; queue: Queue }) => Promise<void>;
}

/** Worker-side contribution from a built-in skill. */
export interface WorkerSkillContribution {
  /** Skill name (must match BuiltinSkillPlugin manifest identity.name). */
  skillName: string;
  /** Job handlers for BullMQ. */
  jobs?: SkillJobHandler[];
  /** Periodic tickers. */
  tickers?: SkillTicker[];
}

const _workerContributions = new Map<string, WorkerSkillContribution>();

export function registerWorkerContribution(c: WorkerSkillContribution): void {
  if (_workerContributions.has(c.skillName)) {
    throw new Error(`Duplicate worker contribution: ${c.skillName}`);
  }
  _workerContributions.set(c.skillName, c);
}

export function getWorkerContributions(): ReadonlyMap<string, WorkerSkillContribution> {
  return _workerContributions;
}
