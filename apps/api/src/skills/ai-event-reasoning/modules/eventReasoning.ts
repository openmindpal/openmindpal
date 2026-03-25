/**
 * AI Event Reasoning — Core three-tier decision engine.
 *
 * Tier 1 (rule):    Deterministic fast rules  — < 1ms
 * Tier 2 (pattern): Lightweight pattern match — 10~100ms
 * Tier 3 (llm):     LLM deep reasoning       — async, 500ms~5s
 *
 * The engine processes an incoming event through each tier sequentially.
 * If a tier produces a definitive decision (execute/ignore), processing stops.
 * Only ambiguous results ("uncertain") cascade to the next tier.
 */
import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { redactValue } from "@openslin/shared";
import { invokeModelChat } from "../../../lib/llm";
import {
  listEnabledRules,
  insertReasoningLog,
  type EventReasoningRule,
  type ReasoningLogInsert,
} from "./reasoningRepo";

/* ────────────────────── Types ────────────────────── */

export type EventEnvelope = {
  eventSourceId: string;
  eventType: string;
  provider: string | null;
  workspaceId: string | null;
  spaceId: string | null;
  payload: Record<string, unknown> | null;
  raw?: unknown;
};

export type ReasoningDecision = {
  tier: "rule" | "pattern" | "llm";
  decision: "execute" | "escalate" | "ignore" | "error";
  confidence: number | null;
  reasoningText: string | null;
  matchedRuleId: string | null;
  matchDigest: Record<string, unknown> | null;
  actionKind: string | null;
  actionRef: string | null;
  actionInput: Record<string, unknown> | null;
  latencyMs: number;
};

export type ReasoningContext = {
  app: FastifyInstance;
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string;
  traceId: string;
  locale?: string;
};

