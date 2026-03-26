/**
 * Built-in Skill Registry.
 *
 * Organised into four tiers:
 *   kernel        — Core platform tool declarations, always auto-enabled
 *   core-builtin  — Essential platform capabilities, always registered
 *   opt-builtin   — Standard platform capabilities, registered by default but can be disabled
 *   extension     — Optional upper-layer capabilities, loaded on demand
 *
 * Core builtin (always registered):
 *   orchestrator, modelGateway, knowledgeRag, memoryManager,
 *   safetyPolicy, connectorManager, taskManager, channelGateway, triggerEngine
 *
 * Optional builtin (registered by default, disableable via DISABLED_BUILTIN_SKILLS):
 *   nl2uiGenerator, uiPageConfig, workbenchManager, oauthProvider, ssoProvider,
 *   notificationOutbox, subscriptionRunner, deviceRuntime, collabRuntime,
 *   syncEngine, agentRuntime, yjsCollab
 */
import { registerBuiltinSkill, sealBuiltinSkillRegistry } from "../lib/skillPlugin";
import type { BuiltinSkillPlugin, SkillLayer } from "../lib/skillPlugin";
import type { FastifyPluginAsync } from "fastify";

// ── Kernel Layer (Phase 0) ──────────────────────────────────────────
// (entityKernel is defined inline below)
// Layer structure: ./kernel/

// ── Builtin Core Layer ─────────────────────────────────────────────
// Layer structure: ./builtin/core/
import {
  orchestrator,
  modelGateway,
  knowledgeRag,
  memoryManager,
  safetyPolicy,
  connectorManager,
  taskManager,
  channelGateway,
  triggerEngine,
} from "./builtin/core";

// ── Builtin Optional Layer ─────────────────────────────────────────
// Layer structure: ./builtin/optional/
import {
  nl2uiGenerator,
  uiPageConfig,
  workbenchManager,
  oauthProvider,
  ssoProvider,
  notificationOutbox,
  subscriptionRunner,
  deviceRuntime,
  collabRuntime,
  syncEngine,
  agentRuntime,
  yjsCollab,
  skillManager,
  rbacManager,
} from "./builtin/optional";

// ── Extension Layer ────────────────────────────────────────────────
// Layer structure: ./extension/
import {
  mediaPipeline,
  backupManager,
  replayViewer,
  artifactManager,
  analyticsEngine,
  identityLink,
  userViewPrefs,
  aiEventReasoning,
} from "./extension";

/* ------------------------------------------------------------------ */
/*  Skill tier classification                                          */
/* ------------------------------------------------------------------ */

/** OS 核心能力 — 始终注册，不可禁用 */
export const CORE_BUILTIN_SKILL_KEYS = [
  "orchestrator",
  "model.gateway",
  "knowledge.rag",
  "memory.manager",
  "safety.policy",
  "connector.manager",
  "task.manager",
  "channel.gateway",
  "trigger.engine",
] as const;

/** 可选内建能力 — 默认注册，可通过 DISABLED_BUILTIN_SKILLS 禁用 */
export const OPTIONAL_BUILTIN_SKILL_KEYS = [
  "nl2ui.generator",
  "ui.page.config",
  "workbench.manager",
  "oauth.provider",
  "sso.provider",
  "notification.outbox",
  "subscription.runner",
  "device.runtime",
  "collab.runtime",
  "sync.engine",
  "agent.runtime",
  "yjs.collab",
  "skill.manager",
  "rbac.manager",
] as const;

/** 扩展层 — 默认全部启用，可通过 ENABLED_EXTENSIONS 控制 */
const DEFAULT_EXTENSIONS = new Set<string>([
  "media.pipeline",
  "backup.manager",
  "replay.viewer",
  "artifact.manager",
  "analytics.engine",
  "identity.link",
  "user.view.prefs",
  "ai.event.reasoning",
]);

function parseEnabledExtensions(): Set<string> {
  const raw = String(process.env.ENABLED_EXTENSIONS ?? "").trim();
  if (!raw || raw === "*") return DEFAULT_EXTENSIONS;
  if (raw === "none") return new Set();
  return new Set(raw.split(/[;,]/g).map((s) => s.trim()).filter(Boolean));
}

/**
 * 解析禁用的 optional builtin 列表。
 * 格式: 逗号分隔的 skill key，如 "yjs.collab,sync.engine"
 * 特殊值: "none" = 全部启用（默认），"all" = 全部禁用
 */
function parseDisabledBuiltins(): Set<string> {
  const raw = String(process.env.DISABLED_BUILTIN_SKILLS ?? "").trim();
  if (!raw || raw === "none") return new Set();
  if (raw === "all") return new Set(OPTIONAL_BUILTIN_SKILL_KEYS);
  return new Set(raw.split(/[;,]/g).map((s) => s.trim()).filter(Boolean));
}

