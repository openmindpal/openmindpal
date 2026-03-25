import type { WorkerSkillContribution } from "../lib/workerSkillContract";
import { tickTriggers } from "../triggers/ticker";

export const triggerEngineWorker: WorkerSkillContribution = {
  skillName: "trigger.engine",
  tickers: [
    { name: "trigger.tick", intervalMs: 5_000, tick: async ({ pool, queue }) => { await tickTriggers({ pool, queue }); } },
  ],
};
