import type { Pool } from "pg";
import crypto from "node:crypto";
import { AUDIT_ERROR_CATEGORIES, normalizeAuditErrorCategory } from "@openslin/shared";

export { AUDIT_ERROR_CATEGORIES };
export { normalizeAuditErrorCategory };

const HIGH_RISK_AUDIT_ACTIONS = new Set<string>([
  "audit:siem.destination.write",
  "audit:siem.destination.test",
  "audit:siem.destination.backfill",
  "audit:siem.dlq.clear",
  "audit:siem.dlq.requeue",
]);

export function isHighRiskAuditAction(params: { resourceType?: string | null; action?: string | null }) {
  const resourceType = String(params.resourceType ?? "").trim();
  const action = String(params.action ?? "").trim();
  if (!resourceType || !action) return false;
  return HIGH_RISK_AUDIT_ACTIONS.has(`${resourceType}:${action}`);
}

export class AuditContractError extends Error {
  errorCode: string;
  httpStatus: number;
  details?: unknown;

  constructor(params: { errorCode: string; message: string; httpStatus?: number; details?: unknown }) {
    super(params.message);
    this.name = "AuditContractError";
    this.errorCode = params.errorCode;
    this.httpStatus = params.httpStatus ?? 409;
    this.details = params.details;
  }
}

function canonicalize(value: any): any {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object") return value;
  const out: any = {};
  const keys = Object.keys(value).sort();
  for (const k of keys) out[k] = canonicalize(value[k]);
  return out;
}