export function initBuiltinSkills(): void {
  const disabledBuiltins = parseDisabledBuiltins();
  const enabledExtensions = parseEnabledExtensions();

  // ── Layer 0: Kernel (always registered, always auto-enabled) ──────
  registerBuiltinSkill(entityKernel);

  // ── Layer 1a: Core Builtin (always registered, not disableable) ────
  registerBuiltinSkill(orchestrator);
  registerBuiltinSkill(modelGateway);
  registerBuiltinSkill(knowledgeRag);
  registerBuiltinSkill(memoryManager);
  registerBuiltinSkill(safetyPolicy);
  registerBuiltinSkill(connectorManager);
  registerBuiltinSkill(taskManager);
  registerBuiltinSkill(channelGateway);
  registerBuiltinSkill(triggerEngine);

  // ── Layer 1b: Optional Builtin (registered unless disabled) ────────
  const optionalPlugins: Array<[string, BuiltinSkillPlugin]> = [
    ["nl2ui.generator", nl2uiGenerator],
    ["ui.page.config", uiPageConfig],
    ["workbench.manager", workbenchManager],
    ["oauth.provider", oauthProvider],
    ["sso.provider", ssoProvider],
    ["notification.outbox", notificationOutbox],
    ["subscription.runner", subscriptionRunner],
    ["device.runtime", deviceRuntime],
    ["collab.runtime", collabRuntime],
    ["sync.engine", syncEngine],
    ["agent.runtime", agentRuntime],
    ["yjs.collab", yjsCollab],
    ["skill.manager", skillManager],
    ["rbac.manager", rbacManager],
  ];
  for (const [key, plugin] of optionalPlugins) {
    if (!disabledBuiltins.has(key)) {
      registerBuiltinSkill(plugin);
    } else {
      console.log(`[registry] optional builtin skill skipped: ${key}`);
    }
  }

  // ── Layer 2: Extension (registered only when enabled) ─────────────
  const extensionPlugins: Array<[string, BuiltinSkillPlugin]> = [
    ["media.pipeline", mediaPipeline],
    ["backup.manager", backupManager],
    ["replay.viewer", replayViewer],
    ["artifact.manager", artifactManager],
    ["analytics.engine", analyticsEngine],
    ["identity.link", identityLink],
    ["user.view.prefs", userViewPrefs],
    ["ai.event.reasoning", aiEventReasoning],
  ];
  for (const [extKey, plugin] of extensionPlugins) {
    if (enabledExtensions.has(extKey)) {
      registerBuiltinSkill(plugin);
    }
  }

  // Seal the registry to prevent further registrations
  sealBuiltinSkillRegistry();
}

/**
 * Kernel entity tools — core platform operations, no HTTP routes.
 * Declared here so auto-discovery can register them as tool_definitions.
 */
const noopRoutes: FastifyPluginAsync = async () => {};
const entityKernel: BuiltinSkillPlugin = {
  manifest: {
    identity: { name: "entity.kernel", version: "1.0.0" },
    layer: "kernel",
    tools: [
      {
        name: "entity.create",
        displayName: { "zh-CN": "创建实体", "en-US": "Create entity" },
        description: { "zh-CN": "创建实体数据记录", "en-US": "Create an entity record" },
        scope: "write",
        resourceType: "entity",
        action: "create",
        idempotencyRequired: true,
        riskLevel: "high",
        approvalRequired: true,
        inputSchema: { fields: { schemaName: { type: "string" }, entityName: { type: "string", required: true }, payload: { type: "json", required: true } } },
        outputSchema: { fields: { recordId: { type: "string" }, idempotentHit: { type: "boolean" } } },
      },
      {
        name: "entity.update",
        displayName: { "zh-CN": "更新实体", "en-US": "Update entity" },
        description: { "zh-CN": "更新实体数据记录", "en-US": "Update an entity record" },
        scope: "write",
        resourceType: "entity",
        action: "update",
        idempotencyRequired: true,
        riskLevel: "high",
        approvalRequired: true,
        inputSchema: { fields: { schemaName: { type: "string" }, entityName: { type: "string", required: true }, id: { type: "string", required: true }, patch: { type: "json", required: true }, expectedRevision: { type: "number" } } },
        outputSchema: { fields: { recordId: { type: "string" }, idempotentHit: { type: "boolean" } } },
      },
      {
        name: "entity.delete",
        displayName: { "zh-CN": "删除实体", "en-US": "Delete entity" },
        description: { "zh-CN": "删除实体数据记录", "en-US": "Delete an entity record" },
        scope: "write",
        resourceType: "entity",
        action: "delete",
        idempotencyRequired: true,
        riskLevel: "high",
        approvalRequired: true,
        inputSchema: { fields: { schemaName: { type: "string" }, entityName: { type: "string", required: true }, id: { type: "string", required: true } } },
        outputSchema: { fields: { recordId: { type: "string" }, idempotentHit: { type: "boolean" }, deleted: { type: "boolean" } } },
      },
    ],
  },
  routes: noopRoutes,
};
