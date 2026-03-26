/**
 * Step 密封与摘要计算
 * 从 processStep.ts 拆分出来
 */

import type { Pool } from "pg";
import { normalizeStepStatus, normalizeRunStatus, tryTransitionStep, tryTransitionRun } from "@openslin/shared";
import { computeSealedDigestV1 } from "./sealed";

// ────────────────────────────────────────────────────────────────
// 状态转换验证
// ────────────────────────────────────────────────────────────────

/**
 * 验证 Step 状态转换是否合法
 * Warn-only, 不阻塞执行（向后兼容）
 */
export function validateStepTransition(stepId: string, fromRaw: string, toRaw: string): boolean {
  const from = normalizeStepStatus(fromRaw);
  const to = normalizeStepStatus(toRaw);
  if (!from || !to) return true;
  const result = tryTransitionStep(from, to);
  if (!result.ok) {
    console.warn(`[state-machine] ${result.violation?.message ?? "unknown"} (stepId=${stepId})`);
    return false;
  }
  return true;
}

/**
 * 验证 Run 状态转换是否合法
 * Warn-only, 不阻塞执行（向后兼容）
 */
export function validateRunTransition(runId: string, fromRaw: string, toRaw: string): boolean {
  const from = normalizeRunStatus(fromRaw);
  const to = normalizeRunStatus(toRaw);
  if (!from || !to) return true;
  const result = tryTransitionRun(from, to);
  if (!result.ok) {
    console.warn(`[state-machine] ${result.violation?.message ?? "unknown"} (runId=${runId})`);
    return false;
  }
  return true;
}

// ────────────────────────────────────────────────────────────────
// Run 完成密封
// ────────────────────────────────────────────────────────────────

/**
 * 当 Run 完成时（succeeded/failed/canceled/compensated），计算并写入密封摘要
 */
export async function sealRunIfFinished(params: { pool: Pool; runId: string }): Promise<void> {
  const res = await params.pool.query(
    "SELECT tenant_id, status, tool_ref, policy_snapshot_ref, input_digest FROM runs WHERE run_id = $1 LIMIT 1",
    [params.runId],
  );
  if (!res.rowCount) return;

  const r = res.rows[0];
  const status = String(r.status ?? "");

  // 只处理终态
  if (!(status === "succeeded" || status === "failed" || status === "canceled" || status === "compensated")) {
    return;
  }

  // 获取所有 Step 摘要
  const stepsRes = await params.pool.query(
    "SELECT seq, tool_ref, sealed_output_digest, error_category FROM steps WHERE run_id = $1 ORDER BY seq ASC",
    [params.runId],
  );

  const steps = stepsRes.rows.map((x: any) => ({
    seq: Number(x.seq ?? 0) || 0,
    toolRef: x.tool_ref ? String(x.tool_ref) : null,
    sealedOutputDigest: x.sealed_output_digest ?? null,
    errorCategory: x.error_category ?? null,
  }));

  // 计算密封摘要
  const sealedInputDigest = computeSealedDigestV1(r.input_digest ?? null);
  const sealedOutputDigest = computeSealedDigestV1({
    status,
    toolRef: r.tool_ref ?? null,
    policySnapshotRef: r.policy_snapshot_ref ?? null,
    steps,
  });

  // 写入密封信息
  await params.pool.query(
    `
      UPDATE runs
      SET sealed_at = COALESCE(sealed_at, now()),
          sealed_schema_version = COALESCE(sealed_schema_version, 1),
          sealed_input_digest = COALESCE(sealed_input_digest, $2),
          sealed_output_digest = COALESCE(sealed_output_digest, $3),
          nondeterminism_policy = COALESCE(nondeterminism_policy, $4),
          updated_at = now()
      WHERE run_id = $1
    `,
    [params.runId, sealedInputDigest, sealedOutputDigest, { ignoredJsonPaths: ["latencyMs"] }],
  );
}

// ────────────────────────────────────────────────────────────────
// 输出摘要构建
// ────────────────────────────────────────────────────────────────

import type { EgressEvent, NetworkPolicy, RuntimeLimits } from "./runtime";
import { sha256Hex, stableStringify, digestObject } from "./common";
import { computeEvidenceDigestV1, deriveIsolation } from "./sealed";

