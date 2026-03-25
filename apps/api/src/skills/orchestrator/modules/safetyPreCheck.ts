/**
 * 执行前安全预检查模块（Safety Pre-Check）
 *
 * 功能目标：在编排器实际执行工具之前，根据工具风险等级进行分级安全检查，
 * 拦截高风险操作中的潜在危险行为，确保"预测行为后果"能力的安全落地。
 *
 * 分级策略（零延迟优先）：
 *   low    → 直接放行，零开销
 *   medium → 规则匹配快速检查（不调用 LLM），仅记录不阻塞
 *   high   → 调用 LLM 做安全评估（同步阻塞），不安全则拒绝执行
 */

import type { FastifyInstance } from "fastify";
import { invokeModelChat, type LlmSubject } from "../../../lib/llm";

/* ── 结果类型 ── */

export interface SafetyPreCheckResult {
  /** 是否安全（true = 允许执行） */
  safe: boolean;
  /** 是否实际执行了检查（false = 因低风险直接跳过） */
  checked: boolean;
  /** 触发检查的风险等级 */
  riskLevel: string;
  /** 检查方式：none / rules / llm */
  method: "none" | "rules" | "llm";
  /** 若不安全，拒绝原因 */
  reason?: string;
  /** 若不安全，安全建议 */
  suggestion?: string;
  /** 检查耗时（毫秒） */
  durationMs: number;
}

/* ── 配置 ── */

/** 环境变量开关：SAFETY_PRE_CHECK_ENABLED（默认 true） */
function isEnabled(): boolean {
  const v = process.env.SAFETY_PRE_CHECK_ENABLED;
  if (v === "false" || v === "0") return false;
  return true;
}

/** LLM 安全评估超时（毫秒），默认 8000 */
function llmTimeoutMs(): number {
  const raw = Number(process.env.SAFETY_PRE_CHECK_LLM_TIMEOUT_MS ?? "8000");
  return Number.isFinite(raw) && raw > 0 ? raw : 8000;
}

/* ── 中风险：规则匹配（纯本地，零网络开销） ── */

/** 危险模式关键词（用于 medium 级别的快速扫描） */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; tag: string }> = [
  { pattern: /\bDROP\s+TABLE\b/i, tag: "sql_drop_table" },
  { pattern: /\bDELETE\s+FROM\b.*\bWHERE\s+1\s*=\s*1\b/i, tag: "sql_delete_all" },
  { pattern: /\bTRUNCATE\b/i, tag: "sql_truncate" },
  { pattern: /\brm\s+-rf\b/i, tag: "shell_rm_rf" },
  { pattern: /\bformat\s+[a-zA-Z]:/i, tag: "shell_format_disk" },
  { pattern: /\bshutdown\b/i, tag: "system_shutdown" },
  { pattern: /\breboot\b/i, tag: "system_reboot" },
  { pattern: /\bsudo\b/i, tag: "privilege_escalation" },
];

function rulesCheck(input: unknown): { safe: boolean; matchedTags: string[] } {
  const text = typeof input === "string" ? input : JSON.stringify(input ?? "");
  const matchedTags: string[] = [];
  for (const { pattern, tag } of DANGEROUS_PATTERNS) {
    if (pattern.test(text)) matchedTags.push(tag);
  }
  return { safe: matchedTags.length === 0, matchedTags };
}

/* ── 高风险：LLM 安全评估 ── */

const SAFETY_SYSTEM_PROMPT = `You are a safety evaluator for an intelligent agent system.
Your job: Given a tool invocation (tool name + input), determine if executing it could cause harm.

Evaluate these dimensions:
1. Data safety: Could this destroy, leak, or corrupt important data?
2. System safety: Could this crash, disable, or compromise the system?
3. Physical safety: Could this cause harm in the physical world (devices, robots, infrastructure)?
4. Privacy: Could this expose personal or sensitive information?

Respond in EXACTLY this JSON format (no other text):
{"safe": true|false, "reason": "brief explanation", "suggestion": "what to do instead (if unsafe)"}`;

