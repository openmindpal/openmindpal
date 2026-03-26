/**
 * AI Event Reasoning — Worker Skill Contribution.
 *
 * Registers:
 * - Ticker: scans unprocessed events and enqueues reasoning jobs (every 10s)
 * - Job handler: processes "event.reasoning" BullMQ jobs
 */
import type { WorkerSkillContribution } from "../../lib/workerSkillContract";
import { tickEventReasoning, processEventReasoningJob } from "./ai-event-reasoning";

export const aiEventReasoningWorker: WorkerSkillContribution = {
  skillName: "ai.event.reasoning",
  tickers: [
    {
      name: "event-reasoning.tick",
      intervalMs: 10_000,
      tick: async ({ pool, queue }) => {
        await tickEventReasoning({ pool, queue });
      },
    },
  ],
  jobs: [
    {
      kind: "event.reasoning",
      process: async ({ pool, data, queue }) => {
        await processEventReasoningJob({ pool, queue, data });
      },
    },
  ],
};
