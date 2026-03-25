import type { Pool } from "pg";

export type WriteLeaseOwner = { runId: string; stepId: string; traceId: string };

export async function acquireWriteLease(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  resourceRef: string;
  owner: WriteLeaseOwner;
  ttlMs: number;
}): Promise<
  | { acquired: true; expiresAt: string }
  | { acquired: false; currentOwner: WriteLeaseOwner; expiresAt: string }
> {
  const expiresAt = new Date(Date.now() + Math.max(1, params.ttlMs)).toISOString();
  const res = await params.pool.query(
    `
      INSERT INTO workflow_write_leases (tenant_id, space_id, resource_ref, owner_run_id, owner_step_id, owner_trace_id, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
      ON CONFLICT (tenant_id, space_id, resource_ref) DO UPDATE
        SET owner_run_id = EXCLUDED.owner_run_id,
            owner_step_id = EXCLUDED.owner_step_id,
            owner_trace_id = EXCLUDED.owner_trace_id,
            expires_at = EXCLUDED.expires_at,
            updated_at = now()
      WHERE workflow_write_leases.expires_at <= now()
      RETURNING expires_at
    `,
    [params.tenantId, params.spaceId, params.resourceRef, params.owner.runId, params.owner.stepId, params.owner.traceId, expiresAt],
  );
  if (res.rowCount) return { acquired: true, expiresAt: String(res.rows[0].expires_at ?? expiresAt) };

  const cur = await params.pool.query(
    `
      SELECT owner_run_id, owner_step_id, owner_trace_id, expires_at
      FROM workflow_write_leases
      WHERE tenant_id = $1 AND space_id = $2 AND resource_ref = $3
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, params.resourceRef],
  );
  const row = cur.rowCount ? cur.rows[0] : null;
  const currentOwner = {
    runId: String(row?.owner_run_id ?? ""),
    stepId: String(row?.owner_step_id ?? ""),
    traceId: String(row?.owner_trace_id ?? ""),
  };
  const curExpiresAt = String(row?.expires_at ?? "");
  return { acquired: false, currentOwner, expiresAt: curExpiresAt };
}

export async function renewWriteLease(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  resourceRef: string;
  owner: WriteLeaseOwner;
  ttlMs: number;
}): Promise<boolean> {
  const expiresAt = new Date(Date.now() + Math.max(1, params.ttlMs)).toISOString();
  const res = await params.pool.query(
    `
      UPDATE workflow_write_leases
      SET expires_at = $7::timestamptz, updated_at = now()
      WHERE tenant_id = $1 AND space_id = $2 AND resource_ref = $3
        AND owner_run_id = $4 AND owner_step_id = $5 AND owner_trace_id = $6
      RETURNING 1
    `,
    [params.tenantId, params.spaceId, params.resourceRef, params.owner.runId, params.owner.stepId, params.owner.traceId, expiresAt],
  );
  return Boolean(res.rowCount);
}

export async function releaseWriteLease(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  resourceRef: string;
  owner: WriteLeaseOwner;
}): Promise<boolean> {
  const res = await params.pool.query(
    `
      DELETE FROM workflow_write_leases
      WHERE tenant_id = $1 AND space_id = $2 AND resource_ref = $3
        AND owner_run_id = $4 AND owner_step_id = $5 AND owner_trace_id = $6
    `,
    [params.tenantId, params.spaceId, params.resourceRef, params.owner.runId, params.owner.stepId, params.owner.traceId],
  );
  return Boolean(res.rowCount);
}

