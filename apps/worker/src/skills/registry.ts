/**
 * Worker Skill Registry — registers all skill worker contributions.
 *
 * Supports explicit enablement control via environment variable:
 *   DISABLED_WORKER_SKILLS: Comma-separated list of skill keys to disable.
 *     - "none" (default): All skills enabled
 *     - "all": All skills disabled
 *     - "media.pipeline,ai.event.reasoning": Specific skills disabled
 *
 * Worker Skill Keys:
 *   - knowledge.rag         (core, always enabled)
 *   - channel.gateway       (core, always enabled)
 *   - notification.outbox   (optional)
 *   - subscription.runner   (optional)
 *   - trigger.engine        (core, always enabled)
 *   - media.pipeline        (optional)
 *   - device.runtime        (optional)
 *   - ai.event.reasoning    (optional)
 */
import { registerWorkerContribution, type WorkerSkillContribution } from "../lib/workerSkillContract";

// ── Core Worker Skills (kernel-level, always enabled) ──────────────────
import {
  knowledgeRagWorker,
  channelGatewayWorker,
  triggerEngineWorker,
} from "./core";

// ── Optional Worker Skills (can be disabled via DISABLED_WORKER_SKILLS) ──
import {
  notificationOutboxWorker,
  subscriptionRunnerWorker,
  mediaPipelineWorker,
  deviceRuntimeWorker,
  aiEventReasoningWorker,
} from "./optional";

// ────────────────────────────────────────────────────────────────
// Skill Tier Classification
// ────────────────────────────────────────────────────────────────

/** 核心 Worker 能力 — 始终注册，不可禁用 */
export const CORE_WORKER_SKILL_KEYS = [
  "knowledge.rag",
  "channel.gateway",
  "trigger.engine",
] as const;

/** 可选 Worker 能力 — 默认启用，可通过 DISABLED_WORKER_SKILLS 禁用 */
export const OPTIONAL_WORKER_SKILL_KEYS = [
  "notification.outbox",
  "subscription.runner",
  "media.pipeline",
  "device.runtime",
  "ai.event.reasoning",
] as const;

export type WorkerSkillKey = typeof CORE_WORKER_SKILL_KEYS[number] | typeof OPTIONAL_WORKER_SKILL_KEYS[number];

// ────────────────────────────────────────────────────────────────
// Configuration Parsing
// ────────────────────────────────────────────────────────────────

/**
 * 解析禁用的 Worker Skill 列表。
 * 格式: 逗号分隔的 skill key，如 "media.pipeline,ai.event.reasoning"
 * 特殊值: "none" = 全部启用（默认），"all" = 禁用所有可选项
 */
function parseDisabledWorkerSkills(env?: Record<string, string | undefined>): Set<string> {
  const raw = String((env ?? process.env).DISABLED_WORKER_SKILLS ?? "").trim();
  if (!raw || raw === "none") return new Set();
  if (raw === "all") return new Set(OPTIONAL_WORKER_SKILL_KEYS);
  return new Set(raw.split(/[;,]/g).map((s) => s.trim()).filter(Boolean));
}

// ────────────────────────────────────────────────────────────────
// Skill Registration
// ────────────────────────────────────────────────────────────────

export interface WorkerSkillRegistrationResult {
  registered: string[];
  skipped: string[];
  coreCount: number;
  optionalCount: number;
}

/**
 * 初始化 Worker Skill 贡献，支持显式启用控制。
 */
export function initWorkerSkills(env?: Record<string, string | undefined>): WorkerSkillRegistrationResult {
  const disabledSkills = parseDisabledWorkerSkills(env);
  const registered: string[] = [];
  const skipped: string[] = [];

  // ── Core Worker Skills (always registered) ──
  const coreSkills: Array<[string, WorkerSkillContribution]> = [
    ["knowledge.rag", knowledgeRagWorker],
    ["channel.gateway", channelGatewayWorker],
    ["trigger.engine", triggerEngineWorker],
  ];
  for (const [key, contrib] of coreSkills) {
    registerWorkerContribution(contrib);
    registered.push(key);
  }

  // ── Optional Worker Skills (can be disabled) ──
  const optionalSkills: Array<[string, WorkerSkillContribution]> = [
    ["notification.outbox", notificationOutboxWorker],
    ["subscription.runner", subscriptionRunnerWorker],
    ["media.pipeline", mediaPipelineWorker],
    ["device.runtime", deviceRuntimeWorker],
    ["ai.event.reasoning", aiEventReasoningWorker],
  ];
  for (const [key, contrib] of optionalSkills) {
    if (!disabledSkills.has(key)) {
      registerWorkerContribution(contrib);
      registered.push(key);
    } else {
      console.log(`[worker-registry] optional skill skipped: ${key}`);
      skipped.push(key);
    }
  }

  return {
    registered,
    skipped,
    coreCount: coreSkills.length,
    optionalCount: registered.length - coreSkills.length,
  };
}
