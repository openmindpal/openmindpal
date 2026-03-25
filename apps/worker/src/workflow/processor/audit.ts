import type { Pool } from "pg";
import { attachDlpSummary, normalizeAuditErrorCategory, redactValue, resolveDlpPolicy, resolveDlpPolicyFromEnv, shouldDenyDlpForTarget } from "@openslin/shared";
import { sha256Hex, stableStringify } from "./common";

function computeEventHash(params: { prevHash: string | null; normalized: any }) {
  const input = stableStringify({ prevHash: params.prevHash ?? null, event: params.normalized });
  return sha256Hex(input);
}

const policyCache = new Map<string, { at: number; policyJson: any | null; policyDigest: string | null }>();

async function getEffectiveContentPolicy(pool: Pool, tenantId: string, spaceId: string | null) {
  const key = `${tenantId}|${spaceId ?? ""}`;
  const now = Date.now();
  const hit = policyCache.get(key);
  if (hit && now - hit.at < 5000) return hit;
  const res = await pool.query(
    `
      SELECT p.policy_id, COALESCE(ov.active_version, av.active_version) AS active_version
      FROM safety_policies p
      LEFT JOIN safety_policy_active_versions av ON av.tenant_id = p.tenant_id AND av.policy_id = p.policy_id
      LEFT JOIN safety_policy_active_overrides ov ON ov.tenant_id = p.tenant_id AND ov.policy_id = p.policy_id AND ov.space_id = $2
      WHERE p.tenant_id = $1 AND p.policy_type = 'content'
      ORDER BY p.created_at DESC
      LIMIT 1
    `,
    [tenantId, spaceId ?? ""],
  );
  if (!res.rowCount) {
    const empty = { at: now, policyJson: null, policyDigest: null };
    policyCache.set(key, empty);
    return empty;
  }
  const policyId = String(res.rows[0].policy_id);
  const version = res.rows[0].active_version === null || res.rows[0].active_version === undefined ? null : Number(res.rows[0].active_version);
  if (!version) {
    const empty = { at: now, policyJson: null, policyDigest: null };
    policyCache.set(key, empty);
    return empty;
  }
  const ver = await pool.query(`SELECT policy_json, policy_digest, status FROM safety_policy_versions WHERE policy_id = $1 AND version = $2 LIMIT 1`, [policyId, version]);
  if (!ver.rowCount || String(ver.rows[0].status) !== "released") {
    const empty = { at: now, policyJson: null, policyDigest: null };
    policyCache.set(key, empty);
    return empty;
  }
  const out = { at: now, policyJson: ver.rows[0].policy_json ?? null, policyDigest: String(ver.rows[0].policy_digest ?? "") || null };
  policyCache.set(key, out);
  return out;
}

