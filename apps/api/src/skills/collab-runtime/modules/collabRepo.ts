import type { Pool } from "pg";

export type CollabRunRow = {
  collabRunId: string;
  tenantId: string;
  spaceId: string | null;
  taskId: string;
  createdBySubjectId: string;
  status: string;
  roles: any | null;
  limits: any | null;
  primaryRunId: string | null;
  createdAt: string;
  updatedAt: string;
};

function toCollabRun(r: any): CollabRunRow {
  return {
    collabRunId: String(r.collab_run_id),
    tenantId: String(r.tenant_id),
    spaceId: r.space_id ? String(r.space_id) : null,
    taskId: String(r.task_id),
    createdBySubjectId: String(r.created_by_subject_id),
    status: String(r.status),
    roles: r.roles_json ?? null,
    limits: r.limits_json ?? null,
    primaryRunId: r.primary_run_id ? String(r.primary_run_id) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function createCollabRun(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  taskId: string;
  createdBySubjectId: string;
  status: string;
  roles?: any | null;
  limits?: any | null;
}) {
  const rolesJson = params.roles === undefined || params.roles === null ? null : JSON.stringify(params.roles);
  const limitsJson = params.limits === undefined || params.limits === null ? null : JSON.stringify(params.limits);
  const res = await params.pool.query(
    `
      INSERT INTO collab_runs (tenant_id, space_id, task_id, created_by_subject_id, status, roles_json, limits_json)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
      RETURNING *
    `,
    [params.tenantId, params.spaceId, params.taskId, params.createdBySubjectId, params.status, rolesJson, limitsJson],
  );
  return toCollabRun(res.rows[0]);
}

export async function getCollabRun(params: { pool: Pool; tenantId: string; collabRunId: string }) {
  const res = await params.pool.query("SELECT * FROM collab_runs WHERE tenant_id = $1 AND collab_run_id = $2 LIMIT 1", [params.tenantId, params.collabRunId]);
  if (!res.rowCount) return null;
  return toCollabRun(res.rows[0]);
}

export async function listCollabRunsByTask(params: {
  pool: Pool;
  tenantId: string;
  taskId: string;
  status?: string | null;
  before?: string | null;
  limit: number;
}) {
  const limit = Math.max(1, Math.min(200, params.limit));
  const res = await params.pool.query(
    `
      SELECT *
      FROM collab_runs
      WHERE tenant_id = $1 AND task_id = $2
        AND ($3::TEXT IS NULL OR status = $3)
        AND ($4::TIMESTAMPTZ IS NULL OR created_at < $4::TIMESTAMPTZ)
      ORDER BY created_at DESC
      LIMIT $5
    `,
    [params.tenantId, params.taskId, params.status ?? null, params.before ?? null, limit],
  );
  return res.rows.map(toCollabRun);
}

export async function updateCollabRunStatus(params: { pool: Pool; tenantId: string; collabRunId: string; status: string }) {
  const res = await params.pool.query(
    "UPDATE collab_runs SET status = $3, updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2 RETURNING *",
    [params.tenantId, params.collabRunId, params.status],
  );
  if (!res.rowCount) return null;
  return toCollabRun(res.rows[0]);
}

export async function setCollabRunPrimaryRun(params: { pool: Pool; tenantId: string; collabRunId: string; primaryRunId: string | null }) {
  const res = await params.pool.query(
    "UPDATE collab_runs SET primary_run_id = $3, updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2 RETURNING *",
    [params.tenantId, params.collabRunId, params.primaryRunId],
  );
  if (!res.rowCount) return null;
  return toCollabRun(res.rows[0]);
}