export interface OutputDigestParams {
  latencyMs: number;
  egress: EgressEvent[];
  limits: RuntimeLimits;
  networkPolicy: NetworkPolicy;
  depsDigest: string | null;
  artifactRef: string | null;
  runtimeBackend: string;
  degraded: boolean;
  runnerSummary: any;
  scrubbedOutput: any;
  toolName: string;
  outputBytes: number;
}

export interface SealedDigest {
  len: number;
  sha256_8: string;
}

export interface Isolation {
  level: string;
  enforced: boolean;
}

export interface OutputDigestResult {
  outputDigest: any;
  sealedOutputDigest: SealedDigest;
  isolation: Isolation;
  egressDigest: { sha256_8: string; count: number };
  artifactId: string | null;
  supplyChain: {
    depsDigest: string | null;
    artifactId: string | null;
    artifactRef: string | null;
    sbomDigest: string | null;
    verified: boolean;
  };
}

/**
 * 构建成功执行的输出摘要
 */
export function buildOutputDigest(params: OutputDigestParams, sbomDigest: string | null): OutputDigestResult {
  const {
    latencyMs,
    egress,
    limits,
    networkPolicy,
    depsDigest,
    artifactRef,
    runtimeBackend,
    degraded,
    runnerSummary,
    scrubbedOutput,
    toolName,
    outputBytes,
  } = params;

  const artifactId = artifactRef && String(artifactRef).startsWith("artifact:")
    ? String(artifactRef).slice("artifact:".length).trim()
    : null;

  const isolation = deriveIsolation(runtimeBackend, degraded);

  const ev = toolName === "knowledge.search" ? computeEvidenceDigestV1(scrubbedOutput) : null;

  const egressDigest = {
    sha256_8: sha256Hex(stableStringify(egress)).slice(0, 8),
    count: egress.length,
  };

  const outputDigest = {
    latencyMs,
    egressSummary: egress,
    egressCount: egress.length,
    egressDigest,
    limitsSnapshot: limits,
    networkPolicySnapshot: networkPolicy,
    depsDigest,
    artifactId,
    artifactRef,
    runtimeBackend,
    degraded,
    runnerSummary,
    isolation,
    retrievalLogId: ev
      ? (typeof (scrubbedOutput as any)?.retrievalLogId === "string" ? String((scrubbedOutput as any).retrievalLogId) : "")
      : "",
    evidenceCount: ev ? ev.evidenceCount : 0,
    evidenceDigest: ev ? ev.evidenceDigest : null,
    outputBytes,
    outputKeys: digestObject(scrubbedOutput),
  };

  const sealedOutputDigest = computeSealedDigestV1(outputDigest);

  const supplyChain = {
    depsDigest,
    artifactId,
    artifactRef,
    sbomDigest,
    verified: true,
  };

  return {
    outputDigest,
    sealedOutputDigest,
    isolation,
    egressDigest,
    artifactId,
    supplyChain,
  };
}

// ────────────────────────────────────────────────────────────────
// 错误输出摘要构建
// ────────────────────────────────────────────────────────────────

export interface ErrorOutputDigestParams {
  egress: EgressEvent[];
  limits: RuntimeLimits;
  networkPolicy: NetworkPolicy;
  errorMessage: string;
  capabilityEnvelopeSummary: any;
  writeLease: any;
}

export interface ErrorOutputDigestResult {
  outputDigest: any;
  sealedOutputDigest: SealedDigest;
  isolation: Isolation;
  supplyChain: {
    depsDigest: null;
    artifactId: null;
    artifactRef: null;
    sbomDigest: null;
    verified: false;
  };
}

/**
 * 构建失败执行的输出摘要
 */
export function buildErrorOutputDigest(params: ErrorOutputDigestParams): ErrorOutputDigestResult {
  const { egress, limits, networkPolicy, errorMessage, capabilityEnvelopeSummary, writeLease } = params;

  const outputDigest = {
    latencyMs: null,
    egressSummary: egress,
    egressCount: egress.length,
    limitsSnapshot: limits,
    networkPolicySnapshot: networkPolicy,
    depsDigest: null,
    artifactRef: null,
    error: errorMessage,
    capabilityEnvelopeSummary,
    writeLease,
  };

  const sealedOutputDigest = computeSealedDigestV1(outputDigest);
  const isolation = deriveIsolation(null, false);

  return {
    outputDigest,
    sealedOutputDigest,
    isolation,
    supplyChain: {
      depsDigest: null,
      artifactId: null,
      artifactRef: null,
      sbomDigest: null,
      verified: false,
    },
  };
}
