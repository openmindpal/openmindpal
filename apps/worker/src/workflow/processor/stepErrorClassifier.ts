/**
 * Step 错误分类与恢复逻辑
 * 从 processStep.ts 拆分出来
 */

// ────────────────────────────────────────────────────────────────
// 错误类别定义
// ────────────────────────────────────────────────────────────────

export type ErrorCategory =
  | "timeout"
  | "needs_device"
  | "resource_exhausted"
  | "policy_violation"
  | "internal"
  | "retryable"
  | "device_execution_failed";

// ────────────────────────────────────────────────────────────────
// 错误分类器
// ────────────────────────────────────────────────────────────────

/**
 * 根据错误消息分类错误类型
 */
export function classifyError(rawMessage: string): ErrorCategory {
  // 规范化消息
  const msg = rawMessage.startsWith("concurrency_limit:")
    ? "resource_exhausted:max_concurrency"
    : rawMessage;

  // 超时
  if (msg === "timeout") {
    return "timeout";
  }

  // 需要设备
  if (msg === "needs_device") {
    return "needs_device";
  }

  // 资源耗尽
  if (msg.startsWith("resource_exhausted:")) {
    return "resource_exhausted";
  }

  // 策略违规
  if (msg.startsWith("policy_violation:")) {
    return "policy_violation";
  }

  // 内部错误（模式校验失败）
  if (msg.startsWith("output_schema:") || msg.startsWith("input_schema:")) {
    return "internal";
  }

  // 写租约忙
  if (msg === "write_lease_busy") {
    return "retryable";
  }

  // 冲突
  if (msg.startsWith("conflict_")) {
    return "retryable";
  }

  // Schema 未找到
  if (msg.startsWith("schema_not_found:")) {
    return "retryable";
  }

  // 设备执行失败
  if (msg.startsWith("device_execution_failed:")) {
    return "device_execution_failed";
  }

  // 默认可重试
  return "retryable";
}

// ────────────────────────────────────────────────────────────────
// 错误恢复策略
// ────────────────────────────────────────────────────────────────

export interface ErrorRecoveryDecision {
  /** 是否应该重新抛出错误以触发重试 */
  shouldRethrow: boolean;
  /** 是否为终态（不应重试） */
  isTerminal: boolean;
  /** 建议的退避时间（毫秒） */
  backoffMs: number | null;
}

/**
 * 获取错误的恢复决策
 */
export function getErrorRecoveryDecision(category: ErrorCategory, err?: any): ErrorRecoveryDecision {
  switch (category) {
    // 策略违规和内部错误是终态，不重试
    case "policy_violation":
    case "internal":
      return { shouldRethrow: false, isTerminal: true, backoffMs: null };

    // 需要设备是特殊状态，由外部流程处理
    case "needs_device":
      return { shouldRethrow: false, isTerminal: false, backoffMs: null };

    // 超时通常不重试
    case "timeout":
      return { shouldRethrow: true, isTerminal: false, backoffMs: null };

    // 资源耗尽通常不重试
    case "resource_exhausted":
      return { shouldRethrow: true, isTerminal: false, backoffMs: null };

    // 设备执行失败，可能重试
    case "device_execution_failed":
      return { shouldRethrow: true, isTerminal: false, backoffMs: null };

    // 可重试错误
    case "retryable": {
      // 如果是写租约忙，使用错误中的退避时间
      const writeLease = err?.writeLease;
      if (writeLease && typeof writeLease.backoffMs === "number") {
        return { shouldRethrow: true, isTerminal: false, backoffMs: writeLease.backoffMs };
      }
      return { shouldRethrow: true, isTerminal: false, backoffMs: null };
    }

    default:
      return { shouldRethrow: true, isTerminal: false, backoffMs: null };
  }
}

// ────────────────────────────────────────────────────────────────
// 错误信息提取
// ────────────────────────────────────────────────────────────────

import { isPlainObject } from "./common";

export interface ExtractedErrorInfo {
  message: string;
  category: ErrorCategory;
  capabilityEnvelopeSummary: any | null;
  writeLease: any | null;
  deviceExecutionId: string | null;
  deviceId: string | null;
}

/**
 * 从错误对象提取结构化信息
 */
export function extractErrorInfo(err: any): ExtractedErrorInfo {
  const rawMsg = String(err?.message ?? err);
  const msg = rawMsg.startsWith("concurrency_limit:") ? "resource_exhausted:max_concurrency" : rawMsg;
  const category = classifyError(rawMsg);

  return {
    message: msg,
    category,
    capabilityEnvelopeSummary: isPlainObject(err?.capabilityEnvelopeSummary) ? err.capabilityEnvelopeSummary : null,
    writeLease: isPlainObject(err?.writeLease) ? err.writeLease : null,
    deviceExecutionId: err?.deviceExecutionId ?? null,
    deviceId: err?.deviceId ?? null,
  };
}

// ────────────────────────────────────────────────────────────────
// 错误消息规范化
// ────────────────────────────────────────────────────────────────

/**
 * 规范化错误消息
 */
export function normalizeErrorMessage(rawMessage: string): string {
  if (rawMessage.startsWith("concurrency_limit:")) {
    return "resource_exhausted:max_concurrency";
  }
  return rawMessage;
}
