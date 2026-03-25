import type { Pool } from "pg";

export type DeviceExecutionRow = {
  deviceExecutionId: string;
  tenantId: string;
  spaceId: string | null;
  createdBySubjectId: string | null;
  deviceId: string;
  toolRef: string;
  policySnapshotRef: string | null;
  idempotencyKey: string | null;
  requireUserPresence: boolean;
  inputJson: any;
  inputDigest: any;
  status: string;
  outputDigest: any;
  evidenceRefs: string[] | null;
  errorCategory: string | null;
  runId: string | null;
  stepId: string | null;
  claimedAt: string | null;
  completedAt: string | null;
  canceledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function toRow(r: any): DeviceExecutionRow {
  return {
    deviceExecutionId: r.device_execution_id,
    tenantId: r.tenant_id,
    spaceId: r.space_id ?? null,
    createdBySubjectId: r.created_by_subject_id ?? null,
    deviceId: r.device_id,
    toolRef: r.tool_ref,
    policySnapshotRef: r.policy_snapshot_ref ?? null,
    idempotencyKey: r.idempotency_key ?? null,
    requireUserPresence: Boolean(r.require_user_presence),
    inputJson: r.input_json ?? null,
    inputDigest: r.input_digest ?? null,
    status: r.status,
    outputDigest: r.output_digest ?? null,
    evidenceRefs: Array.isArray(r.evidence_refs) ? (r.evidence_refs as string[]) : null,
    errorCategory: r.error_category ?? null,
    runId: r.run_id ?? null,
    stepId: r.step_id ?? null,
    claimedAt: r.claimed_at ?? null,
    completedAt: r.completed_at ?? null,
    canceledAt: r.canceled_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function createDeviceExecution(params: {
  pool: Pool;
  tenantId: string;
  spaceId?: string | null;
  createdBySubjectId?: string | null;
  deviceId: string;
  toolRef: string;
  policySnapshotRef?: string | null;
  idempotencyKey?: string | null;
  requireUserPresence?: boolean;
  inputJson?: any;
  inputDigest?: any;
  runId?: string | null;
  stepId?: string | null;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO device_executions (
        tenant_id, space_id, created_by_subject_id, device_id,
        tool_ref, policy_snapshot_ref, idempotency_key, require_user_presence,
        input_json, input_digest, status, run_id, step_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,'pending',$11,$12)
      RETURNING *
    `,
    [
      params.tenantId,
      params.spaceId ?? null,
      params.createdBySubjectId ?? null,
      params.deviceId,
      params.toolRef,
      params.policySnapshotRef ?? null,
      params.idempotencyKey ?? null,
      params.requireUserPresence ?? false,
      params.inputJson ? JSON.stringify(params.inputJson) : null,
      params.inputDigest ? JSON.stringify(params.inputDigest) : null,
      params.runId ?? null,
      params.stepId ?? null,
    ],
  );
  return toRow(res.rows[0]);
}

export async function getDeviceExecution(params: { pool: Pool; tenantId: string; deviceExecutionId: string }) {
  const res = await params.pool.query("SELECT * FROM device_executions WHERE tenant_id = $1 AND device_execution_id = $2 LIMIT 1", [params.tenantId, params.deviceExecutionId]);
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function listDeviceExecutions(params: { pool: Pool; tenantId: string; spaceId: string | null | undefined; deviceId?: string; status?: string; limit: number; offset: number }) {
  const where: string[] = ["tenant_id = $1"];
  const args: any[] = [params.tenantId];
  let idx = 2;

  if (params.spaceId !== undefined) {
    if (params.spaceId === null) where.push("space_id IS NULL");
    else {
      where.push(`space_id = $${idx++}`);
      args.push(params.spaceId);
    }
  }
  if (params.deviceId) {
    where.push(`device_id = $${idx++}`);
    args.push(params.deviceId);
  }
  if (params.status) {
    where.push(`status = $${idx++}`);
    args.push(params.status);
  }
  args.push(params.limit, params.offset);
  const res = await params.pool.query(
    `
      SELECT *
      FROM device_executions
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `,
    args,
  );
  return res.rows.map(toRow);
}

export async function listPendingByDevice(params: { pool: Pool; tenantId: string; deviceId: string; limit: number }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM device_executions
      WHERE tenant_id = $1 AND device_id = $2 AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT $3
    `,
    [params.tenantId, params.deviceId, params.limit],
  );
  return res.rows.map(toRow);
}

export async function cancelDeviceExecution(params: { pool: Pool; tenantId: string; deviceExecutionId: string }) {
  const res = await params.pool.query(
    `
      UPDATE device_executions
      SET status = 'canceled', canceled_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND device_execution_id = $2 AND status IN ('pending','claimed')
      RETURNING *
    `,
    [params.tenantId, params.deviceExecutionId],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function claimDeviceExecution(params: { pool: Pool; tenantId: string; deviceExecutionId: string; deviceId: string }) {
  const res = await params.pool.query(
    `
      UPDATE device_executions
      SET status = 'claimed', claimed_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND device_execution_id = $2 AND device_id = $3 AND status = 'pending'
      RETURNING *
    `,
    [params.tenantId, params.deviceExecutionId, params.deviceId],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function getDeviceExecutionByRunStep(params: { pool: Pool; tenantId: string; runId: string; stepId: string }) {
  const res = await params.pool.query(
    "SELECT * FROM device_executions WHERE tenant_id = $1 AND run_id = $2 AND step_id = $3 ORDER BY created_at DESC LIMIT 1",
    [params.tenantId, params.runId, params.stepId],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function findActiveDeviceForTool(params: { pool: Pool; tenantId: string; spaceId: string; toolName: string }) {
  const res = await params.pool.query(
    `
      SELECT d.device_id, d.tenant_id, d.space_id
      FROM device_records d
      JOIN device_policies p ON p.tenant_id = d.tenant_id AND p.device_id = d.device_id
      WHERE d.tenant_id = $1
        AND d.space_id = $2
        AND d.status = 'active'
        AND d.last_seen_at > now() - interval '5 minutes'
        AND p.allowed_tools::jsonb @> $3::jsonb
      ORDER BY d.last_seen_at DESC
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, JSON.stringify([params.toolName])],
  );
  if (!res.rowCount) return null;
  return { deviceId: String(res.rows[0].device_id), tenantId: String(res.rows[0].tenant_id), spaceId: res.rows[0].space_id ? String(res.rows[0].space_id) : null };
}

export async function listCompletedDeviceExecutionsForResume(params: { pool: Pool; limit: number }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM device_executions
      WHERE run_id IS NOT NULL
        AND step_id IS NOT NULL
        AND status IN ('succeeded', 'failed')
        AND completed_at IS NOT NULL
        AND completed_at > now() - interval '1 hour'
      ORDER BY completed_at ASC
      LIMIT $1
    `,
    [params.limit],
  );
  return res.rows.map(toRow);
}

export async function completeDeviceExecution(params: {
  pool: Pool;
  tenantId: string;
  deviceExecutionId: string;
  deviceId: string;
  status: "succeeded" | "failed";
  outputDigest?: any;
  errorCategory?: string | null;
  evidenceRefs?: string[] | null;
}) {
  const res = await params.pool.query(
    `
      UPDATE device_executions
      SET status = $4,
          output_digest = $5::jsonb,
          error_category = $6,
          evidence_refs = $7::jsonb,
          completed_at = now(),
          updated_at = now()
      WHERE tenant_id = $1 AND device_execution_id = $2 AND device_id = $3 AND status = 'claimed'
      RETURNING *
    `,
    [
      params.tenantId,
      params.deviceExecutionId,
      params.deviceId,
      params.status,
      params.outputDigest ? JSON.stringify(params.outputDigest) : null,
      params.errorCategory ?? null,
      params.evidenceRefs ? JSON.stringify(params.evidenceRefs) : null,
    ],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}
