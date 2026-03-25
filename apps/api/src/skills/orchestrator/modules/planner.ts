import crypto from "node:crypto";
import type { Pool } from "pg";
import { digestParams, sha256Hex } from "../../../lib/digest";
import { authorize } from "../../../modules/auth/authz";
import { isToolEnabled } from "../../../modules/governance/toolGovernanceRepo";
import { resolveEffectiveToolRef } from "../../../modules/tools/resolve";
import { getToolDefinition, getToolVersionByRef, type ToolDefinition } from "../../../modules/tools/toolRepo";

function sha256_8(input: string) {
  return sha256Hex(input).slice(0, 8);
}

/* ================================================================== */
/*  Structured Scoring Engine (7.1 + 7.2)                              */
/* ================================================================== */

/** Configurable weights for multi-dimensional tool scoring. */
export interface ScoringWeights {
  /** Weight for tool-name ↔ goal text match (default 50). */
  nameMatch: number;
  /** Weight for intent keywords (create/update/delete/read) match (default 20). */
  intentMatch: number;
  /** Penalty for riskLevel = "high" (default -20). */
  riskHigh: number;
  /** Penalty for riskLevel = "medium" (default -5). */
  riskMedium: number;
  /** Bonus for riskLevel = "low" (default 0). */
  riskLow: number;
  /** Penalty when approvalRequired = true (default -10). */
  approvalRequired: number;
  /** Penalty for scope = "write" (default -3). */
  scopeWrite: number;
  /** Bonus for scope = "read" (default 2). */
  scopeRead: number;
  /** Bonus for kernel-layer tools (default 5). */
  layerKernel: number;
  /** Bonus for builtin-layer tools (default 2). */
  layerBuiltin: number;
  /** No bonus for extension-layer tools (default 0). */
  layerExtension: number;
  /** Weight for description ↔ goal text match (default 10). */
  descriptionMatch: number;
  /** Weight for resourceType ↔ goal match (default 8). */
  resourceTypeMatch: number;
  /** Weight multiplier for historical success rate [0-1] (default 15). */
  historicalSuccessRate: number;
}

export const DEFAULT_SCORING_WEIGHTS: Readonly<ScoringWeights> = {
  nameMatch: 50,
  intentMatch: 20,
  riskHigh: -20,
  riskMedium: -5,
  riskLow: 0,
  approvalRequired: -10,
  scopeWrite: -3,
  scopeRead: 2,
  layerKernel: 5,
  layerBuiltin: 2,
  layerExtension: 0,
  descriptionMatch: 10,
  resourceTypeMatch: 8,
  historicalSuccessRate: 15,
};

/** Detailed breakdown of a structured score. */
export interface ScoreBreakdown {
  /** Aggregated total score. */
  total: number;
  /** Individual dimension scores. */
  dimensions: Record<string, number>;
  /** Human-readable reasons for each dimension that contributed. */
  reasons: string[];
}

const INTENT_KEYWORDS: Array<{ patterns: string[]; verb: string }> = [
  { patterns: ["创建", "新建", "create", "add", "insert"], verb: "create" },
  { patterns: ["更新", "修改", "update", "edit", "modify"], verb: "update" },
  { patterns: ["删除", "移除", "delete", "remove"], verb: "delete" },
  { patterns: ["查询", "搜索", "读取", "查看", "read", "search", "query", "find", "list", "get"], verb: "read" },
];

/**
 * Structured multi-dimensional scoring engine.
 *
 * Replaces the legacy `scoreCandidate` with configurable weights for:
 *  - name match, intent match, risk, approval, scope, layer,
 *    description match, resourceType match, and historical success rate.
 *
 * @param params.goal            User's natural-language goal
 * @param params.toolName        Tool name (without @version)
 * @param params.def             ToolDefinition metadata
 * @param params.weights         Optional custom weights (falls back to DEFAULT_SCORING_WEIGHTS)
 * @param params.historicalRate  Optional historical success rate [0-1] (null = cold start, ignored)
 */