export async function writeAudit(
  pool: Pool,
  e: {
    traceId: string;
    tenantId?: string;
    spaceId?: string | null;
    subjectId?: string | null;
    runId?: string;
    stepId?: string;
    toolRef?: string;
    resourceType?: string;
    action?: string;
    result: "success" | "error";
    inputDigest?: any;
    outputDigest?: any;
    errorCategory?: string;
  },
) {
  const errorCategory = normalizeAuditErrorCategory(e.errorCategory);
  const redactedIn = redactValue(e.inputDigest);
  const redactedOut = redactValue(e.outputDigest);
  const target = `${e.resourceType ?? "tool"}:${e.action ?? "execute"}`;
  const eff = e.tenantId ? await getEffectiveContentPolicy(pool, e.tenantId, e.spaceId ?? null) : null;
  const dlpPolicy = eff?.policyJson ? resolveDlpPolicy(eff.policyJson) : resolveDlpPolicyFromEnv(process.env);
  const denied = shouldDenyDlpForTarget({ summary: redactedOut.summary, target, policy: dlpPolicy });
  const dlpSummary = denied
    ? { ...redactedOut.summary, disposition: "deny" as const, redacted: true, mode: dlpPolicy.mode, policyVersion: dlpPolicy.version }
    : redactedOut.summary.redacted
      ? { ...redactedOut.summary, disposition: "redact" as const, mode: dlpPolicy.mode, policyVersion: dlpPolicy.version }
      : { ...redactedOut.summary, mode: dlpPolicy.mode, policyVersion: dlpPolicy.version };
  const outputDigest0 = attachDlpSummary(redactedOut.value, dlpSummary);
  const outputDigest =
    outputDigest0 && typeof outputDigest0 === "object" && !Array.isArray(outputDigest0)
      ? (() => {
          const obj: any = outputDigest0 as any;
          if (obj.safetySummary && typeof obj.safetySummary === "object" && !Array.isArray(obj.safetySummary)) {
            const ss: any = obj.safetySummary;
            if (!ss.dlpSummary) ss.dlpSummary = dlpSummary;
            if (!ss.decision) ss.decision = denied ? "denied" : "allowed";
            if (eff?.policyDigest && !ss.policyRefsDigest) ss.policyRefsDigest = { contentPolicyDigest: String(eff.policyDigest) };
          } else if (obj.safetySummary === undefined) {
            obj.safetySummary = {
              decision: denied ? "denied" : "allowed",
              dlpSummary,
              ...(eff?.policyDigest ? { policyRefsDigest: { contentPolicyDigest: String(eff.policyDigest) } } : {}),
            };
          }
          return obj;
        })()
      : outputDigest0;
  const normalizedBase = {
    subjectId: e.subjectId ?? null,
    tenantId: e.tenantId ?? null,
    spaceId: e.spaceId ?? null,
    resourceType: e.resourceType ?? "tool",
    action: e.action ?? "execute",
    toolRef: e.toolRef ?? null,
    workflowRef: e.runId ?? null,
    result: e.result,
    traceId: e.traceId,
    requestId: null,
    runId: e.runId ?? null,
    stepId: e.stepId ?? null,
    idempotencyKey: null,
    errorCategory,
    latencyMs: null,
    policyDecision: null,
    inputDigest: redactedIn.value ?? null,
    outputDigest: outputDigest ?? null,
  };

  if (!e.tenantId) {
    const ts = new Date().toISOString();
    const normalized = { timestamp: ts, ...normalizedBase };
    await pool.query(
      `
        INSERT INTO audit_events (timestamp, subject_id, tenant_id, space_id, resource_type, action, tool_ref, workflow_ref, input_digest, output_digest, result, trace_id, run_id, step_id, error_category)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      `,
      [
        ts,
        e.subjectId ?? null,
        null,
        e.spaceId ?? null,
        normalized.resourceType,
        normalized.action,
        e.toolRef ?? null,
        e.runId ?? null,
        redactedIn.value ?? null,
        outputDigest ?? null,
        e.result,
        e.traceId,
        e.runId ?? null,
        e.stepId ?? null,
        errorCategory,
      ],
    );
    return;
  }

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
    const prevMs = prevTs ? new Date(prevTs).getTime() : NaN;
    const ts = new Date(Math.max(Date.now(), Number.isFinite(prevMs) ? prevMs + 1 : 0)).toISOString();
    const normalized = { timestamp: ts, ...normalizedBase };
    const eventHash = computeEventHash({ prevHash, normalized });

    await client.query(
      `
        INSERT INTO audit_events (
          timestamp, subject_id, tenant_id, space_id, resource_type, action,
          tool_ref, workflow_ref, input_digest, output_digest,
          result, trace_id, run_id, step_id, error_category,
          prev_hash, event_hash
        ) VALUES (
          $1,$2,$3,$4,$5,$6,
          $7,$8,$9,$10,
          $11,$12,$13,$14,$15,
          $16,$17
        )
      `,
      [
        ts,
        e.subjectId ?? null,
        e.tenantId,
        e.spaceId ?? null,
        normalized.resourceType,
        normalized.action,
        e.toolRef ?? null,
        e.runId ?? null,
        redactedIn.value ?? null,
        outputDigest ?? null,
        e.result,
        e.traceId,
        e.runId ?? null,
        e.stepId ?? null,
        errorCategory,
        prevHash,
        eventHash,
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
