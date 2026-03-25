/**
 * configRegistry.ts — 统一配置注册表
 *
 * 所有环境变量的唯一注册来源。每个变量携带元数据：
 * - level: bootstrap（启动时固定，需重启）| runtime（运行时可变，可热更新）
 * - scope: 该变量影响的应用组件
 * - default: 默认值
 * - sensitive: 是否敏感（不可明文日志输出）
 * - runtimeMutable: runtime 级变量是否可通过 governance control plane 热更新
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 配置级别 */
export type ConfigLevel = "bootstrap" | "runtime";

/** 配置所属应用范围 */
export type ConfigScope = "api" | "worker" | "shared" | "runner";

/** 配置值类型 */
export type ConfigValueType = "string" | "number" | "boolean" | "string[]";

/** 单条配置条目元数据 */
export interface ConfigEntry {
  /** 环境变量名 */
  envKey: string;
  /** 配置级别 */
  level: ConfigLevel;
  /** 配置值类型 */
  valueType: ConfigValueType;
  /** 默认值（字符串形式，undefined 表示无默认值必须提供） */
  defaultValue?: string;
  /** 影响的应用范围 */
  scopes: ConfigScope[];
  /** 是否敏感（密钥/密码等） */
  sensitive: boolean;
  /** runtime 级是否可通过 governance control plane 热更新 */
  runtimeMutable: boolean;
  /** 人类可读描述 */
  description: string;
  /** 可选：已知合法值枚举 */
  validValues?: string[];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const CONFIG_REGISTRY: readonly ConfigEntry[] = [
  // =========================================================================
  // BOOTSTRAP — 基础设施 / 连接
  // =========================================================================
  {
    envKey: "NODE_ENV",
    level: "bootstrap",
    valueType: "string",
    defaultValue: "development",
    scopes: ["api", "worker"],
    sensitive: false,
    runtimeMutable: false,
    description: "运行环境 (development / production / test)",
    validValues: ["development", "production", "test"],
  },
  {
    envKey: "POSTGRES_HOST",
    level: "bootstrap",
    valueType: "string",
    defaultValue: "127.0.0.1",
    scopes: ["api", "worker"],
    sensitive: false,
    runtimeMutable: false,
    description: "PostgreSQL 主机地址",
  },
  {
    envKey: "POSTGRES_PORT",
    level: "bootstrap",
    valueType: "number",
    defaultValue: "5432",
    scopes: ["api", "worker"],
    sensitive: false,
    runtimeMutable: false,
    description: "PostgreSQL 端口",
  },
  {
    envKey: "POSTGRES_DB",
    level: "bootstrap",
    valueType: "string",
    defaultValue: "openslin",
    scopes: ["api", "worker"],
    sensitive: false,
    runtimeMutable: false,
    description: "PostgreSQL 数据库名",
  },
  {
    envKey: "POSTGRES_USER",
    level: "bootstrap",
    valueType: "string",
    defaultValue: "openslin",
    scopes: ["api", "worker"],
    sensitive: false,
    runtimeMutable: false,
    description: "PostgreSQL 用户名",
  },
  {
    envKey: "POSTGRES_PASSWORD",
    level: "bootstrap",
    valueType: "string",
    defaultValue: "openslin",
    scopes: ["api", "worker"],
    sensitive: true,
    runtimeMutable: false,
    description: "PostgreSQL 密码",
  },
  {
    envKey: "REDIS_HOST",
    level: "bootstrap",
    valueType: "string",
    defaultValue: "127.0.0.1",
    scopes: ["api", "worker"],
    sensitive: false,
    runtimeMutable: false,
    description: "Redis 主机地址",
  },
  {
    envKey: "REDIS_PORT",
    level: "bootstrap",
    valueType: "number",
    defaultValue: "6379",
    scopes: ["api", "worker"],
    sensitive: false,
    runtimeMutable: false,
    description: "Redis 端口",
  },
  {
    envKey: "API_MASTER_KEY",
    level: "bootstrap",
    valueType: "string",
    scopes: ["api", "worker"],
    sensitive: true,
    runtimeMutable: false,
    description: "主加密密钥（生产环境必填）",
  },
  {
    envKey: "MEDIA_FS_ROOT_DIR",
    level: "bootstrap",
    valueType: "string",
    defaultValue: "var/media",
    scopes: ["worker"],
    sensitive: false,
    runtimeMutable: false,
    description: "媒体文件存储根目录",
  },

  // =========================================================================
  // BOOTSTRAP — 认证
  // =========================================================================
  {
    envKey: "AUTHN_MODE",
    level: "bootstrap",
    valueType: "string",
    defaultValue: "dev",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: false,
    description: "认证模式",
    validValues: ["dev", "pat", "hmac"],
  },
  {
    envKey: "AUTHN_HMAC_SECRET",
    level: "bootstrap",
    valueType: "string",
    scopes: ["api"],
    sensitive: true,
    runtimeMutable: false,
    description: "HMAC 认证密钥",
  },
  {
    envKey: "AUTHN_PAT_COMPAT_MODE",
    level: "bootstrap",
    valueType: "string",
    defaultValue: "",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: false,
    description: "PAT 兼容模式",
  },

  // =========================================================================
  // BOOTSTRAP — 可观测性
  // =========================================================================
  {
    envKey: "OTEL_ENABLED",
    level: "bootstrap",
    valueType: "boolean",
    defaultValue: "false",
    scopes: ["api", "worker"],
    sensitive: false,
    runtimeMutable: false,
    description: "OpenTelemetry 链路追踪开关",
  },

  // =========================================================================
  // BOOTSTRAP — Skill 包路径 / 签名
  // =========================================================================
  {
    envKey: "SKILL_PACKAGE_ROOTS",
    level: "bootstrap",
    valueType: "string",
    defaultValue: "",
    scopes: ["api", "worker"],
    sensitive: false,
    runtimeMutable: false,
    description: "Skill 包搜索路径（逗号分隔）",
  },
  {
    envKey: "SKILL_REGISTRY_DIR",
    level: "bootstrap",
    valueType: "string",
    defaultValue: "",
    scopes: ["api", "worker"],
    sensitive: false,
    runtimeMutable: false,
    description: "Skill 注册表目录",
  },
  {
    envKey: "SKILL_TRUSTED_PUBKEYS_JSON",
    level: "bootstrap",
    valueType: "string",
    defaultValue: "",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: false,
    description: "受信任的 Skill 签名公钥 (JSON 数组)",
  },
  {
    envKey: "SKILL_TRUSTED_PUBKEY_PEM",
    level: "bootstrap",
    valueType: "string",
    defaultValue: "",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: false,
    description: "受信任的 Skill 签名公钥 (PEM)",
  },
  {
    envKey: "SKILL_RUNTIME_SIGNING_KEY_ID",
    level: "bootstrap",
    valueType: "string",
    defaultValue: "",
    scopes: ["worker"],
    sensitive: false,
    runtimeMutable: false,
    description: "Runner 请求签名密钥 ID",
  },
  {
    envKey: "SKILL_RUNTIME_SIGNING_PRIVATE_KEY_PEM",
    level: "bootstrap",
    valueType: "string",
    defaultValue: "",
    scopes: ["worker"],
    sensitive: true,
    runtimeMutable: false,
    description: "Runner 请求签名私钥 (PEM)",
  },

  // =========================================================================
  // BOOTSTRAP — 知识库 / 向量存储
  // =========================================================================
  {
    envKey: "KNOWLEDGE_VECTOR_STORE_MODE",
    level: "bootstrap",
    valueType: "string",
    defaultValue: "",
    scopes: ["worker"],
    sensitive: false,
    runtimeMutable: false,
    description: "向量存储后端模式 (qdrant / pgvector / minhash 等)",
  },
  {
    envKey: "KNOWLEDGE_VECTOR_STORE_ENDPOINT",
    level: "bootstrap",
    valueType: "string",
    defaultValue: "",
    scopes: ["worker"],
    sensitive: false,
    runtimeMutable: false,
    description: "向量存储服务端点",
  },
  {
    envKey: "KNOWLEDGE_VECTOR_STORE_BEARER_TOKEN",
    level: "bootstrap",
    valueType: "string",
    defaultValue: "",
    scopes: ["worker"],
    sensitive: true,
    runtimeMutable: false,
    description: "向量存储认证 Token",
  },

  // =========================================================================
  // BOOTSTRAP — 联邦
  // =========================================================================
  {
    envKey: "FEDERATION_MODE",
    level: "bootstrap",
    valueType: "string",
    defaultValue: "disabled",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: false,
    description: "联邦模式 (disabled / enabled)",
    validValues: ["disabled", "enabled"],
  },
  {
    envKey: "FEDERATION_PROVIDER",
    level: "bootstrap",
    valueType: "string",
    defaultValue: "",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: false,
    description: "联邦提供商标识",
  },

  // =========================================================================
  // RUNTIME — Skill 运行时策略（可热更新）
  // =========================================================================
  {
    envKey: "SKILL_RUNTIME_BACKEND",
    level: "runtime",
    valueType: "string",
    defaultValue: "auto",
    scopes: ["worker"],
    sensitive: false,
    runtimeMutable: true,
    description: "Skill 运行时后端偏好 (process / container / remote / auto)",
    validValues: ["process", "container", "remote", "auto"],
  },
  {
    envKey: "SKILL_RUNTIME_CONTAINER_IMAGE",
    level: "runtime",
    valueType: "string",
    defaultValue: "node:20-alpine",
    scopes: ["worker"],
    sensitive: false,
    runtimeMutable: true,
    description: "容器运行时默认镜像",
  },
  {
    envKey: "SKILL_RUNTIME_CONTAINER_USER",
    level: "runtime",
    valueType: "string",
    defaultValue: "1000:1000",
    scopes: ["worker"],
    sensitive: false,
    runtimeMutable: true,
    description: "容器运行时默认用户",
  },
  {
    envKey: "SKILL_RUNTIME_REMOTE_ENDPOINT",
    level: "runtime",
    valueType: "string",
    defaultValue: "",
    scopes: ["api", "worker"],
    sensitive: false,
    runtimeMutable: true,
    description: "远程 Runner 端点覆盖",
  },
  {
    envKey: "SKILL_RUNTIME_CONTAINER_FALLBACK",
    level: "runtime",
    valueType: "boolean",
    defaultValue: "false",
    scopes: ["worker"],
    sensitive: false,
    runtimeMutable: true,
    description: "容器隔离失败时是否回退到 process 模式（生产默认禁止）",
  },
  {
    envKey: "SKILL_RUNTIME_UNSAFE_ALLOW",
    level: "runtime",
    valueType: "boolean",
    defaultValue: "false",
    scopes: ["worker"],
    sensitive: false,
    runtimeMutable: true,
    description: "是否允许不安全的 Skill 运行时（绕过隔离检查）",
  },
  {
    envKey: "SKILL_ISOLATION_MIN",
    level: "runtime",
    valueType: "string",
    defaultValue: "process",
    scopes: ["api", "worker"],
    sensitive: false,
    runtimeMutable: true,
    description: "最低隔离级别 (process / container / remote)",
    validValues: ["process", "container", "remote"],
  },
  {
    envKey: "SKILL_SBOM_MODE",
    level: "runtime",
    valueType: "string",
    defaultValue: "audit_only",
    scopes: ["api", "worker"],
    sensitive: false,
    runtimeMutable: true,
    description: "SBOM 验证模式 (deny / audit_only / skip)",
    validValues: ["deny", "audit_only", "skip"],
  },
  {
    envKey: "SKILL_DEP_SCAN_MODE",
    level: "runtime",
    valueType: "string",
    defaultValue: "audit_only",
    scopes: ["api", "worker"],
    sensitive: false,
    runtimeMutable: true,
    description: "依赖扫描模式 (deny / audit_only / skip)",
    validValues: ["deny", "audit_only", "skip"],
  },
  {
    envKey: "SKILL_TRUST_ENFORCE",
    level: "runtime",
    valueType: "boolean",
    defaultValue: "false",
    scopes: ["api", "worker"],
    sensitive: false,
    runtimeMutable: true,
    description: "是否强制签名验证（生产环境默认开启）",
  },
  {
    envKey: "SKILL_DEP_SCAN_FAKE_JSON",
    level: "runtime",
    valueType: "string",
    defaultValue: "",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: false,
    description: "开发用：伪造依赖扫描结果 JSON",
  },
  {
    envKey: "ENABLED_EXTENSIONS",
    level: "runtime",
    valueType: "string",
    defaultValue: "",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: true,
    description: "启用的扩展列表（逗号分隔）",
  },

  // =========================================================================
  // RUNTIME — 编排器参数（可热更新）
  // =========================================================================
  {
    envKey: "ORCHESTRATOR_CONVERSATION_WINDOW",
    level: "runtime",
    valueType: "number",
    defaultValue: "16",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: true,
    description: "对话上下文窗口大小（消息条数）",
  },
  {
    envKey: "ORCHESTRATOR_CONVERSATION_TTL_DAYS",
    level: "runtime",
    valueType: "number",
    defaultValue: "7",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: true,
    description: "对话 TTL（天数）",
  },
  {
    envKey: "ORCHESTRATOR_MEMORY_RECALL_LIMIT",
    level: "runtime",
    valueType: "number",
    defaultValue: "5",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: true,
    description: "记忆召回条数上限",
  },

  // =========================================================================
  // RUNTIME — 安全预检
  // =========================================================================
  {
    envKey: "SAFETY_PRE_CHECK_ENABLED",
    level: "runtime",
    valueType: "boolean",
    defaultValue: "true",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: true,
    description: "安全预检开关",
  },
  {
    envKey: "SAFETY_PRE_CHECK_LLM_TIMEOUT_MS",
    level: "runtime",
    valueType: "number",
    defaultValue: "8000",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: true,
    description: "安全预检 LLM 超时(ms)",
  },

  // =========================================================================
  // RUNTIME — 模型 / 嵌入
  // =========================================================================
  {
    envKey: "MODEL_USD_PER_1K_TOKENS",
    level: "runtime",
    valueType: "number",
    defaultValue: "0",
    scopes: ["worker"],
    sensitive: false,
    runtimeMutable: true,
    description: "模型费用（每 1K tokens 美元）",
  },
  {
    envKey: "KNOWLEDGE_EMBEDDING_MODEL_REF",
    level: "runtime",
    valueType: "string",
    defaultValue: "minhash:16@1",
    scopes: ["worker"],
    sensitive: false,
    runtimeMutable: true,
    description: "知识嵌入模型引用",
  },
  {
    envKey: "KNOWLEDGE_VECTOR_STORE_TIMEOUT_MS",
    level: "runtime",
    valueType: "number",
    defaultValue: "1500",
    scopes: ["worker"],
    sensitive: false,
    runtimeMutable: true,
    description: "向量存储超时(ms)",
  },

  // =========================================================================
  // RUNTIME — 授权策略
  // =========================================================================
  {
    envKey: "AUTHZ_ROW_FILTER_MERGE_MODE",
    level: "runtime",
    valueType: "string",
    defaultValue: "",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: true,
    description: "行级过滤合并模式",
  },
  {
    envKey: "AUTHZ_ROW_FILTER_CONSERVATIVE_RESOURCE_TYPES",
    level: "runtime",
    valueType: "string",
    defaultValue: "",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: true,
    description: "保守行级过滤的资源类型列表（逗号分隔）",
  },

  // =========================================================================
  // RUNTIME — 运维 / 告警阈值
  // =========================================================================
  {
    envKey: "AUDIT_OUTBOX_DISPATCHER",
    level: "bootstrap",
    valueType: "boolean",
    defaultValue: "true",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: false,
    description: "审计 Outbox 调度器开关",
  },
  {
    envKey: "AUDIT_OUTBOX_INTERVAL_MS",
    level: "runtime",
    valueType: "number",
    defaultValue: "1000",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: true,
    description: "审计 Outbox 轮询间隔(ms)",
  },
  {
    envKey: "AUDIT_OUTBOX_BATCH",
    level: "runtime",
    valueType: "number",
    defaultValue: "50",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: true,
    description: "审计 Outbox 批量大小",
  },
  {
    envKey: "AUDIT_OUTBOX_BACKLOG_INTERVAL_MS",
    level: "runtime",
    valueType: "number",
    defaultValue: "10000",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: true,
    description: "审计 Outbox 积压检查间隔(ms)",
  },
  {
    envKey: "ALERT_OUTBOX_BACKLOG_THRESHOLD",
    level: "runtime",
    valueType: "number",
    defaultValue: "500",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: true,
    description: "Outbox 积压告警阈值",
  },
  {
    envKey: "ALERT_OUTBOX_DEADLETTER_THRESHOLD",
    level: "runtime",
    valueType: "number",
    defaultValue: "10",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: true,
    description: "Outbox 死信告警阈值",
  },
  {
    envKey: "WORKFLOW_QUEUE_BACKLOG_INTERVAL_MS",
    level: "runtime",
    valueType: "number",
    defaultValue: "10000",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: true,
    description: "工作流队列积压检查间隔(ms)",
  },
  {
    envKey: "ALERT_QUEUE_BACKLOG_THRESHOLD",
    level: "runtime",
    valueType: "number",
    defaultValue: "1000",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: true,
    description: "工作流队列积压告警阈值",
  },
  {
    envKey: "COLLAB_BACKLOG_INTERVAL_MS",
    level: "runtime",
    valueType: "number",
    defaultValue: "10000",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: true,
    description: "协作运行时积压检查间隔(ms)",
  },
  {
    envKey: "WORKER_METRICS_INTERVAL_MS",
    level: "runtime",
    valueType: "number",
    defaultValue: "10000",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: true,
    description: "Worker 指标采集间隔(ms)",
  },
  {
    envKey: "REGRESSION_EVAL_INTERVAL_MS",
    level: "runtime",
    valueType: "number",
    defaultValue: "300000",
    scopes: ["worker"],
    sensitive: false,
    runtimeMutable: true,
    description: "回归评估间隔(ms)",
  },
  {
    envKey: "WORKFLOW_SEAL_MODE",
    level: "runtime",
    valueType: "string",
    defaultValue: "",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: true,
    description: "工作流封存模式",
  },
  {
    envKey: "EVAL_ADMISSION_REQUIRED_KINDS",
    level: "runtime",
    valueType: "string",
    defaultValue: "tool.set_active,tool.enable,policy.,model_routing.,schema.",
    scopes: ["api"],
    sensitive: false,
    runtimeMutable: true,
    description: "需要评估准入的变更类型（逗号分隔前缀）",
  },
  {
    envKey: "SECRETS_ROTATION_GRACE_SEC",
    level: "runtime",
    valueType: "number",
    defaultValue: "86400",
    scopes: ["worker"],
    sensitive: false,
    runtimeMutable: true,
    description: "密钥轮换宽限期(秒)",
  },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 按级别筛选 */
export function getConfigsByLevel(level: ConfigLevel): ConfigEntry[] {
  return CONFIG_REGISTRY.filter((e) => e.level === level);
}

/** 按应用范围筛选 */
export function getConfigsByScope(scope: ConfigScope): ConfigEntry[] {
  return CONFIG_REGISTRY.filter((e) => e.scopes.includes(scope));
}

/** 获取所有可通过 governance 热更新的 runtime 配置 */
export function getRuntimeMutableConfigs(): ConfigEntry[] {
  return CONFIG_REGISTRY.filter((e) => e.level === "runtime" && e.runtimeMutable);
}

/** 按 envKey 查找 */
export function findConfigEntry(envKey: string): ConfigEntry | undefined {
  return CONFIG_REGISTRY.find((e) => e.envKey === envKey);
}

/** 解析 env 字符串值为目标类型 */
export function parseConfigValue(entry: ConfigEntry, raw: string | undefined): string | number | boolean | string[] | undefined {
  const v = raw?.trim();
  if (v === undefined || v === "") {
    if (entry.defaultValue !== undefined) return parseConfigValue(entry, entry.defaultValue);
    return undefined;
  }
  switch (entry.valueType) {
    case "number": return Number(v) || 0;
    case "boolean": return v === "1" || v === "true" || v === "yes";
    case "string[]": return v.split(",").map((s) => s.trim()).filter(Boolean);
    default: return v;
  }
}

/** 验证 env 值是否在合法范围内（如果有定义 validValues） */
export function validateConfigValue(entry: ConfigEntry, raw: string | undefined): { valid: boolean; reason?: string } {
  if (!entry.validValues || entry.validValues.length === 0) return { valid: true };
  const v = (raw ?? "").trim();
  if (!v && entry.defaultValue !== undefined) return { valid: true };
  if (!v) return { valid: true }; // 空值由 required 逻辑处理
  if (!entry.validValues.includes(v)) {
    return { valid: false, reason: `${entry.envKey}="${v}" not in [${entry.validValues.join(", ")}]` };
  }
  return { valid: true };
}
