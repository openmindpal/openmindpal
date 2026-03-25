import type { I18nText } from "@openslin/shared";

export class AppError extends Error {
  public readonly errorCode: string;
  public readonly messageI18n: I18nText;
  public readonly httpStatus: number;

  constructor(params: {
    errorCode: string;
    message: I18nText;
    httpStatus: number;
    cause?: unknown;
  }) {
    super(params.errorCode);
    this.errorCode = params.errorCode;
    this.messageI18n = params.message;
    this.httpStatus = params.httpStatus;
    if (params.cause) (this as any).cause = params.cause;
  }
}

export function isAppError(err: unknown): err is AppError {
  return Boolean(
    err &&
      typeof err === "object" &&
      "errorCode" in err &&
      "messageI18n" in err &&
      "httpStatus" in err,
  );
}

export const Errors = {
  unauthorized: (localeFallback: string) =>
    new AppError({
      errorCode: "AUTH_UNAUTHORIZED",
      httpStatus: 401,
      message: {
        "zh-CN": "未认证",
        "en-US": "Unauthorized",
        [localeFallback]: localeFallback === "zh-CN" ? "未认证" : "Unauthorized",
      },
    }),
  forbidden: () =>
    new AppError({
      errorCode: "AUTH_FORBIDDEN",
      httpStatus: 403,
      message: {
        "zh-CN": "无权限执行该操作",
        "en-US": "Forbidden",
      },
    }),
  notFound: (detail?: string) =>
    new AppError({
      errorCode: "NOT_FOUND",
      httpStatus: 404,
      message: {
        "zh-CN": detail ? `未找到：${detail}` : "未找到",
        "en-US": detail ? `Not found: ${detail}` : "Not found",
      },
    }),
  uiConfigDenied: (detail?: string) =>
    new AppError({
      errorCode: "UI_CONFIG_DENIED",
      httpStatus: 403,
      message: {
        "zh-CN": detail ? `页面配置被拒绝：${detail}` : "页面配置被拒绝",
        "en-US": detail ? `UI config denied: ${detail}` : "UI config denied",
      },
    }),
  uiComponentRegistryDenied: (detail?: string) =>
    new AppError({
      errorCode: "UI_COMPONENT_REGISTRY_DENIED",
      httpStatus: 403,
      message: {
        "zh-CN": detail ? `组件注册表被拒绝：${detail}` : "组件注册表被拒绝",
        "en-US": detail ? `UI component registry denied: ${detail}` : "UI component registry denied",
      },
    }),
  uiComponentRegistryDraftMissing: () =>
    new AppError({
      errorCode: "UI_COMPONENT_REGISTRY_DRAFT_MISSING",
      httpStatus: 409,
      message: {
        "zh-CN": "组件注册表 draft 不存在",
        "en-US": "UI component registry draft is missing",
      },
    }),
  uiComponentRegistryNoPreviousVersion: () =>
    new AppError({
      errorCode: "UI_COMPONENT_REGISTRY_NO_PREVIOUS_VERSION",
      httpStatus: 409,
      message: {
        "zh-CN": "组件注册表无可回滚的上一版本",
        "en-US": "UI component registry has no previous version to rollback",
      },
    }),
  secretForbidden: () =>
    new AppError({
      errorCode: "SECRET_FORBIDDEN",
      httpStatus: 403,
      message: {
        "zh-CN": "禁止读取凭证明文",
        "en-US": "Secret plaintext access is forbidden",
      },
    }),
  keyDecryptFailed: () =>
    new AppError({
      errorCode: "KEY_DECRYPT_FAILED",
      httpStatus: 400,
      message: {
        "zh-CN": "密钥解密失败",
        "en-US": "Key decrypt failed",
      },
    }),
  keyDisabled: () =>
    new AppError({
      errorCode: "KEY_DISABLED",
      httpStatus: 403,
      message: {
        "zh-CN": "密钥已禁用",
        "en-US": "Key disabled",
      },
    }),
  rateLimited: () =>
    new AppError({
      errorCode: "RATE_LIMITED",
      httpStatus: 429,
      message: {
        "zh-CN": "请求过于频繁",
        "en-US": "Too many requests",
      },
    }),
  auditWriteFailed: () =>
    new AppError({
      errorCode: "AUDIT_WRITE_FAILED",
      httpStatus: 500,
      message: {
        "zh-CN": "审计写入失败",
        "en-US": "Audit write failed",
      },
    }),
  auditOutboxWriteFailed: () =>
    new AppError({
      errorCode: "AUDIT_OUTBOX_WRITE_FAILED",
      httpStatus: 500,
      message: {
        "zh-CN": "审计外盒写入失败",
        "en-US": "Audit outbox write failed",
      },
    }),
  auditOutboxRequired: () =>
    new AppError({
      errorCode: "AUDIT_OUTBOX_REQUIRED",
      httpStatus: 500,
      message: {
        "zh-CN": "写操作需要通过审计外盒落审计",
        "en-US": "Write operation requires audit outbox",
      },
    }),
  schemaNoPreviousVersion: () =>
    new AppError({
      errorCode: "SCHEMA_NO_PREVIOUS_VERSION",
      httpStatus: 409,
      message: {
        "zh-CN": "Schema 无可回滚的上一版本",
        "en-US": "Schema has no previous version to rollback",
      },
    }),
  schemaChangesetRequired: (action?: "set_active" | "rollback") =>
    new AppError({
      errorCode: "SCHEMA_CHANGESET_REQUIRED",
      httpStatus: 409,
      message: {
        "zh-CN": action ? `请通过 changeset 流程执行 schema.${action}` : "请通过 changeset 流程执行 Schema 治理变更",
        "en-US": action ? `Please run schema.${action} via changeset flow` : "Please run schema governance changes via changeset flow",
      },
    }),
  workbenchNoPreviousVersion: () =>
    new AppError({
      errorCode: "WORKBENCH_NO_PREVIOUS_VERSION",
      httpStatus: 409,
      message: {
        "zh-CN": "工作台无可回滚的上一版本",
        "en-US": "Workbench has no previous version to rollback",
      },
    }),
  workbenchManifestDenied: (detail?: string) =>
    new AppError({
      errorCode: "WORKBENCH_MANIFEST_DENIED",
      httpStatus: 403,
      message: {
        "zh-CN": detail ? `工作台 manifest 被拒绝：${detail}` : "工作台 manifest 被拒绝",
        "en-US": detail ? `Workbench manifest denied: ${detail}` : "Workbench manifest denied",
      },
    }),
  dlpDenied: () =>
    new AppError({
      errorCode: "DLP_DENIED",
      httpStatus: 403,
      message: {
        "zh-CN": "内容包含敏感信息，已被拒绝",
        "en-US": "Content contains sensitive data and was denied",
      },
    }),
  artifactTokenDenied: () =>
    new AppError({
      errorCode: "ARTIFACT_TOKEN_DENIED",
      httpStatus: 403,
      message: {
        "zh-CN": "下载令牌无效或已过期，已拒绝",
        "en-US": "Download token is invalid or expired",
      },
    }),
  safetyPromptInjectionDenied: () =>
    new AppError({
      errorCode: "SAFETY_PROMPT_INJECTION_DENIED",
      httpStatus: 403,
      message: {
        "zh-CN": "检测到提示注入风险，已拒绝执行",
        "en-US": "Potential prompt injection detected and execution was denied",
      },
    }),
  toolDisabled: () =>
    new AppError({
      errorCode: "TOOL_DISABLED",
      httpStatus: 403,
      message: {
        "zh-CN": "工具未启用，已被拒绝",
        "en-US": "Tool is disabled",
      },
    }),
  trustNotVerified: () =>
    new AppError({
      errorCode: "TRUST_NOT_VERIFIED",
      httpStatus: 403,
      message: {
        "zh-CN": "供应链信任未验证，已被拒绝",
        "en-US": "Supply chain trust not verified",
      },
    }),
  scanNotPassed: () =>
    new AppError({
      errorCode: "SCAN_NOT_PASSED",
      httpStatus: 403,
      message: {
        "zh-CN": "依赖扫描未通过，已被拒绝",
        "en-US": "Dependency scan not passed",
      },
    }),
  sbomNotPresent: () =>
    new AppError({
      errorCode: "SBOM_NOT_PRESENT",
      httpStatus: 403,
      message: {
        "zh-CN": "缺少 SBOM，已被拒绝",
        "en-US": "SBOM is missing",
      },
    }),
  isolationRequired: () =>
    new AppError({
      errorCode: "ISOLATION_REQUIRED",
      httpStatus: 403,
      message: {
        "zh-CN": "隔离级别不满足要求，已被拒绝",
        "en-US": "Isolation level requirement not met",
      },
    }),
  sealNotPresent: () =>
    new AppError({
      errorCode: "SEAL_NOT_PRESENT",
      httpStatus: 403,
      message: {
        "zh-CN": "回放来源未封存（sealed），已被拒绝",
        "en-US": "Replay source is not sealed",
      },
    }),
  replaySealRequired: () =>
    new AppError({
      errorCode: "REPLAY_SEAL_REQUIRED",
      httpStatus: 409,
      message: {
        "zh-CN": "回放需要封存（sealed）来源",
        "en-US": "Replay requires sealed source",
      },
    }),
  evalNotPassed: () =>
    new AppError({
      errorCode: "EVAL_NOT_PASSED",
      httpStatus: 403,
      message: {
        "zh-CN": "评测未通过，已拒绝发布",
        "en-US": "Evaluation not passed",
      },
    }),
  evalAdmissionPending: () =>
    new AppError({
      errorCode: "EVAL_ADMISSION_PENDING",
      httpStatus: 409,
      message: {
        "zh-CN": "评测准入未满足，请先完成评测",
        "en-US": "Evaluation admission pending",
      },
    }),
  contractNotCompatible: (detail?: string) =>
    new AppError({
      errorCode: "CONTRACT_NOT_COMPATIBLE",
      httpStatus: 403,
      message: {
        "zh-CN": detail ? `契约兼容性校验失败：${detail}` : "契约兼容性校验失败",
        "en-US": detail ? `Contract compatibility check failed: ${detail}` : "Contract compatibility check failed",
      },
    }),
  channelConfigMissing: () =>
    new AppError({
      errorCode: "CHANNEL_CONFIG_MISSING",
      httpStatus: 403,
      message: {
        "zh-CN": "渠道配置缺失，已拒绝",
        "en-US": "Channel config is missing",
      },
    }),
  channelSignatureInvalid: () =>
    new AppError({
      errorCode: "CHANNEL_SIGNATURE_INVALID",
      httpStatus: 403,
      message: {
        "zh-CN": "渠道验签失败，已拒绝",
        "en-US": "Channel signature invalid",
      },
    }),
  channelReplayDenied: () =>
    new AppError({
      errorCode: "CHANNEL_REPLAY_DENIED",
      httpStatus: 403,
      message: {
        "zh-CN": "请求疑似重放，已拒绝",
        "en-US": "Replay denied",
      },
    }),
  channelMappingMissing: () =>
    new AppError({
      errorCode: "CHANNEL_MAPPING_MISSING",
      httpStatus: 403,
      message: {
        "zh-CN": "渠道身份映射缺失，已拒绝",
        "en-US": "Channel mapping is missing",
      },
    }),
  runNotCancelable: () =>
    new AppError({
      errorCode: "RUN_NOT_CANCELABLE",
      httpStatus: 409,
      message: {
        "zh-CN": "Run 已结束或不可取消",
        "en-US": "Run is not cancelable",
      },
    }),
  stepOutputNotEncrypted: () =>
    new AppError({
      errorCode: "STEP_OUTPUT_NOT_ENCRYPTED",
      httpStatus: 400,
      message: {
        "zh-CN": "Step 出参未加密，无法解密查看",
        "en-US": "Step output is not encrypted",
      },
    }),
  stepPayloadExpired: () =>
    new AppError({
      errorCode: "STEP_PAYLOAD_EXPIRED",
      httpStatus: 410,
      message: {
        "zh-CN": "Step 密文已过期清理，无法解密查看",
        "en-US": "Step payload expired",
      },
    }),
  stepNotCompensable: () =>
    new AppError({
      errorCode: "STEP_NOT_COMPENSABLE",
      httpStatus: 400,
      message: {
        "zh-CN": "Step 不支持补偿/撤销",
        "en-US": "Step is not compensable",
      },
    }),
  evidenceRequired: () =>
    new AppError({
      errorCode: "EVIDENCE_REQUIRED",
      httpStatus: 409,
      message: {
        "zh-CN": "回答缺少证据链引用，已拒绝",
        "en-US": "Answer is missing evidence references",
      },
    }),
  fieldWriteForbidden: () =>
    new AppError({
      errorCode: "FIELD_WRITE_FORBIDDEN",
      httpStatus: 403,
      message: {
        "zh-CN": "无权限写入该字段",
        "en-US": "Field write forbidden",
      },
    }),
  badRequest: (detail?: string) =>
    new AppError({
      errorCode: "BAD_REQUEST",
      httpStatus: 400,
      message: {
        "zh-CN": detail ? `参数错误：${detail}` : "参数错误",
        "en-US": detail ? `Bad request: ${detail}` : "Bad request",
      },
    }),
  policyDebugInvalidInput: (detail?: string) =>
    new AppError({
      errorCode: "POLICY_DEBUG_INVALID_INPUT",
      httpStatus: 400,
      message: {
        "zh-CN": detail ? `策略调试输入无效：${detail}` : "策略调试输入无效",
        "en-US": detail ? `Policy debug input invalid: ${detail}` : "Policy debug input invalid",
      },
    }),
  policyExprInvalid: (detail?: string) =>
    new AppError({
      errorCode: "POLICY_EXPR_INVALID",
      httpStatus: 400,
      message: {
        "zh-CN": detail ? `策略表达式无效：${detail}` : "策略表达式无效",
        "en-US": detail ? `Policy expression invalid: ${detail}` : "Policy expression invalid",
      },
    }),
  migrationRequired: (detail?: string) =>
    new AppError({
      errorCode: "MIGRATION_REQUIRED",
      httpStatus: 403,
      message: {
        "zh-CN": detail ? `需要先完成数据迁移：${detail}` : "需要先完成数据迁移",
        "en-US": detail ? `Migration required: ${detail}` : "Migration required",
      },
    }),
  schemaMigrationRequired: (detail?: string) =>
    new AppError({
      errorCode: "SCHEMA_MIGRATION_REQUIRED",
      httpStatus: 403,
      message: {
        "zh-CN": detail ? `Schema 需要先完成数据迁移：${detail}` : "Schema 需要先完成数据迁移",
        "en-US": detail ? `Schema migration required: ${detail}` : "Schema migration required",
      },
    }),
  schemaBreakingChange: (detail?: string) =>
    new AppError({
      errorCode: "SCHEMA_BREAKING_CHANGE",
      httpStatus: 403,
      message: {
        "zh-CN": detail ? `检测到 Schema 破坏性变更：${detail}` : "检测到 Schema 破坏性变更",
        "en-US": detail ? `Schema breaking change detected: ${detail}` : "Schema breaking change detected",
      },
    }),
  inputSchemaInvalid: (detail?: string) =>
    new AppError({
      errorCode: "INPUT_SCHEMA_INVALID",
      httpStatus: 400,
      message: {
        "zh-CN": detail ? `入参校验失败：${detail}` : "入参校验失败",
        "en-US": detail ? `Input schema invalid: ${detail}` : "Input schema invalid",
      },
    }),
  modelUpstreamFailed: (detail?: string) =>
    new AppError({
      errorCode: "MODEL_UPSTREAM_FAILED",
      httpStatus: 502,
      message: {
        "zh-CN": detail ? `模型上游服务失败：${detail}` : "模型上游服务失败",
        "en-US": detail ? `Model upstream failed: ${detail}` : "Model upstream failed",
      },
    }),
  modelProviderNotImplemented: (provider?: string) =>
    new AppError({
      errorCode: "PROVIDER_NOT_IMPLEMENTED",
      httpStatus: 501,
      message: {
        "zh-CN": provider ? `模型提供方未实现：${provider}` : "模型提供方未实现",
        "en-US": provider ? `Provider not implemented: ${provider}` : "Provider not implemented",
      },
    }),
  modelProviderUnsupported: (provider?: string) =>
    new AppError({
      errorCode: "MODEL_PROVIDER_UNSUPPORTED",
      httpStatus: 400,
      message: {
        "zh-CN": provider ? `不支持的模型提供方：${provider}` : "不支持的模型提供方",
        "en-US": provider ? `Model provider unsupported: ${provider}` : "Model provider unsupported",
      },
    }),
  changeSetModeNotSupported: () =>
    new AppError({
      errorCode: "CHANGESET_MODE_NOT_SUPPORTED",
      httpStatus: 400,
      message: {
        "zh-CN": "该变更集内容不支持 canary 模式",
        "en-US": "This changeset does not support canary mode",
      },
    }),
  serviceNotReady: (detail?: string) =>
    new AppError({
      errorCode: "SERVICE_NOT_READY",
      httpStatus: 503,
      message: {
        "zh-CN": detail ? `服务未就绪：${detail}` : "服务未就绪",
        "en-US": detail ? `Service not ready: ${detail}` : "Service not ready",
      },
    }),
  internal: () =>
    new AppError({
      errorCode: "INTERNAL_ERROR",
      httpStatus: 500,
      message: {
        "zh-CN": "服务内部错误",
        "en-US": "Internal server error",
      },
    }),
};