export function structuredScore(params: {
  goal: string;
  toolName: string;
  def: Partial<ToolDefinition>;
  weights?: Partial<ScoringWeights>;
  historicalRate?: number | null;
}): ScoreBreakdown {
  const w: ScoringWeights = { ...DEFAULT_SCORING_WEIGHTS, ...params.weights };
  const goalLower = params.goal.toLowerCase();
  const toolLower = params.toolName.toLowerCase();
  const dimensions: Record<string, number> = {};
  const reasons: string[] = [];

  // 1. Name match
  if (goalLower.includes(toolLower)) {
    dimensions.nameMatch = w.nameMatch;
    reasons.push("match:tool_name");
  }

  // 2. Intent keyword match
  for (const ik of INTENT_KEYWORDS) {
    if (ik.patterns.some((p) => goalLower.includes(p))) {
      if (toolLower.includes(ik.verb)) {
        dimensions[`intentMatch:${ik.verb}`] = w.intentMatch;
        reasons.push(`match:${ik.verb}_intent`);
        break; // only count one intent match
      }
    }
  }

  // 3. Risk level
  const risk = String(params.def?.riskLevel ?? "low");
  if (risk === "high") {
    dimensions.riskPenalty = w.riskHigh;
    reasons.push("penalty:risk_high");
  } else if (risk === "medium") {
    dimensions.riskPenalty = w.riskMedium;
    reasons.push("penalty:risk_medium");
  } else {
    dimensions.riskBonus = w.riskLow;
    if (w.riskLow !== 0) reasons.push("bonus:risk_low");
  }

  // 4. Approval required
  if (params.def?.approvalRequired) {
    dimensions.approvalPenalty = w.approvalRequired;
    reasons.push("penalty:approval_required");
  }

  // 5. Scope (read vs write)
  const scope = params.def?.scope;
  if (scope === "write") {
    dimensions.scopeAdjust = w.scopeWrite;
    if (w.scopeWrite !== 0) reasons.push("penalty:scope_write");
  } else if (scope === "read") {
    dimensions.scopeAdjust = w.scopeRead;
    if (w.scopeRead !== 0) reasons.push("bonus:scope_read");
  }

  // 6. Source layer
  const layer = String((params.def as any)?.sourceLayer ?? "builtin");
  if (layer === "kernel") {
    dimensions.layerBonus = w.layerKernel;
    if (w.layerKernel !== 0) reasons.push("bonus:layer_kernel");
  } else if (layer === "builtin") {
    dimensions.layerBonus = w.layerBuiltin;
    if (w.layerBuiltin !== 0) reasons.push("bonus:layer_builtin");
  } else {
    dimensions.layerBonus = w.layerExtension;
    if (w.layerExtension !== 0) reasons.push("bonus:layer_extension");
  }

  // 7. Description match (i18n-aware: check zh-CN and en-US)
  const desc = params.def?.description;
  if (desc && typeof desc === "object") {
    const texts = Object.values(desc as Record<string, string>).map((v) => String(v ?? "").toLowerCase());
    const descMatch = texts.some((t) => t && goalLower.split(/\s+/).some((word) => word.length >= 2 && t.includes(word)));
    if (descMatch) {
      dimensions.descriptionMatch = w.descriptionMatch;
      reasons.push("match:description");
    }
  }

  // 8. ResourceType match
  const rt = String(params.def?.resourceType ?? "").toLowerCase();
  if (rt && goalLower.includes(rt)) {
    dimensions.resourceTypeMatch = w.resourceTypeMatch;
    reasons.push("match:resource_type");
  }

  // 9. Historical success rate (cold start = ignored)
  if (typeof params.historicalRate === "number" && Number.isFinite(params.historicalRate)) {
    const rate = Math.max(0, Math.min(1, params.historicalRate));
    dimensions.historicalSuccess = Math.round(rate * w.historicalSuccessRate * 100) / 100;
    reasons.push(`historical:${Math.round(rate * 100)}%`);
  }

  const total = Object.values(dimensions).reduce((sum, v) => sum + v, 0);
  return { total, dimensions, reasons };
}

