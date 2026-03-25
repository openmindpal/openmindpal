/**
 * Device-Agent Executor — 纯调度器
 *
 * 职责：策略检查 → 用户确认 → 查插件注册表分发
 * 不硬编码任何具体设备工具，所有场景能力由插件提供。
 */
import { findPluginForTool, type ToolExecutionContext, type ToolExecutionResult } from "./pluginRegistry";
import { sha256_8 } from "./log";

function isPlainObject(v: any): v is Record<string, any> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function toolName(toolRef: string) {
  const idx = toolRef.indexOf("@");
  return idx > 0 ? toolRef.slice(0, idx) : toolRef;
}

export type DeviceClaimEnvelope = {
  execution: { deviceExecutionId: string; toolRef: string; input?: any };
  requireUserPresence?: boolean;
  policy?: any;
  policyDigest?: any;
};

export async function executeDeviceTool(params: {
  cfg: { apiBase: string; deviceToken: string };
  claim: DeviceClaimEnvelope;
  confirmFn: (q: string) => Promise<boolean>;
}): Promise<ToolExecutionResult> {
  const exec = params.claim.execution;
  const name = toolName(exec.toolRef);
  const input = isPlainObject(exec.input) ? exec.input : {};
  const policy = params.claim.policy ?? null;

  // ── 策略检查：allowedTools ──────────────────────────────────────
  const allowedTools = Array.isArray(policy?.allowedTools) ? policy.allowedTools.map((x: any) => String(x)) : [];
  if (!allowedTools.includes(name) && !["noop", "echo"].includes(name)) {
    return { status: "failed", errorCategory: "policy_violation", outputDigest: { reason: "tool_not_allowed", tool: name } };
  }

  // ── 用户确认 ────────────────────────────────────────────────────
  const requireUserPresence = Boolean(params.claim.requireUserPresence);
  if (requireUserPresence) {
    const ok = await params.confirmFn(`执行 ${name}？`);
    if (!ok) {
      return { status: "failed", errorCategory: "user_denied", outputDigest: { ok: false } };
    }
    const confirmMode = String(policy?.uiPolicy?.confirmationMode ?? "").trim().toLowerCase();
    const strict = confirmMode === "double" || Boolean(policy?.uiPolicy?.strictConfirm);
    if (strict) {
      const code = sha256_8(String(exec.deviceExecutionId ?? ""));
      const ok2 = await params.confirmFn(`确认码 ${code}：再次确认执行 ${name}？`);
      if (!ok2) {
        return { status: "failed", errorCategory: "user_denied", outputDigest: { ok: false, step: "confirm2", code } };
      }
    }
  }

  // ── 内置通用工具（所有场景通用，不属于任何插件） ────────────────
  if (name === "noop") return { status: "succeeded", outputDigest: { ok: true } };
  if (name === "echo") return { status: "succeeded", outputDigest: { inputKeys: Object.keys(input).slice(0, 50) } };

  // ── 查找插件并委托执行 ──────────────────────────────────────────
  const plugin = findPluginForTool(name);
  if (plugin) {
    const ctx: ToolExecutionContext = {
      cfg: params.cfg,
      execution: exec,
      toolName: name,
      input,
      policy,
      requireUserPresence,
      confirmFn: params.confirmFn,
    };
    return plugin.execute(ctx);
  }

  // ── 无插件能处理 ────────────────────────────────────────────────
  return { status: "failed", errorCategory: "unsupported_tool", outputDigest: { toolRef: exec.toolRef } };
}
