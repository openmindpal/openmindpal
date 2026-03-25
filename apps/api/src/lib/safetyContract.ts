/**
 * Safety Policy Contract — kernel-level effective policy lookup.
 *
 * This module lives in lib/ so that plugins/dlp.ts and kernel routes
 * (tools.ts, models.ts) can query safety policy WITHOUT importing from
 * the safety-policy Skill's modules.
 */
import type { Pool } from "pg";

export type SafetyPolicyType = "content" | "injection" | "risk";

export async function getEffectiveSafetyPolicyVersion(params: { pool: Pool; tenantId: string; spaceId: string | null; policyType: SafetyPolicyType }) {
  const res = await params.pool.query(
    `
      SELECT p.policy_id, p.policy_type, p.name,
             COALESCE(ov.active_version, av.active_version) AS active_version
      FROM safety_policies p
      LEFT JOIN safety_policy_active_versions av
        ON av.tenant_id = p.tenant_id AND av.policy_id = p.policy_id
      LEFT JOIN safety_policy_active_overrides ov
        ON ov.tenant_id = p.tenant_id AND ov.policy_id = p.policy_id AND ov.space_id = $2
      WHERE p.tenant_id = $1 AND p.policy_type = $3
      ORDER BY p.created_at DESC
      LIMIT 1
    `,
    [params.tenantId, params.spaceId ?? "", params.policyType],
  );
  if (!res.rowCount) return null;
  const r = res.rows[0] as any;
  const version = r.active_version === null || r.active_version === undefined ? null : Number(r.active_version);
  if (!version) return null;
  const ver = await params.pool.query(
    `SELECT policy_json, policy_digest, status FROM safety_policy_versions WHERE policy_id = $1 AND version = $2 LIMIT 1`,
    [String(r.policy_id), version],
  );
  if (!ver.rowCount) return null;
  const row = ver.rows[0] as any;
  if (String(row.status) !== "released") return null;
  return {
    policyId: String(r.policy_id),
    policyType: String(r.policy_type) as SafetyPolicyType,
    name: String(r.name),
    version,
    policyJson: row.policy_json ?? null,
    policyDigest: String(row.policy_digest),
  };
}