function stableStringify(value: any) {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function computeEventHash(params: { prevHash: string | null; normalized: any }) {
  const input = stableStringify({ prevHash: params.prevHash ?? null, event: params.normalized });
  return sha256Hex(input);
}

export type AuditEventInput = {
  subjectId?: string;
  tenantId?: string;
  spaceId?: string;
  resourceType: string;
  action: string;
  toolRef?: string;
  workflowRef?: string;
  policyDecision?: unknown;
  inputDigest?: unknown;
  outputDigest?: unknown;
  idempotencyKey?: string;
  result: "success" | "denied" | "error";
  traceId: string;
  requestId?: string;
  runId?: string;
  stepId?: string;
  policySnapshotRef?: string;
  errorCategory?: string;
  latencyMs?: number;
  outboxId?: string;
  timestamp?: string;
};

function withPolicySnapshotRef(policyDecision: unknown, policySnapshotRef: string | null) {
  if (!policySnapshotRef) return policyDecision ?? null;
  if (policyDecision && typeof policyDecision === "object" && !Array.isArray(policyDecision)) {
    const base = policyDecision as Record<string, unknown>;
    if (typeof base.policySnapshotRef === "string" && base.policySnapshotRef.trim()) return base;
    if (typeof base.snapshotRef === "string" && base.snapshotRef.trim()) return { ...base, policySnapshotRef: base.snapshotRef };
    return { ...base, policySnapshotRef };
  }
  return { policySnapshotRef };
}

export async function insertAuditEvent(pool: Pool, e: AuditEventInput) {
  if (process.env.AUDIT_FORCE_FAIL === "1") throw new Error("audit_force_fail");
  const policySnapshotRef = String(e.policySnapshotRef ?? "").trim() || null;
  const missingContextFields: string[] = [];
  if (isHighRiskAuditAction({ resourceType: e.resourceType, action: e.action })) {
    if (!String(e.runId ?? "").trim()) missingContextFields.push("runId");
    if (!String(e.stepId ?? "").trim()) missingContextFields.push("stepId");
    if (!policySnapshotRef) missingContextFields.push("policySnapshotRef");
    if (missingContextFields.length > 0) {
      throw new AuditContractError({
        errorCode: "AUDIT_CONTEXT_REQUIRED",
        message: "high_risk_audit_context_required",
        details: {
          resourceType: e.resourceType,
          action: e.action,
          missing: missingContextFields,
        },
      });
    }
  }
  const policyDecision = withPolicySnapshotRef(e.policyDecision, policySnapshotRef);
  const errorCategory = normalizeAuditErrorCategory(e.errorCategory);
  if (!e.tenantId) {
    await pool.query(
      `
        INSERT INTO audit_events (
          subject_id, tenant_id, space_id, resource_type, action,
          tool_ref, workflow_ref, policy_decision, input_digest, output_digest,
          idempotency_key, result, trace_id, request_id, run_id, step_id, error_category, latency_ms, outbox_id
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19
        )
      `,
      [
        e.subjectId ?? null,
        e.tenantId ?? null,
        e.spaceId ?? null,
        e.resourceType,
        e.action,
        e.toolRef ?? null,
        e.workflowRef ?? null,
        policyDecision,
        e.inputDigest ?? null,
        e.outputDigest ?? null,
        e.idempotencyKey ?? null,
        e.result,
        e.traceId,
        e.requestId ?? null,
        e.runId ?? null,
        e.stepId ?? null,
        errorCategory,
        e.latencyMs ?? null,
        e.outboxId ?? null,
      ],
    );
    return;
  }

  const ts0 = e.outboxId ? new Date().toISOString() : (e.timestamp ?? new Date().toISOString());
  const normalizedBase = {
    subjectId: e.subjectId ?? null,
    tenantId: e.tenantId ?? null,
    spaceId: e.spaceId ?? null,
    resourceType: e.resourceType,
    action: e.action,
    toolRef: e.toolRef ?? null,
    workflowRef: e.workflowRef ?? null,
    result: e.result,
    traceId: e.traceId,
    requestId: e.requestId ?? null,
    runId: e.runId ?? null,
    stepId: e.stepId ?? null,
    idempotencyKey: e.idempotencyKey ?? null,
    errorCategory,
    latencyMs: e.latencyMs ?? null,
    policyDecision,
    inputDigest: e.inputDigest ?? null,
    outputDigest: e.outputDigest ?? null,
    outboxId: e.outboxId ?? null,
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [e.tenantId]);
    const prevRes = await client.query(
      "SELECT event_hash, timestamp FROM audit_events WHERE tenant_id = $1 AND event_hash IS NOT NULL ORDER BY timestamp DESC, event_id DESC LIMIT 1",
      [e.tenantId],
    );
    const prevHash = prevRes.rowCount ? (prevRes.rows[0].event_hash as string | null) : null;
    const prevTs = prevRes.rowCount ? (prevRes.rows[0].timestamp as any) : null;
    let ts = ts0;
    const tsMs = new Date(ts0).getTime();
    const prevMs = prevTs ? new Date(prevTs).getTime() : NaN;
    if (Number.isFinite(prevMs) && Number.isFinite(tsMs) && tsMs <= prevMs) ts = new Date(Math.max(Date.now(), prevMs + 1)).toISOString();
    if (!Number.isFinite(tsMs) && Number.isFinite(prevMs)) ts = new Date(Math.max(Date.now(), prevMs + 1)).toISOString();
    const normalized = { timestamp: ts, ...normalizedBase };
    const eventHash = computeEventHash({ prevHash, normalized });

    await client.query(
      `
        INSERT INTO audit_events (
          timestamp, subject_id, tenant_id, space_id, resource_type, action,
          tool_ref, workflow_ref, policy_decision, input_digest, output_digest,
          idempotency_key, result, trace_id, request_id, run_id, step_id, error_category, latency_ms,
          prev_hash, event_hash, outbox_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16, $17, $18, $19,
          $20, $21, $22
        )
      `,
      [
        ts,
        e.subjectId ?? null,
        e.tenantId ?? null,
        e.spaceId ?? null,
        e.resourceType,
        e.action,
        e.toolRef ?? null,
        e.workflowRef ?? null,
        policyDecision,
        e.inputDigest ?? null,
        e.outputDigest ?? null,
        e.idempotencyKey ?? null,
        e.result,
        e.traceId,
        e.requestId ?? null,
        e.runId ?? null,
        e.stepId ?? null,
        errorCategory,
        e.latencyMs ?? null,
        prevHash,
        eventHash,
        e.outboxId ?? null,
      ],
    );
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
    }
    throw err;
  } finally {
    client.release();
  }
}
