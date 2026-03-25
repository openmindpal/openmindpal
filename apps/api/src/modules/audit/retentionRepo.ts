import type { Pool } from "pg";

export type AuditRetentionPolicyRow = {
  tenantId: string;
  retentionDays: number;
  updatedAt: string;
};

function toRow(r: any): AuditRetentionPolicyRow {
  return {
    tenantId: r.tenant_id,
    retentionDays: Number(r.retention_days),
    updatedAt: r.updated_at,
  };
}

export async function getAuditRetentionPolicy(params: { pool: Pool; tenantId: string }) {
  const res = await params.pool.query(
    `SELECT tenant_id, retention_days, updated_at FROM audit_retention_policies WHERE tenant_id = $1 LIMIT 1`,
    [params.tenantId],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function upsertAuditRetentionPolicy(params: { pool: Pool; tenantId: string; retentionDays: number }) {
  const res = await params.pool.query(
    `
      INSERT INTO audit_retention_policies (tenant_id, retention_days)
      VALUES ($1,$2)
      ON CONFLICT (tenant_id)
      DO UPDATE SET retention_days = EXCLUDED.retention_days, updated_at = now()
      RETURNING tenant_id, retention_days, updated_at
    `,
    [params.tenantId, params.retentionDays],
  );
  return toRow(res.rows[0]);
}

