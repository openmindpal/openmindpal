import type { Pool } from "pg";
import { sha256Hex } from "../../../lib/digest";

export type SafetyPolicyType = "content" | "injection" | "risk";
export type SafetyPolicyVersionStatus = "draft" | "submitted" | "approved" | "released";

export type SafetyPolicyRow = {
  policyId: string;
  tenantId: string;
  policyType: SafetyPolicyType;
  name: string;
  createdAt: string;
};

export type SafetyPolicyVersionRow = {
  policyId: string;
  version: number;
  status: SafetyPolicyVersionStatus;
  policyJson: unknown;
  policyDigest: string;
  createdAt: string;
  publishedAt: string | null;
};

function stableStringify(v: unknown): string {
  if (v === null) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function digestSafetyPolicyJson(policyJson: unknown) {
  return sha256Hex(stableStringify(policyJson));
}

export async function listSafetyPolicies(params: { pool: Pool; tenantId: string; policyType?: SafetyPolicyType | null; limit: number }) {
  const limit = Math.max(1, Math.min(200, params.limit));
  const res = await params.pool.query(
    `
      SELECT p.policy_id, p.tenant_id, p.policy_type, p.name, p.created_at,
             av.active_version,
             lv.version AS latest_version, lv.status AS latest_status, lv.policy_digest AS latest_digest, lv.created_at AS latest_created_at, lv.published_at AS latest_published_at
      FROM safety_policies p
      LEFT JOIN safety_policy_active_versions av
        ON av.tenant_id = p.tenant_id AND av.policy_id = p.policy_id
      LEFT JOIN LATERAL (
        SELECT version, status, policy_digest, created_at, published_at
        FROM safety_policy_versions
        WHERE policy_id = p.policy_id
        ORDER BY version DESC
        LIMIT 1
      ) lv ON TRUE
      WHERE p.tenant_id = $1
        AND ($2::TEXT IS NULL OR p.policy_type = $2)
      ORDER BY p.created_at DESC
      LIMIT $3
    `,
    [params.tenantId, params.policyType ?? null, limit],
  );
  return res.rows.map((r) => ({
    policy: {
      policyId: String(r.policy_id),
      tenantId: String(r.tenant_id),
      policyType: String(r.policy_type) as SafetyPolicyType,
      name: String(r.name),
      createdAt: (r.created_at as Date).toISOString(),
    } satisfies SafetyPolicyRow,
    activeVersion: r.active_version === null || r.active_version === undefined ? null : Number(r.active_version),
    latest: r.latest_version
      ? ({
          policyId: String(r.policy_id),
          version: Number(r.latest_version),
          status: String(r.latest_status) as SafetyPolicyVersionStatus,
          policyJson: null,
          policyDigest: String(r.latest_digest),
          createdAt: (r.latest_created_at as Date).toISOString(),
          publishedAt: r.latest_published_at ? (r.latest_published_at as Date).toISOString() : null,
        } satisfies SafetyPolicyVersionRow)
      : null,
  }));
}

export async function getSafetyPolicy(params: { pool: Pool; tenantId: string; policyId: string }) {
  const res = await params.pool.query(`SELECT policy_id, tenant_id, policy_type, name, created_at FROM safety_policies WHERE tenant_id = $1 AND policy_id = $2 LIMIT 1`, [
    params.tenantId,
    params.policyId,
  ]);
  if (!res.rowCount) return null;
  const r = res.rows[0] as any;
  return {
    policyId: String(r.policy_id),
    tenantId: String(r.tenant_id),
    policyType: String(r.policy_type) as SafetyPolicyType,
    name: String(r.name),
    createdAt: (r.created_at as Date).toISOString(),
  } satisfies SafetyPolicyRow;
}

export async function createSafetyPolicyDraft(params: {
  pool: Pool;
  tenantId: string;
  policyType: SafetyPolicyType;
  name: string;
  policyJson: unknown;
}) {
  const digest = digestSafetyPolicyJson(params.policyJson);
  const res = await params.pool.query(
    `
      WITH p AS (
        INSERT INTO safety_policies (tenant_id, policy_type, name)
        VALUES ($1,$2,$3)
        ON CONFLICT (tenant_id, policy_type, name) DO UPDATE
        SET name = EXCLUDED.name
        RETURNING policy_id
      ),
      v AS (
        SELECT COALESCE(MAX(version), 0) + 1 AS next_version
        FROM safety_policy_versions
        WHERE policy_id = (SELECT policy_id FROM p)
      )
      INSERT INTO safety_policy_versions (policy_id, version, status, policy_json, policy_digest)
      VALUES ((SELECT policy_id FROM p), (SELECT next_version FROM v), 'draft', $4::jsonb, $5)
      RETURNING policy_id, version, status, policy_json, policy_digest, created_at, published_at
    `,
    [params.tenantId, params.policyType, params.name, params.policyJson, digest],
  );
  const r = res.rows[0] as any;
  return {
    policyId: String(r.policy_id),
    version: Number(r.version),
    status: String(r.status) as SafetyPolicyVersionStatus,
    policyJson: r.policy_json ?? null,
    policyDigest: String(r.policy_digest),
    createdAt: (r.created_at as Date).toISOString(),
    publishedAt: r.published_at ? (r.published_at as Date).toISOString() : null,
  } satisfies SafetyPolicyVersionRow;
}

export async function updateSafetyPolicyDraft(params: { pool: Pool; tenantId: string; policyId: string; version: number; policyJson: unknown }) {
  const digest = digestSafetyPolicyJson(params.policyJson);
  const res = await params.pool.query(
    `
      UPDATE safety_policy_versions v
      SET policy_json = $4::jsonb, policy_digest = $5, updated_at = now()
      WHERE v.policy_id = $1
        AND v.version = $2
        AND v.status = 'draft'
        AND EXISTS (SELECT 1 FROM safety_policies p WHERE p.policy_id = v.policy_id AND p.tenant_id = $3)
      RETURNING policy_id, version, status, policy_json, policy_digest, created_at, published_at
    `,
    [params.policyId, params.version, params.tenantId, params.policyJson, digest],
  );
  if (!res.rowCount) return null;
  const r = res.rows[0] as any;
  return {
    policyId: String(r.policy_id),
    version: Number(r.version),
    status: String(r.status) as SafetyPolicyVersionStatus,
    policyJson: r.policy_json ?? null,
    policyDigest: String(r.policy_digest),
    createdAt: (r.created_at as Date).toISOString(),
    publishedAt: r.published_at ? (r.published_at as Date).toISOString() : null,
  } satisfies SafetyPolicyVersionRow;
}

export async function listSafetyPolicyVersions(params: { pool: Pool; tenantId: string; policyId: string; limit: number }) {
  const limit = Math.max(1, Math.min(200, params.limit));
  const res = await params.pool.query(
    `
      SELECT v.policy_id, v.version, v.status, v.policy_digest, v.created_at, v.published_at
      FROM safety_policy_versions v
      JOIN safety_policies p ON p.policy_id = v.policy_id
      WHERE p.tenant_id = $1 AND p.policy_id = $2
      ORDER BY v.version DESC
      LIMIT $3
    `,
    [params.tenantId, params.policyId, limit],
  );
  return res.rows.map((r: any) => ({
    policyId: String(r.policy_id),
    version: Number(r.version),
    status: String(r.status) as SafetyPolicyVersionStatus,
    policyJson: null,
    policyDigest: String(r.policy_digest),
    createdAt: (r.created_at as Date).toISOString(),
    publishedAt: r.published_at ? (r.published_at as Date).toISOString() : null,
  })) satisfies SafetyPolicyVersionRow[];
}

export async function getSafetyPolicyVersion(params: { pool: Pool; tenantId: string; policyId: string; version: number }) {
  const res = await params.pool.query(
    `
      SELECT v.policy_id, v.version, v.status, v.policy_json, v.policy_digest, v.created_at, v.published_at
      FROM safety_policy_versions v
      JOIN safety_policies p ON p.policy_id = v.policy_id
      WHERE p.tenant_id = $1 AND p.policy_id = $2 AND v.version = $3
      LIMIT 1
    `,
    [params.tenantId, params.policyId, params.version],
  );
  if (!res.rowCount) return null;
  const r = res.rows[0] as any;
  return {
    policyId: String(r.policy_id),
    version: Number(r.version),
    status: String(r.status) as SafetyPolicyVersionStatus,
    policyJson: r.policy_json ?? null,
    policyDigest: String(r.policy_digest),
    createdAt: (r.created_at as Date).toISOString(),
    publishedAt: r.published_at ? (r.published_at as Date).toISOString() : null,
  } satisfies SafetyPolicyVersionRow;
}

export async function setSafetyPolicyVersionReleased(params: { pool: Pool; tenantId: string; policyId: string; version: number }) {
  const res = await params.pool.query(
    `
      UPDATE safety_policy_versions v
      SET status = 'released', published_at = COALESCE(published_at, now())
      WHERE v.policy_id = $1
        AND v.version = $2
        AND v.status IN ('draft','submitted','approved')
        AND EXISTS (SELECT 1 FROM safety_policies p WHERE p.policy_id = v.policy_id AND p.tenant_id = $3)
      RETURNING policy_id
    `,
    [params.policyId, params.version, params.tenantId],
  );
  return Boolean(res.rowCount);
}

export async function setActiveSafetyPolicyVersion(params: { pool: Pool; tenantId: string; policyId: string; version: number }) {
  await params.pool.query(
    `
      INSERT INTO safety_policy_active_versions (tenant_id, policy_id, active_version)
      VALUES ($1,$2,$3)
      ON CONFLICT (tenant_id, policy_id)
      DO UPDATE SET active_version = EXCLUDED.active_version, updated_at = now()
    `,
    [params.tenantId, params.policyId, params.version],
  );
}

export async function setActiveSafetyPolicyOverride(params: { pool: Pool; tenantId: string; spaceId: string; policyId: string; version: number }) {
  await params.pool.query(
    `
      INSERT INTO safety_policy_active_overrides (tenant_id, space_id, policy_id, active_version)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (tenant_id, space_id, policy_id)
      DO UPDATE SET active_version = EXCLUDED.active_version, updated_at = now()
    `,
    [params.tenantId, params.spaceId, params.policyId, params.version],
  );
}

export async function clearActiveSafetyPolicyOverride(params: { pool: Pool; tenantId: string; spaceId: string; policyId: string }) {
  await params.pool.query(`DELETE FROM safety_policy_active_overrides WHERE tenant_id = $1 AND space_id = $2 AND policy_id = $3`, [params.tenantId, params.spaceId, params.policyId]);
}

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

export async function rollbackActiveSafetyPolicyVersion(params: { pool: Pool; tenantId: string; policyId: string }) {
  const curRes = await params.pool.query(`SELECT active_version FROM safety_policy_active_versions WHERE tenant_id = $1 AND policy_id = $2 LIMIT 1`, [params.tenantId, params.policyId]);
  if (!curRes.rowCount) return null;
  const cur = Number(curRes.rows[0]!.active_version);
  const prevRes = await params.pool.query(
    `SELECT version FROM safety_policy_versions WHERE policy_id = $1 AND status = 'released' AND version < $2 ORDER BY version DESC LIMIT 1`,
    [params.policyId, cur],
  );
  if (!prevRes.rowCount) return null;
  const prev = Number(prevRes.rows[0]!.version);
  await setActiveSafetyPolicyVersion({ pool: params.pool, tenantId: params.tenantId, policyId: params.policyId, version: prev });
  return { from: cur, to: prev };
}