async function llmSafetyCheck(params: {
  app: FastifyInstance;
  subject: LlmSubject;
  authorization?: string | null;
  traceId?: string | null;
  locale: string;
  toolRef: string;
  scope: string;
  input: unknown;
}): Promise<{ safe: boolean; reason?: string; suggestion?: string }> {
  const inputSummary = (() => {
    const raw = typeof params.input === "string" ? params.input : JSON.stringify(params.input ?? {});
    return raw.length > 500 ? raw.slice(0, 500) + "...(truncated)" : raw;
  })();

  const userMessage = `Tool: ${params.toolRef}\nScope: ${params.scope}\nInput: ${inputSummary}`;

  try {
    const result = await invokeModelChat({
      app: params.app,
      subject: params.subject,
      locale: params.locale,
      authorization: params.authorization,
      traceId: params.traceId,
      purpose: "orchestrator.safety_pre_check",
      messages: [
        { role: "system", content: SAFETY_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      timeoutMs: llmTimeoutMs(),
    });

    const text = (result.outputText ?? "").trim();
    // 尝试解析 JSON 响应
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          safe: parsed.safe !== false,
          reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
          suggestion: typeof parsed.suggestion === "string" ? parsed.suggestion : undefined,
        };
      } catch { /* fall through */ }
    }
    // 无法解析时，保守放行（避免因解析失败阻塞正常操作）
    return { safe: true, reason: "safety_check_parse_fallback" };
  } catch {
    // LLM 调用失败时，保守放行（不因安全检查本身的故障阻断业务）
    return { safe: true, reason: "safety_check_unavailable" };
  }
}

/* ── 主入口 ── */

export async function safetyPreCheck(params: {
  app: FastifyInstance;
  subject: LlmSubject;
  authorization?: string | null;
  traceId?: string | null;
  locale: string;
  toolRef: string;
  scope: string;
  riskLevel: string;
  input: unknown;
}): Promise<SafetyPreCheckResult> {
  const start = Date.now();
  const risk = (params.riskLevel ?? "low").toLowerCase();

  // 全局开关关闭 → 直接放行
  if (!isEnabled()) {
    return { safe: true, checked: false, riskLevel: risk, method: "none", durationMs: 0 };
  }

  // ── low 风险：直接放行，零开销 ──
  if (risk === "low") {
    return { safe: true, checked: false, riskLevel: risk, method: "none", durationMs: 0 };
  }

  // ── medium 风险：本地规则匹配（微秒级） ──
  if (risk === "medium") {
    const { safe, matchedTags } = rulesCheck(params.input);
    const dur = Date.now() - start;
    if (!safe) {
      return {
        safe: false,
        checked: true,
        riskLevel: risk,
        method: "rules",
        reason: `Dangerous pattern detected: ${matchedTags.join(", ")}`,
        suggestion: "Please review the input and remove potentially harmful content.",
        durationMs: dur,
      };
    }
    return { safe: true, checked: true, riskLevel: risk, method: "rules", durationMs: dur };
  }

  // ── high 风险：调用 LLM 做安全评估（同步阻塞，约 1~3 秒） ──
  if (risk === "high") {
    const llmResult = await llmSafetyCheck({
      app: params.app,
      subject: params.subject,
      authorization: params.authorization,
      traceId: params.traceId,
      locale: params.locale,
      toolRef: params.toolRef,
      scope: params.scope,
      input: params.input,
    });
    const dur = Date.now() - start;
    return {
      safe: llmResult.safe,
      checked: true,
      riskLevel: risk,
      method: "llm",
      reason: llmResult.reason,
      suggestion: llmResult.suggestion,
      durationMs: dur,
    };
  }

  // ── 未知风险等级：保守放行 ──
  return { safe: true, checked: false, riskLevel: risk, method: "none", durationMs: Date.now() - start };
}
