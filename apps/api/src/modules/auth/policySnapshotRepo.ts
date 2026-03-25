import type { Pool } from "pg";

export type PolicySnapshotRow = {
  snapshotId: string;
  tenantId: string;
  subjectId: string;
  spaceId: string | null;
  resourceType: string;
  action: string;
  decision: string;
  reason: string | null;
  matchedRules: any;
  rowFilters: any;
  fieldRules: any;
  createdAt: string;
  policyRef: { name: string; version: number };
  policyCacheEpoch: any;
  explainV1: any;
};

function toRow(r: any): PolicySnapshotRow {
  return {
    snapshotId: r.snapshot_id,
    tenantId: r.tenant_id,
    subjectId: r.subject_id,
    spaceId: r.space_id ?? null,
    resourceType: r.resource_type,
    action: r.action,
    decision: r.decision,
    reason: r.reason ?? null,
    matchedRules: r.matched_rules ?? null,
    rowFilters: r.row_filters ?? null,
    fieldRules: r.field_rules ?? null,
    createdAt: r.created_at,
    policyRef: { name: r.policy_name ?? "default", version: Number(r.policy_version ?? 1) },
    policyCacheEpoch: r.policy_cache_epoch ?? null,
    explainV1: r.explain_v1 ?? null,
  };
}

export async function createPolicySnapshot(params: {
  pool: Pool;
  tenantId: string;
  subjectId: string;
  spaceId?: string | null;
  resourceType: string;
  action: string;
  decision: string;
  reason?: string | null;
  matchedRules?: any;
  rowFilters?: any;
  fieldRules?: any;
  policyRef?: { name: string; version: number };
  policyCacheEpoch?: any;
  explainV1?: any;
}) {
  const policyRef = params.policyRef ?? { name: "default", version: 1 };
  const res = await params.pool.query(
    `
      INSERT INTO policy_snapshots (
        tenant_id, subject_id, space_id, resource_type, action,
        decision, reason, matched_rules, row_filters, field_rules,
        policy_name, policy_version, policy_cache_epoch, explain_v1
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *
    `,
    [
      params.tenantId,
      params.subjectId,
      params.spaceId ?? null,
      params.resourceType,
      params.action,
      params.decision,
      params.reason ?? null,
      params.matchedRules ?? null,
      params.rowFilters ?? null,
      params.fieldRules ?? null,
      policyRef.name,
      policyRef.version,
      params.policyCacheEpoch ?? null,
      params.explainV1 ?? null,
    ],
  );
  return toRow(res.rows[0]);
}

export async function getPolicySnapshot(params: { pool: Pool; tenantId: string; snapshotId: string }) {
  const res = await params.pool.query("SELECT * FROM policy_snapshots WHERE tenant_id = $1 AND snapshot_id = $2 LIMIT 1", [
    params.tenantId,
    params.snapshotId,
  ]);
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function listPolicySnapshots(params: {
  pool: Pool;
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId?: string;
  subjectId?: string;
  resourceType?: string;
  action?: string;
  decision?: "allow" | "deny";
  limit: number;
  cursor?: { createdAt: string; snapshotId: string };
}) {
  const args: any[] = [params.tenantId];
  let idx = 1;
  const where: string[] = ["tenant_id = $1"];

  if (params.scopeType === "space") {
    if (!params.scopeId) throw new Error("missing_scope_id");
    args.push(params.scopeId);
    where.push(`space_id = $${++idx}`);
  }

  if (params.subjectId) {
    args.push(params.subjectId);
    where.push(`subject_id = $${++idx}`);
  }
  if (params.resourceType) {
    args.push(params.resourceType);
    where.push(`resource_type = $${++idx}`);
  }
  if (params.action) {
    args.push(params.action);
    where.push(`action = $${++idx}`);
  }
  if (params.decision) {
    args.push(params.decision);
    where.push(`decision = $${++idx}`);
  }

  if (params.cursor) {
    args.push(params.cursor.createdAt);
    const createdAtIdx = ++idx;
    args.push(params.cursor.snapshotId);
    const snapshotIdIdx = ++idx;
    where.push(`(created_at < $${createdAtIdx}::timestamptz OR (created_at = $${createdAtIdx}::timestamptz AND snapshot_id < $${snapshotIdIdx}::uuid))`);
  }

  args.push(params.limit);
  const limitIdx = ++idx;

  const res = await params.pool.query(
    `
      SELECT snapshot_id, tenant_id, subject_id, space_id, resource_type, action, decision, reason, matched_rules, row_filters, field_rules, created_at, policy_name, policy_version, policy_cache_epoch, explain_v1
      FROM policy_snapshots
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, snapshot_id DESC
      LIMIT $${limitIdx}
    `,
    args,
  );
  const items = res.rows.map(toRow);
  const nextCursor = items.length === params.limit ? { createdAt: items[items.length - 1].createdAt, snapshotId: items[items.length - 1].snapshotId } : undefined;
  return { items, nextCursor };
}
