/**
 * Worker Skill Registry — registers all skill worker contributions.
 */
import { registerWorkerContribution } from "../lib/workerSkillContract";
import { knowledgeRagWorker } from "./knowledge-rag";
import { channelGatewayWorker } from "./channel-gateway";
import { notificationOutboxWorker } from "./notification-outbox";
import { subscriptionRunnerWorker } from "./subscription-runner";
import { triggerEngineWorker } from "./trigger-engine";
import { mediaPipelineWorker } from "./media-pipeline";
import { deviceRuntimeWorker } from "./device-runtime";
import { aiEventReasoningWorker } from "./ai-event-reasoning-contrib";

export function initWorkerSkills(): void {
  registerWorkerContribution(knowledgeRagWorker);
  registerWorkerContribution(channelGatewayWorker);
  registerWorkerContribution(notificationOutboxWorker);
  registerWorkerContribution(subscriptionRunnerWorker);
  registerWorkerContribution(triggerEngineWorker);
  registerWorkerContribution(mediaPipelineWorker);
  registerWorkerContribution(deviceRuntimeWorker);
  registerWorkerContribution(aiEventReasoningWorker);
}
