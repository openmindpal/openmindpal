export type Locale = "zh-CN" | "en-US" | (string & {});

export type I18nText = Record<string, string>;

export type I18nContext = {
  userLocale?: string;
  spaceLocale?: string;
  tenantLocale?: string;
  platformLocale?: string;
};

export function resolveLocale(ctx: I18nContext): string {
  return (
    ctx.userLocale ||
    ctx.spaceLocale ||
    ctx.tenantLocale ||
    ctx.platformLocale ||
    "zh-CN"
  );
}

export function t(text: I18nText | string | undefined, locale: string): string {
  if (!text) return "";
  if (typeof text === "string") return text;
  return text[locale] ?? text["zh-CN"] ?? Object.values(text)[0] ?? "";
}

export type ErrorResponse = {
  errorCode: string;
  message: I18nText;
  traceId?: string;
};

export type PolicyRef = {
  name: string;
  version: number;
};

export type PolicyVersionState = "draft" | "released" | "deprecated";

export type PolicyVersion = {
  id: string;
  tenantId: string;
  name: string;
  version: number;
  status: PolicyVersionState;
  policyJson: unknown;
  digest: string;
  createdAt: string;
  publishedAt: string | null;
};

export type FieldRuleSide = {
  allow?: string[];
  deny?: string[];
};

export type FieldRulesV1 = {
  read?: FieldRuleSide;
  write?: FieldRuleSide;
};

export type ConditionalFieldRule = {
  condition?: unknown;   // AbacCondition-style; when null → always applies
  fieldRules: FieldRulesV1;
};

export type RowFilterKind =
  | { kind: "owner_only" }
  | { kind: "payload_field_eq_subject"; field: string }
  | { kind: "payload_field_eq_literal"; field: string; value: string | number | boolean }
  | { kind: "space_member"; roles?: string[] }
  | { kind: "org_hierarchy"; orgField: string; includeDescendants: boolean }
  | { kind: "expr"; expr: unknown }
  | { kind: "or"; rules: RowFilterKind[] }
  | { kind: "and"; rules: RowFilterKind[] }
  | { kind: "not"; rule: RowFilterKind };

export type PolicyDecision = {
  decision: "allow" | "deny";
  reason?: string;
  matchedRules?: unknown;
  rowFilters?: RowFilterKind | unknown;
  fieldRules?: FieldRulesV1;
  conditionalFieldRules?: ConditionalFieldRule[];
  snapshotRef?: string;
  policyRef?: PolicyRef;
  policyCacheEpoch?: unknown;
  explainV1?: unknown;
  abacResult?: unknown;
};

export type PolicySnapshotExplainView = {
  snapshotId: string;
  tenantId: string;
  spaceId: string | null;
  resourceType: string;
  action: string;
  decision: "allow" | "deny";
  reason: string | null;
  matchedRules: unknown;
  rowFilters: unknown;
  fieldRules: unknown;
  createdAt: string;
  policyRef?: PolicyRef;
  policyCacheEpoch?: unknown;
  explainV1?: unknown;
};

export type PolicySnapshotCursor = {
  createdAt: string;
  snapshotId: string;
};

export type PolicySnapshotSummary = {
  snapshotId: string;
  tenantId: string;
  spaceId: string | null;
  subjectId: string;
  resourceType: string;
  action: string;
  decision: "allow" | "deny";
  reason: string | null;
  rowFilters: unknown;
  fieldRules: unknown;
  createdAt: string;
  policyRef?: PolicyRef;
  policyCacheEpoch?: unknown;
};

export type { EvidenceSourceRef, EvidenceRef, EvidencePolicy, AnswerEnvelope } from "./evidence";

export type { VectorStoreModeV1, VectorStoreRefV1, VectorStoreCapabilitiesV1, VectorStoreChunkEmbeddingV1, VectorStoreQueryResultItemV1, VectorStoreQueryResponseV1 } from "./knowledgeVectorStore";

export type { SyncConflictClass, SyncConflictView, SyncMergeTranscript, SyncMergeSummary, SyncConflictTicketStatus, SyncConflictTicketSummary } from "./sync";

export type { PolicyExpr, PolicyLiteral, PolicyOperand, PolicyExprValidationResult, CompiledWhere } from "./policyExpr";
export { POLICY_EXPR_JSON_SCHEMA_V1, validatePolicyExpr, compilePolicyExprWhere } from "./policyExpr";

export { detectPromptInjection, resolvePromptInjectionPolicy, resolvePromptInjectionPolicyFromEnv, shouldDenyPromptInjection } from "./promptInjection";
export type { PromptInjectionHit, PromptInjectionHitSeverity, PromptInjectionMode, PromptInjectionPolicy, PromptInjectionScanResult } from "./promptInjection";

