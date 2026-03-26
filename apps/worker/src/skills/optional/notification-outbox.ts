import type { WorkerSkillContribution } from "../../lib/workerSkillContract";
import { tickEmailDeliveries } from "../../notifications/smtpDelivery";

export const notificationOutboxWorker: WorkerSkillContribution = {
  skillName: "notification.outbox",
  tickers: [
    { name: "notification.email.delivery", intervalMs: 2_000, tick: async ({ pool }) => { await tickEmailDeliveries({ pool }); } },
  ],
};
