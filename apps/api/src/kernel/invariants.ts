/**
 * invariants.ts — 架构不变式检查
 *
 * 所有执行必须满足的不变式：
 *   1. 每个 step 必须有 traceId
 *   2. 每个 step 必须有 toolRef
 *   3. 每个 step 的 toolRef 必须对应已注册的 tool_definition
 *   4. 每个执行必须有 tenantId
 *   5. 每个 run 必须有合法的 status
 *   6. capabilityEnvelope 完整性（write 类工具必须有）
 *   7. policySnapshotRef 存在性（write 类工具必须有）
 *
 * 不变式检查不阻塞执行（warn-only），但为旁路检测提供依据。
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InvariantSeverity = "error" | "warn" | "info";

export interface InvariantViolation {
  code: string;
  severity: InvariantSeverity;
  message: string;
  field?: string;
}

export interface StepInvariantInput {
  stepId: string;
  runId: string;
  tenantId: string | null | undefined;
  toolRef: string | null | undefined;
  traceId: string | null | undefined;
  status: string | null | undefined;
  runStatus: string | null | undefined;
  /** Step input envelope */
  input?: Record<string, unknown> | null;
  /** Whether this tool is a side-effect write operation */
  isWriteTool?: boolean;
  /** capabilityEnvelope present? */
  hasCapabilityEnvelope?: boolean;
  /** policySnapshotRef present? */
  hasPolicySnapshotRef?: boolean;
  /** Whether tool_ref resolves to a registered tool_definition */
  toolRegistered?: boolean;
  /** Whether tool is enabled in governance */
  toolEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// Core invariant checks
// ---------------------------------------------------------------------------

/**
 * 检查 step 执行的核心不变式。
 * 返回所有违规项。空数组 = 全部通过。
 */
export function assertExecutionInvariants(input: StepInvariantInput): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  // 1. tenantId 必须存在
  if (!input.tenantId) {
    violations.push({
      code: "inv.missing_tenant_id",
      severity: "error",
      message: `step ${input.stepId}: missing tenantId`,
      field: "tenantId",
    });
  }

  // 2. traceId 必须存在
  if (!input.traceId || input.traceId === "unknown") {
    violations.push({
      code: "inv.missing_trace_id",
      severity: "warn",
      message: `step ${input.stepId}: missing or unknown traceId`,
      field: "traceId",
    });
  }

  // 3. toolRef 必须存在
  if (!input.toolRef) {
    violations.push({
      code: "inv.missing_tool_ref",
      severity: "error",
      message: `step ${input.stepId}: missing toolRef`,
      field: "toolRef",
    });
  }

  // 4. tool 必须已注册
  if (input.toolRegistered === false) {
    violations.push({
      code: "inv.tool_not_registered",
      severity: "error",
      message: `step ${input.stepId}: toolRef "${input.toolRef}" not registered in tool_definitions`,
      field: "toolRef",
    });
  }

  // 5. tool 必须已启用（governance）
  if (input.toolEnabled === false) {
    violations.push({
      code: "inv.tool_not_enabled",
      severity: "warn",
      message: `step ${input.stepId}: toolRef "${input.toolRef}" not enabled in governance rollout`,
      field: "toolRef",
    });
  }

  // 6. write 类工具需要 capabilityEnvelope
  if (input.isWriteTool && input.hasCapabilityEnvelope === false) {
    violations.push({
      code: "inv.missing_capability_envelope",
      severity: "warn",
      message: `step ${input.stepId}: write tool "${input.toolRef}" missing capabilityEnvelope`,
      field: "capabilityEnvelope",
    });
  }

  // 7. write 类工具需要 policySnapshotRef
  if (input.isWriteTool && input.hasPolicySnapshotRef === false) {
    violations.push({
      code: "inv.missing_policy_snapshot_ref",
      severity: "warn",
      message: `step ${input.stepId}: write tool "${input.toolRef}" missing policySnapshotRef`,
      field: "policySnapshotRef",
    });
  }

  // 8. run status 合法性
  const validRunStatuses = new Set([
    "created", "queued", "running", "needs_approval", "needs_device",
    "needs_arbiter", "succeeded", "failed", "canceled", "stopped",
    "compensating", "compensated",
  ]);
  if (input.runStatus && !validRunStatuses.has(input.runStatus)) {
    violations.push({
      code: "inv.invalid_run_status",
      severity: "error",
      message: `step ${input.stepId}: run ${input.runId} has invalid status "${input.runStatus}"`,
      field: "runStatus",
    });
  }

  // 9. step status 合法性
  const validStepStatuses = new Set([
    "pending", "running", "needs_approval", "needs_device",
    "needs_arbiter", "succeeded", "failed", "deadletter", "canceled",
  ]);
  if (input.status && !validStepStatuses.has(input.status)) {
    violations.push({
      code: "inv.invalid_step_status",
      severity: "error",
      message: `step ${input.stepId}: invalid status "${input.status}"`,
      field: "status",
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Convenience: log violations
// ---------------------------------------------------------------------------

/**
 * 将不变式违规输出到 console.warn。
 * 不阻塞执行，仅记录，用于可观测性。
 */
export function logInvariantViolations(violations: InvariantViolation[]): void {
  for (const v of violations) {
    const level = v.severity === "error" ? "error" : "warn";
    console[level](`[invariant] ${v.code}: ${v.message}`);
  }
}

// ---------------------------------------------------------------------------
// Bypass detection helpers
// ---------------------------------------------------------------------------

/**
 * 检测是否为"旁路执行"：
 * 没有经过标准 API 入口（executionKernel）的 step 提交。
 *
 * 旁路特征：
 * - 缺少 traceId
 * - 缺少 policySnapshotRef
 * - tool 未在 governance 中启用
 */
export function detectBypassExecution(input: StepInvariantInput): {
  isBypass: boolean;
  signals: string[];
} {
  const signals: string[] = [];

  if (!input.traceId || input.traceId === "unknown") {
    signals.push("missing_trace_id");
  }
  if (input.isWriteTool && input.hasPolicySnapshotRef === false) {
    signals.push("missing_policy_snapshot_ref");
  }
  if (input.toolEnabled === false) {
    signals.push("tool_not_enabled");
  }
  if (input.toolRegistered === false) {
    signals.push("tool_not_registered");
  }

  return {
    isBypass: signals.length >= 2, // 2+ 信号才认定为旁路
    signals,
  };
}
