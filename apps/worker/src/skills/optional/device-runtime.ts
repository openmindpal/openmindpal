import type { WorkerSkillContribution } from "../../lib/workerSkillContract";
import { tickDeviceExecutionResume } from "../../devices/resumeTicker";

export const deviceRuntimeWorker: WorkerSkillContribution = {
  skillName: "device.runtime",
  tickers: [
    { name: "device.execution.resume", intervalMs: 3_000, tick: async ({ pool, queue }) => { await tickDeviceExecutionResume({ pool, queue }); } },
  ],
};
