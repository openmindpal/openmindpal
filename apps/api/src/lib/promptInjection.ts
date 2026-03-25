/**
 * Prompt Injection Guard — kernel-level prompt injection scanning.
 *
 * This module lives in lib/ so that kernel routes (tools.ts, models.ts)
 * and skill routes (orchestrator.ts) can scan for prompt injection
 * WITHOUT importing from the safety-policy Skill's modules.
 *
 * All heavy lifting is delegated to @openslin/shared.
 */
import { detectPromptInjection, resolvePromptInjectionPolicy, resolvePromptInjectionPolicyFromEnv, shouldDenyPromptInjection } from "@openslin/shared";
import type { PromptInjectionMode, PromptInjectionPolicy } from "@openslin/shared";

export type PromptInjectionSummary = {
  hitCount: number;
  maxSeverity: string;
  target: string;
  ruleIds: string[];
  decision: "allowed" | "denied";
  mode: PromptInjectionMode;
  result: "allowed" | "denied";
};

export function getPromptInjectionModeFromEnv(): PromptInjectionMode {
  return resolvePromptInjectionPolicyFromEnv().mode;
}

export function getPromptInjectionDenyTargetsFromEnv(): Set<string> {
  return resolvePromptInjectionPolicyFromEnv().denyTargets;
}

export function getPromptInjectionPolicyFromEnv(): PromptInjectionPolicy {
  return resolvePromptInjectionPolicyFromEnv();
}

export function scanPromptInjection(text: string) {
  return detectPromptInjection(text);
}

export function summarizePromptInjection(
  scan: ReturnType<typeof scanPromptInjection>,
  mode: PromptInjectionMode,
  target: string,
  denied: boolean,
): PromptInjectionSummary {
  const decision = denied ? "denied" : "allowed";
  return {
    hitCount: scan.hits.length,
    maxSeverity: scan.maxSeverity,
    target,
    ruleIds: scan.hits.map((h) => h.ruleId),
    decision,
    mode,
    result: decision,
  };
}

export function shouldDenyPromptInjectionForTarget(params: {
  scan: ReturnType<typeof scanPromptInjection>;
  mode?: PromptInjectionMode;
  target: string;
  denyTargets?: Set<string>;
  policy?: PromptInjectionPolicy;
}) {
  const policy = params.policy ?? resolvePromptInjectionPolicy({ version: "v1", mode: params.mode, denyTargets: params.denyTargets });
  if (policy.mode !== "deny") return false;
  if (!policy.denyTargets.has(params.target)) return false;
  return shouldDenyPromptInjection(params.scan, policy);
}

export function extractTextForPromptInjectionScan(input: unknown, maxChars = 6000) {
  if (typeof input === "string") return input.slice(0, maxChars);
  const out: string[] = [];
  const seen = new Set<any>();

  function walk(v: any, depth: number) {
    if (out.join(" ").length >= maxChars) return;
    if (v == null) return;
    if (typeof v === "string") {
      const s = v.trim();
      if (s) out.push(s.slice(0, 300));
      return;
    }
    if (typeof v === "number" || typeof v === "boolean") return;
    if (depth <= 0) return;
    if (typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < Math.min(v.length, 20); i++) walk(v[i], depth - 1);
      return;
    }
    const keys = Object.keys(v).slice(0, 40);
    for (const k of keys) walk(v[k], depth - 1);
  }

  walk(input as any, 3);
  const joined = out.join(" ");
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
}
