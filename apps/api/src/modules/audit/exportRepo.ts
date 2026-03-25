import type { Pool } from "pg";

export type AuditExportStatus = "pending" | "running" | "succeeded" | "failed";

export type AuditExportRow = {
  exportId: string;
  tenantId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  status: AuditExportStatus;
  filters: any;
  artifactId: string | null;
  artifactRef: string | null;
  errorDigest: any;
};

function toRow(r: any): AuditExportRow {
  return {
    exportId: r.export_id,
    tenantId: r.tenant_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    status: r.status,
    filters: r.filters,
    artifactId: r.artifact_id ?? null,
    artifactRef: r.artifact_ref ?? null,
    errorDigest: r.error_digest ?? null,
  };
}

export async function createAuditExport(params: { pool: Pool; tenantId: string; createdBy: string; filters: any }) {
  const res = await params.pool.query(
    `
      INSERT INTO audit_exports (tenant_id, created_by, filters, status)
      VALUES ($1,$2,$3,'pending')
      RETURNING *
    `,
    [params.tenantId, params.createdBy, params.filters ?? {}],
  );
  return toRow(res.rows[0]);
}

export async function listAuditExports(params: { pool: Pool; tenantId: string; limit: number }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM audit_exports
      WHERE tenant_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [params.tenantId, params.limit],
  );
  return res.rows.map(toRow);
}

export async function getAuditExport(params: { pool: Pool; tenantId: string; exportId: string }) {
  const res = await params.pool.query(
    `SELECT * FROM audit_exports WHERE tenant_id = $1 AND export_id = $2 LIMIT 1`,
    [params.tenantId, params.exportId],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

