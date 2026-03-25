import type { Pool } from "pg";

export async function getTenantStepPayloadRetentionDays(params: { pool: Pool; tenantId: string }) {
  const res = await params.pool.query("SELECT workflow_step_payload_retention_days FROM tenants WHERE id = $1 LIMIT 1", [params.tenantId]);
  if (!res.rowCount) return null;
  const v = res.rows[0].workflow_step_payload_retention_days as number | null;
  return v === null ? null : Number(v);
}

export async function setTenantStepPayloadRetentionDays(params: { pool: Pool; tenantId: string; retentionDays: number | null }) {
  const res = await params.pool.query(
    "UPDATE tenants SET workflow_step_payload_retention_days = $2, updated_at = now() WHERE id = $1 RETURNING workflow_step_payload_retention_days",
    [params.tenantId, params.retentionDays],
  );
  if (!res.rowCount) return null;
  const v = res.rows[0].workflow_step_payload_retention_days as number | null;
  return v === null ? null : Number(v);
}

