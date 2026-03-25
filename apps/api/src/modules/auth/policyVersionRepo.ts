import type { Pool } from "pg";
import crypto from "node:crypto";

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

export type PolicyVersionState = "draft" | "released" | "deprecated";

export type PolicyVersionRow = {
  id: string;
  tenantId: string;
  name: string;
  version: number;
  status: PolicyVersionState;
  policyJson: any;
  digest: string;
  createdAt: string;
  publishedAt: string | null;
};

function toRow(r: any): PolicyVersionRow {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    name: String(r.name),
    version: Number(r.version),
    status: String(r.status) as PolicyVersionState,
    policyJson: r.policy_json ?? null,
    digest: String(r.digest),
    createdAt: String(r.created_at),
    publishedAt: r.published_at ? String(r.published_at) : null,
  };
}

export async function createDraftPolicyVersion(params: { pool: Pool; tenantId: string; name: string; policyJson: any }) {
  const normName = String(params.name ?? "").trim();
  if (!normName) throw new Error("invalid_policy_name");
  const digest = sha256Hex(stableStringify(params.policyJson)).slice(0, 16);
  const nextRes = await params.pool.query(
    "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM policy_versions WHERE tenant_id = $1 AND name = $2",
    [params.tenantId, normName],
  );
  const nextVersion = Number(nextRes.rows[0]?.v ?? 1);
  const res = await params.pool.query(
    `
      INSERT INTO policy_versions (tenant_id, name, version, status, policy_json, digest)
      VALUES ($1,$2,$3,'draft',$4::jsonb,$5)
      RETURNING *
    `,
    [params.tenantId, normName, nextVersion, JSON.stringify(params.policyJson ?? null), digest],
  );
  return toRow(res.rows[0]);
}

export async function getPolicyVersion(params: { pool: Pool; tenantId: string; name: string; version: number }) {
  const res = await params.pool.query(
    "SELECT * FROM policy_versions WHERE tenant_id = $1 AND name = $2 AND version = $3 LIMIT 1",
    [params.tenantId, params.name, params.version],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function listPolicyVersions(params: {
  pool: Pool;
  tenantId: string;
  name?: string;
  status?: PolicyVersionState;
  limit: number;
}) {
  const where: string[] = ["tenant_id = $1"];
  const args: any[] = [params.tenantId];
  let idx = 1;

  if (params.name) {
    args.push(params.name);
    where.push(`name = $${++idx}`);
  }
  if (params.status) {
    args.push(params.status);
    where.push(`status = $${++idx}`);
  }

  args.push(params.limit);
  const limitIdx = ++idx;

  const res = await params.pool.query(
    `
      SELECT *
      FROM policy_versions
      WHERE ${where.join(" AND ")}
      ORDER BY name ASC, version DESC
      LIMIT $${limitIdx}
    `,
    args,
  );

  return res.rows.map(toRow);
}

export async function setPolicyVersionStatus(params: {
  pool: Pool;
  tenantId: string;
  name: string;
  version: number;
  status: PolicyVersionState;
}) {
  const current = await getPolicyVersion({ pool: params.pool, tenantId: params.tenantId, name: params.name, version: params.version });
  if (!current) return null;

  const from = current.status;
  const to = params.status;
  const ok =
    (from === "draft" && to === "released") ||
    (from === "released" && to === "deprecated") ||
    (from === "deprecated" && to === "deprecated");
  if (!ok) throw new Error("invalid_policy_version_transition");

  const publishedAt = from !== "released" && to === "released" ? "now()" : "published_at";
  const res = await params.pool.query(
    `
      UPDATE policy_versions
      SET status = $4, published_at = ${publishedAt}
      WHERE tenant_id = $1 AND name = $2 AND version = $3
      RETURNING *
    `,
    [params.tenantId, params.name, params.version, to],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

