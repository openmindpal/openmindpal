/**
 * Step 入参校验与架构不变式检查
 * 从 processStep.ts 拆分出来
 */

import { validateCapabilityEnvelopeV1 } from "@openslin/shared";
import { stableStringify } from "./common";
import type { NetworkPolicy, RuntimeLimits } from "./runtime";

// ────────────────────────────────────────────────────────────────
// 架构不变式检查 (P1-12)
// ────────────────────────────────────────────────────────────────

export interface InvariantCheckInput {
  stepId: string;
  runId: string;
  tenantId: string;
  toolRef: string | null;
  traceId: string;
  runStatus: string;
  stepStatus: string;
  isWriteTool: boolean;
  hasPolicySnapshotRef: boolean;
}

export interface InvariantViolation {
  code: string;
  message: string;
}

/**
 * 架构不变式检查 - Warn-only, 不阻塞执行
 */
export function checkExecutionInvariants(input: InvariantCheckInput): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  if (!input.tenantId) {
    violations.push({ code: "inv.missing_tenant_id", message: `step ${input.stepId}: missing tenantId` });
  }
  if (!input.traceId || input.traceId === "unknown") {
    violations.push({ code: "inv.missing_trace_id", message: `step ${input.stepId}: missing/unknown traceId` });
  }
  if (!input.toolRef) {
    violations.push({ code: "inv.missing_tool_ref", message: `step ${input.stepId}: missing toolRef` });
  }
  if (input.isWriteTool && !input.hasPolicySnapshotRef) {
    violations.push({ code: "inv.missing_policy_snapshot", message: `step ${input.stepId}: write tool "${input.toolRef}" missing policySnapshotRef` });
  }

  for (const v of violations) {
    console.warn(`[invariant] ${v.code}: ${v.message}`);
  }

  return violations;
}

// ────────────────────────────────────────────────────────────────
// 能力包络校验
// ────────────────────────────────────────────────────────────────

export interface CapabilityEnvelopeValidationParams {
  capRaw: unknown;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  toolContract: unknown;
  networkPolicy: NetworkPolicy;
  limits: RuntimeLimits;
}

export interface CapabilityEnvelopeValidationResult {
  ok: boolean;
  envelope: any | null;
  error?: Error;
}

/**
 * 校验能力包络是否存在、格式正确、与期望值一致
 */
export function validateCapabilityEnvelope(params: CapabilityEnvelopeValidationParams): CapabilityEnvelopeValidationResult {
  const { capRaw, tenantId, spaceId, subjectId, toolContract, networkPolicy, limits } = params;

  // 检查是否存在
  if (!capRaw) {
    const e: any = new Error("policy_violation:capability_envelope_missing");
    e.capabilityEnvelopeSummary = { status: "missing" };
    return { ok: false, envelope: null, error: e };
  }

  // 解析校验
  const parsed = validateCapabilityEnvelopeV1(capRaw);
  if (!parsed.ok) {
    const e: any = new Error("policy_violation:capability_envelope_invalid");
    e.capabilityEnvelopeSummary = { status: "invalid" };
    return { ok: false, envelope: null, error: e };
  }

  // 检查 toolContract
  const tc = toolContract;
  if (!tc || typeof tc !== "object" || Array.isArray(tc)) {
    const e: any = new Error("policy_violation:capability_envelope_mismatch:tool_contract_missing");
    e.capabilityEnvelopeSummary = { status: "mismatch", diffs: ["toolContract"] };
    return { ok: false, envelope: null, error: e };
  }

  // 构建期望值
  const spaceIdNorm = spaceId === null || spaceId === undefined ? null : String(spaceId);
  const subjectIdNorm = subjectId === null || subjectId === undefined ? null : String(subjectId);
  const expected = validateCapabilityEnvelopeV1({
    format: "capabilityEnvelope.v1",
    dataDomain: {
      tenantId,
      spaceId: spaceIdNorm,
      subjectId: subjectIdNorm,
      toolContract: {
        scope: String((tc as any).scope ?? ""),
        resourceType: String((tc as any).resourceType ?? ""),
        action: String((tc as any).action ?? ""),
        fieldRules: (tc as any).fieldRules ?? null,
        rowFilters: (tc as any).rowFilters ?? null,
      },
    },
    secretDomain: { connectorInstanceIds: [] },
    egressDomain: { networkPolicy },
    resourceDomain: { limits },
  });

  if (!expected.ok) {
    const e: any = new Error("policy_violation:capability_envelope_mismatch:expected_invalid");
    e.capabilityEnvelopeSummary = { status: "mismatch", diffs: ["expected"] };
    return { ok: false, envelope: null, error: e };
  }

  // 比较四域
  const diffs: string[] = [];
  if (stableStringify(parsed.envelope.dataDomain) !== stableStringify(expected.envelope.dataDomain)) diffs.push("dataDomain");
  if (stableStringify(parsed.envelope.secretDomain) !== stableStringify(expected.envelope.secretDomain)) diffs.push("secretDomain");
  if (stableStringify(parsed.envelope.egressDomain) !== stableStringify(expected.envelope.egressDomain)) diffs.push("egressDomain");
  if (stableStringify(parsed.envelope.resourceDomain) !== stableStringify(expected.envelope.resourceDomain)) diffs.push("resourceDomain");

  if (diffs.length) {
    const e: any = new Error(`policy_violation:capability_envelope_mismatch:${diffs.join(",")}`);
    e.capabilityEnvelopeSummary = { status: "mismatch", diffs };
    return { ok: false, envelope: null, error: e };
  }

  return { ok: true, envelope: parsed.envelope };
}

// ────────────────────────────────────────────────────────────────
// 写操作工具判断
// ────────────────────────────────────────────────────────────────

const SIDE_EFFECT_WRITE_TOOLS = new Set([
  "entity.create",
  "entity.update",
  "entity.delete",
  "memory.write",
  "entity.import",
  "space.restore",
]);

/**
 * 判断工具是否为副作用写操作
 */
export function isSideEffectWriteTool(toolName: string): boolean {
  return SIDE_EFFECT_WRITE_TOOLS.has(toolName);
}

/**
 * 判断工具是否需要幂等键
 */
export function requiresIdempotencyKey(toolName: string): boolean {
  return toolName === "entity.create" || toolName === "entity.update" || toolName === "entity.delete" || toolName === "memory.write";
}
