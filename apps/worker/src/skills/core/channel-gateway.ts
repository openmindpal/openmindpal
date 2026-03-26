import type { WorkerSkillContribution } from "../../lib/workerSkillContract";
import { tickWebhookDeliveries } from "../../channels/webhookDelivery";
import { tickChannelOutboxDeliveries } from "../../channels/outboxDelivery";

function resolveMasterKey() {
  const v = String(process.env.API_MASTER_KEY ?? "").trim();
  if (v) return v;
  if (process.env.NODE_ENV === "production") return "";
  return "dev-master-key-change-me";
}

export const channelGatewayWorker: WorkerSkillContribution = {
  skillName: "channel.gateway",
  tickers: [
    { name: "channel.webhook.delivery", intervalMs: 2_000, tick: async ({ pool }) => { await tickWebhookDeliveries({ pool }); } },
    { name: "channel.outbox.delivery", intervalMs: 2_000, tick: async ({ pool }) => { await tickChannelOutboxDeliveries({ pool, masterKey: resolveMasterKey() }); } },
  ],
};