export async function buildHeuristicPlanV4(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  goal: string;
  suggestions: any[];
  allowedTools: Set<string> | null;
  allowWrites: boolean;
  maxSteps: number;
  /** Optional custom scoring weights. */
  weights?: Partial<ScoringWeights>;
  /** Optional historical success rates keyed by tool name. */
  historicalRates?: Map<string, number>;
}) {
  const candidates: any[] = [];
  const rejected: any[] = [];
  for (const s of params.suggestions) {
    const rawToolRef = typeof (s as any)?.toolRef === "string" ? String((s as any).toolRef) : "";
    if (!rawToolRef) continue;
    const at = rawToolRef.lastIndexOf("@");
    const toolName = at > 0 ? rawToolRef.slice(0, at) : rawToolRef;
    const effToolRef = at > 0 ? rawToolRef : await resolveEffectiveToolRef({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId, name: toolName });
    if (!effToolRef) {
      rejected.push({ toolRef: rawToolRef, reason: "tool_ref_unresolved" });
      continue;
    }
    if (params.allowedTools && !params.allowedTools.has(toolName) && !params.allowedTools.has(rawToolRef) && !params.allowedTools.has(effToolRef)) {
      rejected.push({ toolRef: effToolRef, reason: "not_in_allowed_tools" });
      continue;
    }

    const ver = await getToolVersionByRef(params.pool, params.tenantId, effToolRef);
    if (!ver || String(ver.status) !== "released") {
      rejected.push({ toolRef: effToolRef, reason: "tool_version_not_released" });
      continue;
    }
    const enabled = await isToolEnabled({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId, toolRef: effToolRef });
    if (!enabled) {
      rejected.push({ toolRef: effToolRef, reason: "tool_disabled" });
      continue;
    }

    const def = await getToolDefinition(params.pool, params.tenantId, toolName);
    if (!def?.scope || !def?.resourceType || !def?.action) {
      rejected.push({ toolRef: effToolRef, reason: "tool_contract_missing" });
      continue;
    }
    if (!params.allowWrites && def.scope === "write") {
      rejected.push({ toolRef: effToolRef, reason: "writes_not_allowed" });
      continue;
    }
    const pre = await authorize({ pool: params.pool, subjectId: params.subjectId, tenantId: params.tenantId, spaceId: params.spaceId, resourceType: def.resourceType, action: def.action });
    if (pre.decision !== "allow") {
      rejected.push({ toolRef: effToolRef, reason: "permission_denied" });
      continue;
    }
    const inputDraft = typeof (s as any)?.inputDraft === "object" && (s as any).inputDraft && !Array.isArray((s as any).inputDraft) ? (s as any).inputDraft : {};
    const breakdown = structuredScore({
      goal: params.goal,
      toolName,
      def,
      weights: params.weights,
      historicalRate: params.historicalRates?.get(toolName) ?? null,
    });
    candidates.push({ toolRef: effToolRef, toolName, inputDraft, inputDraftDigest: digestParams(inputDraft), def, score: breakdown.total, reasons: breakdown.reasons, scoreBreakdown: breakdown });
  }

  const rejectedCanon = rejected
    .map((r) => ({ toolRef: String(r.toolRef ?? ""), reason: String(r.reason ?? "") }))
    .filter((r) => r.toolRef)
    .sort((a, b) => (a.toolRef < b.toolRef ? -1 : a.toolRef > b.toolRef ? 1 : a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));
  const rejectedCandidatesDigest = { total: candidates.length + rejectedCanon.length, rejected: rejectedCanon.length, sha256_8: sha256_8(JSON.stringify(rejectedCanon)) };

  candidates.sort((a, b) => {
    const sa = Number(a.score ?? 0);
    const sb = Number(b.score ?? 0);
    if (sa !== sb) return sb - sa;
    const ra = String(a.toolRef ?? "");
    const rb = String(b.toolRef ?? "");
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });

  const planSteps: any[] = [];
  for (const c of candidates.slice(0, params.maxSteps)) {
    const approvalRequired = Boolean(c.def?.approvalRequired) || c.def?.riskLevel === "high";
    planSteps.push({
      stepId: crypto.randomUUID(),
      actorRole: "executor",
      kind: "tool",
      toolRef: c.toolRef,
      inputDraft: c.inputDraft,
      inputDraftDigest: c.inputDraftDigest,
      approvalRequired,
      riskLevel: c.def?.riskLevel ?? null,
      selection: { score: c.score, reasons: c.reasons, scoreBreakdown: c.scoreBreakdown, rejectedCandidatesDigest },
    });
  }

  return { planSteps, rejectedCandidatesDigest, explain: buildPlanExplanation(candidates, rejected, planSteps) };
}

/* ================================================================== */
/*  Plan Explanation (7.4)                                              */
/* ================================================================== */

/** Structured explanation of why tools were selected or rejected. */
export interface PlanExplanation {
  /** Summary of the plan. */
  summary: string;
  /** Details for each selected tool step. */
  selected: Array<{
    toolRef: string;
    toolName: string;
    score: number;
    reasons: string[];
    scoreBreakdown: ScoreBreakdown;
  }>;
  /** Details for each rejected candidate. */
  rejected: Array<{
    toolRef: string;
    reason: string;
  }>;
  /** Candidate count vs. selected count. */
  candidateCount: number;
  selectedCount: number;
  rejectedCount: number;
}