export { attachDlpSummary, redactString, redactValue, resolveDlpPolicy, resolveDlpPolicyFromEnv, shouldDenyDlpForTarget } from "./dlp";
export type { DlpHitType, DlpMode, DlpPolicy, DlpSummary } from "./dlp";

export { SUPPORTED_SCHEMA_MIGRATION_KINDS, isSupportedSchemaMigrationKind } from "./schemaMigration";
export type { SchemaMigrationKind } from "./schemaMigration";

export type { CapabilityEnvelopeV1, NetworkPolicyRuleV1, NetworkPolicyV1, RuntimeLimitsV1 } from "./capabilityEnvelope";
export { checkCapabilityEnvelopeNotExceedV1, normalizeNetworkPolicyV1, normalizeRuntimeLimitsV1, validateCapabilityEnvelopeV1 } from "./capabilityEnvelope";

export { AUDIT_ERROR_CATEGORIES, normalizeAuditErrorCategory } from "./audit";
export type { AuditErrorCategory } from "./audit";

export {
  STEP_STATUSES, STEP_TERMINAL, STEP_BLOCKING, STEP_TRANSITIONS,
  RUN_STATUSES, RUN_TERMINAL, RUN_TRANSITIONS,
  COLLAB_PHASES, COLLAB_TERMINAL, COLLAB_TRANSITIONS,
  transitionStep, transitionRun, transitionCollab,
  tryTransitionStep, tryTransitionRun, tryTransitionCollab,
  normalizeStepStatus, normalizeRunStatus, normalizeCollabPhase,
  checkStateInvariant,
} from "./stateMachine";
export type {
  StepStatus, RunStatus, CollabPhase,
  TransitionViolation, TransitionResult, StateInvariantViolation,
} from "./stateMachine";

export {
  CONFIG_REGISTRY,
  getConfigsByLevel, getConfigsByScope, getRuntimeMutableConfigs, findConfigEntry,
  parseConfigValue, validateConfigValue,
} from "./configRegistry";
export type { ConfigLevel, ConfigScope, ConfigValueType, ConfigEntry } from "./configRegistry";

export {
  resolveRuntimeConfig, resolveAllRuntimeConfigs,
  resolveNumber, resolveBoolean, resolveString,
  // Skill 运行时配置访问器 (P0-02)
  resolveSkillRuntimeBackend,
  resolveSkillRuntimeContainerImage,
  resolveSkillRuntimeContainerUser,
  resolveSkillRuntimeRemoteEndpoint,
  resolveSkillRuntimeContainerFallback,
  type RuntimeConfigSource, type ResolvedConfig, type RuntimeConfigOverrides, type SkillRuntimeBackend,
} from "./runtimeConfig";

export {
  resolveSupplyChainPolicy, checkTrust, checkDependencyScan, checkSbom,
  decideIsolation, supplyChainGate,
  // 生产基线校验 (P0-04)
  validateProductionBaseline,
  assertProductionBaseline,
} from "./supplyChainPolicy";
export type {
  IsolationLevel, ScanMode, DegradationStrategy, SupplyChainPolicyConfig,
  TrustCheckResult, ScanCheckResult, SbomCheckResult,
  IsolationDecision, SupplyChainGateResult,
  ProductionBaselineResult,
} from "./supplyChainPolicy";

// ─── 统一运行时模块 (P0-01) ───────────────────────────────────────────────────
export {
  isPlainObject,
  normalizeLimits,
  normalizeNetworkPolicy,
  isAllowedHost,
  isAllowedEgress,
  runtimeFetch,
  withConcurrency,
  withTimeout,
} from "./runtime";
export type {
  RuntimeLimits,
  NetworkPolicyRule,
  NetworkPolicy,
  EgressEvent,
  EgressCheck,
} from "./runtime";

// ─── Skill 沙箱基线模块 (P0-03) ───────────────────────────────────────────
export {
  SANDBOX_FORBIDDEN_MODULES_BASE,
  SANDBOX_FORBIDDEN_MODULES_STRICT,
  SANDBOX_FORBIDDEN_MODULES_DATABASE,
  resolveSandboxMode,
  buildForbiddenModulesSet,
  lockdownDynamicCodeExecution,
  restoreDynamicCodeExecution,
  pickExecute,
  checkModuleForbidden,
  createModuleLoadInterceptor,
} from "./skillSandbox";
export type {
  SandboxMode,
  DynamicCodeLockState,
} from "./skillSandbox";