/* ────────────────── Utility ──────────────────── */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function getByPath(obj: any, path: string[]): unknown {
  let cur: any = obj;
  for (const p of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

function safePath(raw: string): string[] | null {
  const segs = raw.split(".").map((s) => s.trim()).filter(Boolean);
  if (segs.length === 0 || segs.length > 12) return null;
  return segs.every((s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && s.length <= 100) ? segs : null;
}

function globMatch(pattern: string, value: string): boolean {
  if (!pattern) return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

/* ────────────────── Tier 1: Fast Rules ──────────────────── */

function evaluateCondition(expr: any, event: EventEnvelope): { matched: boolean; reason: string } {
  if (!expr || !isPlainObject(expr)) return { matched: true, reason: "no_condition" };

  const op = String((expr as any).op ?? "eq");

  // Leaf comparison: { path, op, value }
  if (typeof (expr as any).path === "string") {
    const pathSegs = safePath(String((expr as any).path));
    if (!pathSegs) return { matched: false, reason: "invalid_path" };
    const actual = getByPath(event.payload ?? {}, pathSegs);
    const expected = (expr as any).value;

    switch (op) {
      case "eq": return { matched: JSON.stringify(actual) === JSON.stringify(expected), reason: op };
      case "neq": return { matched: JSON.stringify(actual) !== JSON.stringify(expected), reason: op };
      case "gt": return { matched: Number(actual) > Number(expected), reason: op };
      case "gte": return { matched: Number(actual) >= Number(expected), reason: op };
      case "lt": return { matched: Number(actual) < Number(expected), reason: op };
      case "lte": return { matched: Number(actual) <= Number(expected), reason: op };
      case "contains": return { matched: String(actual ?? "").includes(String(expected ?? "")), reason: op };
      case "exists": return { matched: actual !== undefined && actual !== null, reason: op };
      default: return { matched: false, reason: "unknown_op" };
    }
  }

  // Logical combinators: { op: "and"|"or", conditions: [...] }
  const conditions = Array.isArray((expr as any).conditions) ? (expr as any).conditions : [];
  if (op === "and") {
    for (const c of conditions) {
      const r = evaluateCondition(c, event);
      if (!r.matched) return { matched: false, reason: `and_failed:${r.reason}` };
    }
    return { matched: true, reason: "and_all_passed" };
  }
  if (op === "or") {
    for (const c of conditions) {
      const r = evaluateCondition(c, event);
      if (r.matched) return { matched: true, reason: `or_passed:${r.reason}` };
    }
    return { matched: false, reason: "or_none_passed" };
  }

  return { matched: false, reason: "unknown_combinator" };
}

function renderTemplate(template: any, event: EventEnvelope): Record<string, unknown> {
  if (!isPlainObject(template)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(template)) {
    if (typeof val === "string" && val.startsWith("{{") && val.endsWith("}}")) {
      const ref = val.slice(2, -2).trim();
      if (ref.startsWith("event.")) {
        const pathSegs = safePath(ref.slice(6));
        out[key] = pathSegs ? getByPath(event.payload ?? {}, pathSegs) ?? null : null;
      } else if (ref === "eventType") {
        out[key] = event.eventType;
      } else if (ref === "provider") {
        out[key] = event.provider;
      } else if (ref === "workspaceId") {
        out[key] = event.workspaceId;
      } else {
        out[key] = val;
      }
    } else {
      out[key] = val;
    }
  }
  return out;
}

function matchRuleAgainstEvent(rule: EventReasoningRule, event: EventEnvelope): { matched: boolean; reason: string } {
  // Check event type pattern
  if (rule.eventTypePattern && !globMatch(rule.eventTypePattern, event.eventType)) {
    return { matched: false, reason: "event_type_mismatch" };
  }
  // Check provider pattern
  if (rule.providerPattern && event.provider && !globMatch(rule.providerPattern, event.provider)) {
    return { matched: false, reason: "provider_mismatch" };
  }
  // Check condition expression
  const condResult = evaluateCondition(rule.conditionExpr, event);
  if (!condResult.matched) {
    return { matched: false, reason: `condition:${condResult.reason}` };
  }
  return { matched: true, reason: "all_matched" };
}

async function tier1FastRules(ctx: ReasoningContext, event: EventEnvelope): Promise<ReasoningDecision | null> {
  const startMs = Date.now();
  const rules = await listEnabledRules({ pool: ctx.pool, tenantId: ctx.tenantId, tier: "rule", limit: 100 });
  if (!rules.length) return null;

  // Rules are pre-sorted by priority (ascending = higher priority)
  for (const rule of rules) {
    const result = matchRuleAgainstEvent(rule, event);
    if (result.matched) {
      const actionInput = rule.actionInputTemplate ? renderTemplate(rule.actionInputTemplate, event) : null;
      return {
        tier: "rule",
        decision: rule.decision as any,
        confidence: 1.0,
        reasoningText: null,
        matchedRuleId: rule.ruleId,
        matchDigest: { ruleName: rule.name, reason: result.reason },
        actionKind: rule.actionKind,
        actionRef: rule.actionRef,
        actionInput,
        latencyMs: Date.now() - startMs,
      };
    }
  }
  return null; // No rule matched → cascade to next tier
}

/* ────────────────── Tier 2: Pattern Match ──────────────────── */

async function tier2PatternMatch(ctx: ReasoningContext, event: EventEnvelope): Promise<ReasoningDecision | null> {
  const startMs = Date.now();
  const patterns = await listEnabledRules({ pool: ctx.pool, tenantId: ctx.tenantId, tier: "pattern", limit: 50 });
  if (!patterns.length) return null;

  for (const pattern of patterns) {
    const result = matchRuleAgainstEvent(pattern, event);
    if (result.matched) {
      const actionInput = pattern.actionInputTemplate ? renderTemplate(pattern.actionInputTemplate, event) : null;
      // Pattern match has slightly lower confidence than deterministic rules
      return {
        tier: "pattern",
        decision: pattern.decision as any,
        confidence: 0.85,
        reasoningText: null,
        matchedRuleId: pattern.ruleId,
        matchDigest: { patternName: pattern.name, reason: result.reason },
        actionKind: pattern.actionKind,
        actionRef: pattern.actionRef,
        actionInput,
        latencyMs: Date.now() - startMs,
      };
    }
  }
  return null; // No pattern matched → cascade to LLM
}

/* ────────────────── Tier 3: LLM Deep Reasoning ──────────────────── */

function buildEventReasoningPrompt(event: EventEnvelope, locale: string): string {
  const parts: string[] = [
    "You are MindPal's AI Event Reasoning engine. You receive IoT/device/system events and decide what action to take.",
    "",
    "## Event Details",
    `- Event Type: ${event.eventType}`,
    `- Provider: ${event.provider ?? "unknown"}`,
    `- Workspace: ${event.workspaceId ?? "unknown"}`,
    `- Payload: ${JSON.stringify(event.payload ?? {}, null, 2).slice(0, 2000)}`,
    "",
    "## Your Task",
    "Analyze this event and decide:",
    "1. **Decision**: 'execute' (take automated action), 'escalate' (needs human review), or 'ignore' (no action needed)",
    "2. **Reasoning**: Brief explanation of why",
    "3. **Action** (if execute): What tool/workflow to trigger and with what parameters",
    "",
    "Respond in this exact JSON format:",
    "```event_decision",
    JSON.stringify({ decision: "execute|escalate|ignore", confidence: 0.9, reasoning: "...", action: { kind: "workflow|notify|tool", ref: "tool.ref@1", input: {} } }, null, 2),
    "```",
    "",
    `Respond in locale: ${locale}. Be concise.`,
  ];
  return parts.join("\n");
}

function parseEventDecisionFromOutput(text: string): {
  decision: string;
  confidence: number;
  reasoning: string;
  action: { kind: string; ref: string; input: Record<string, unknown> } | null;
} | null {
  const regex = /```event_decision\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = regex.exec(text)) !== null) {
    last = match[1]?.trim() ?? "";
  }
  if (!last) return null;
  try {
    const parsed = JSON.parse(last);
    const decision = String(parsed?.decision ?? "ignore");
    const confidence = Number(parsed?.confidence ?? 0.5);
    const reasoning = String(parsed?.reasoning ?? "");
    const action = parsed?.action && typeof parsed.action === "object"
      ? { kind: String(parsed.action.kind ?? ""), ref: String(parsed.action.ref ?? ""), input: (parsed.action.input ?? {}) as Record<string, unknown> }
      : null;
    return { decision, confidence: Math.max(0, Math.min(1, confidence)), reasoning, action };
  } catch {
    return null;
  }
}

async function tier3LlmReasoning(ctx: ReasoningContext, event: EventEnvelope): Promise<ReasoningDecision> {
  const startMs = Date.now();
  const locale = ctx.locale ?? "zh-CN";

  try {
    const modelOut = await invokeModelChat({
      app: ctx.app,
      subject: { tenantId: ctx.tenantId, spaceId: ctx.spaceId ?? undefined, subjectId: ctx.subjectId },
      locale,
      authorization: null,
      traceId: ctx.traceId,
      purpose: "ai-event-reasoning.tier3",
      messages: [
        { role: "system", content: "You are an AI event reasoning engine. Analyze the event and decide: execute, escalate, or ignore. Reply in the requested JSON format." },
        { role: "user", content: buildEventReasoningPrompt(event, locale) },
      ],
    });

    const replyText = typeof modelOut?.outputText === "string" ? modelOut.outputText : "";
    const parsed = parseEventDecisionFromOutput(replyText);

    if (!parsed) {
      return {
        tier: "llm",
        decision: "escalate",
        confidence: 0.3,
        reasoningText: replyText.slice(0, 2000),
        matchedRuleId: null,
        matchDigest: { parseError: true, replyLen: replyText.length },
        actionKind: null,
        actionRef: null,
        actionInput: null,
        latencyMs: Date.now() - startMs,
      };
    }

    const validDecisions = ["execute", "escalate", "ignore"];
    const decision = validDecisions.includes(parsed.decision) ? parsed.decision : "escalate";

    return {
      tier: "llm",
      decision: decision as any,
      confidence: parsed.confidence,
      reasoningText: parsed.reasoning.slice(0, 5000),
      matchedRuleId: null,
      matchDigest: null,
      actionKind: parsed.action?.kind ?? null,
      actionRef: parsed.action?.ref ?? null,
      actionInput: parsed.action?.input ?? null,
      latencyMs: Date.now() - startMs,
    };
  } catch (err: any) {
    console.error("ai-event-reasoning: LLM tier failed", err?.message ?? err);
    return {
      tier: "llm",
      decision: "error",
      confidence: null,
      reasoningText: null,
      matchedRuleId: null,
      matchDigest: { error: String(err?.message ?? "unknown").slice(0, 500) },
      actionKind: null,
      actionRef: null,
      actionInput: null,
      latencyMs: Date.now() - startMs,
    };
  }
}

/* ────────────────── Main Entry ──────────────────── */

/**
 * Run the three-tier reasoning engine on an event.
 *
 * Flow: Tier1 (fast rules) → Tier2 (pattern match) → Tier3 (LLM)
 * Each tier short-circuits if it produces a definitive decision.
 */
export async function reasonAboutEvent(ctx: ReasoningContext, event: EventEnvelope): Promise<ReasoningDecision> {
  const totalStartMs = Date.now();

  // Tier 1: Fast rules (< 1ms typically)
  const t1 = await tier1FastRules(ctx, event);
  if (t1) {
    await persistDecision(ctx, event, t1);
    return t1;
  }

  // Tier 2: Pattern match (10~100ms)
  const t2 = await tier2PatternMatch(ctx, event);
  if (t2) {
    await persistDecision(ctx, event, t2);
    return t2;
  }

  // Tier 3: LLM reasoning (async, 500ms~5s)
  const t3 = await tier3LlmReasoning(ctx, event);
  await persistDecision(ctx, event, t3);
  return t3;
}

async function persistDecision(ctx: ReasoningContext, event: EventEnvelope, decision: ReasoningDecision): Promise<void> {
  try {
    const redacted = redactValue(event.payload ?? {});
    const log: ReasoningLogInsert = {
      tenantId: ctx.tenantId,
      spaceId: ctx.spaceId,
      eventSourceId: event.eventSourceId,
      eventType: event.eventType,
      provider: event.provider,
      workspaceId: event.workspaceId,
      eventPayload: redacted.value as any,
      tier: decision.tier,
      decision: decision.decision,
      confidence: decision.confidence,
      reasoningText: decision.reasoningText,
      actionKind: decision.actionKind,
      actionRef: decision.actionRef,
      actionInput: decision.actionInput as any,
      matchedRuleId: decision.matchedRuleId,
      matchDigest: decision.matchDigest as any,
      latencyMs: decision.latencyMs,
      traceId: ctx.traceId,
      errorCategory: decision.decision === "error" ? "reasoning_failed" : null,
      errorDigest: decision.decision === "error" ? (decision.matchDigest as any) : null,
    };
    await insertReasoningLog({ pool: ctx.pool, log });
  } catch (err) {
    console.error("ai-event-reasoning: failed to persist decision log", err);
  }
}
