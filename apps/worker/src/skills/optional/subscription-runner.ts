import type { WorkerSkillContribution } from "../../lib/workerSkillContract";
import { tickSubscriptions } from "../../subscriptions/ticker";

function resolveMasterKey() {
  const v = String(process.env.API_MASTER_KEY ?? "").trim();
  if (v) return v;
  if (process.env.NODE_ENV === "production") return "";
  return "dev-master-key-change-me";
}

export const subscriptionRunnerWorker: WorkerSkillContribution = {
  skillName: "subscription.runner",
  tickers: [
    { name: "subscription.tick", intervalMs: 5_000, tick: async ({ pool }) => { await tickSubscriptions({ pool, masterKey: resolveMasterKey() }); } },
  ],
};