function buildPlanExplanation(
  candidates: any[],
  rejected: any[],
  planSteps: any[],
): PlanExplanation {
  const selected = planSteps.map((ps) => {
    const c = candidates.find((cc) => cc.toolRef === ps.toolRef);
    return {
      toolRef: ps.toolRef,
      toolName: c?.toolName ?? ps.toolRef,
      score: c?.score ?? 0,
      reasons: c?.reasons ?? [],
      scoreBreakdown: c?.scoreBreakdown ?? { total: 0, dimensions: {}, reasons: [] },
    };
  });
  const rejectedItems = rejected.map((r) => ({
    toolRef: String(r.toolRef ?? ""),
    reason: String(r.reason ?? ""),
  }));
  const summary = planSteps.length > 0
    ? `Selected ${planSteps.length} tool(s) from ${candidates.length + rejected.length} candidates (${rejected.length} rejected).`
    : `No tools selected. ${rejected.length} candidate(s) rejected, ${candidates.length} scored but not picked.`;
  return {
    summary,
    selected,
    rejected: rejectedItems,
    candidateCount: candidates.length + rejected.length,
    selectedCount: planSteps.length,
    rejectedCount: rejected.length,
  };
}

/* ================================================================== */
/*  Replan / Fallback Mechanism (7.5)                                   */
/* ================================================================== */

export interface ReplanConfig {
  /** Maximum number of replan attempts (default 2). */
  maxReplanAttempts: number;
  /** Whether to broaden scope on replan (e.g. relax allowedTools). */
  broadenScopeOnReplan: boolean;
  /** Fallback strategy when all replan attempts fail. */
  fallbackStrategy: "empty" | "best_effort" | "error";
}

export const DEFAULT_REPLAN_CONFIG: Readonly<ReplanConfig> = {
  maxReplanAttempts: 2,
  broadenScopeOnReplan: true,
  fallbackStrategy: "empty",
};

export interface ReplanResult {
  planSteps: any[];
  rejectedCandidatesDigest: any;
  explain: PlanExplanation;
  /** Number of replan attempts that were actually executed. */
  replanAttempts: number;
  /** Whether the result came from a fallback strategy. */
  usedFallback: boolean;
}

/**
 * Attempt planning with automatic replan on failure.
 *
 * If the initial plan produces no steps, replan up to `config.maxReplanAttempts`
 * times. On each retry:
 *   - If `broadenScopeOnReplan` is true, allowedTools is relaxed to null
 *   - maxSteps is incremented by 1
 *
 * Guards against infinite loops via hard cap on attempts.
 */
export async function replanOnFailure(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  goal: string;
  suggestions: any[];
  allowedTools: Set<string> | null;
  allowWrites: boolean;
  maxSteps: number;
  weights?: Partial<ScoringWeights>;
  historicalRates?: Map<string, number>;
  replanConfig?: Partial<ReplanConfig>;
}): Promise<ReplanResult> {
  const config: ReplanConfig = { ...DEFAULT_REPLAN_CONFIG, ...params.replanConfig };
  // Hard cap: never exceed 5 attempts to prevent infinite loops
  const maxAttempts = Math.min(Math.max(0, config.maxReplanAttempts), 5);

  let attempt = 0;
  let result = await buildHeuristicPlanV4(params);

  while (result.planSteps.length === 0 && attempt < maxAttempts) {
    attempt++;
    const relaxedParams = {
      ...params,
      // Broaden scope: relax allowed tools on retry
      allowedTools: config.broadenScopeOnReplan ? null : params.allowedTools,
      // Slightly increase step budget on retry
      maxSteps: params.maxSteps + attempt,
    };
    result = await buildHeuristicPlanV4(relaxedParams);
  }

  if (result.planSteps.length === 0 && config.fallbackStrategy === "error") {
    throw new Error(`Planner exhausted ${attempt + 1} attempts with no executable steps`);
  }

  return {
    planSteps: result.planSteps,
    rejectedCandidatesDigest: result.rejectedCandidatesDigest,
    explain: result.explain,
    replanAttempts: attempt,
    usedFallback: result.planSteps.length === 0 && attempt > 0,
  };
}
