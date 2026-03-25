import type { Pool } from "pg";

export type TaskRow = {
  taskId: string;
  tenantId: string;
  spaceId: string | null;
  createdBySubjectId: string;
  title: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

function toTask(r: any): TaskRow {
  return {
    taskId: r.task_id,
    tenantId: r.tenant_id,
    spaceId: r.space_id ?? null,
    createdBySubjectId: r.created_by_subject_id,
    title: r.title ?? null,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function createTask(params: { pool: Pool; tenantId: string; spaceId?: string | null; createdBySubjectId: string; title?: string | null }) {
  const res = await params.pool.query(
    `
      INSERT INTO tasks (tenant_id, space_id, created_by_subject_id, title, status)
      VALUES ($1,$2,$3,$4,'open')
      RETURNING *
    `,
    [params.tenantId, params.spaceId ?? null, params.createdBySubjectId, params.title ?? null],
  );
  return toTask(res.rows[0]);
}

export async function listTasks(params: { pool: Pool; tenantId: string; spaceId: string | null; limit: number; offset: number }) {
  const where: string[] = ["tenant_id = $1"];
  const args: any[] = [params.tenantId];
  let idx = 2;
  if (params.spaceId) {
    where.push(`space_id = $${idx++}`);
    args.push(params.spaceId);
  } else {
    where.push("space_id IS NULL");
  }
  args.push(params.limit);
  args.push(params.offset);
  const res = await params.pool.query(
    `
      SELECT *
      FROM tasks
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `,
    args,
  );
  return res.rows.map(toTask);
}

export async function getTask(params: { pool: Pool; tenantId: string; taskId: string }) {
  const res = await params.pool.query("SELECT * FROM tasks WHERE tenant_id = $1 AND task_id = $2 LIMIT 1", [params.tenantId, params.taskId]);
  if (!res.rowCount) return null;
  return toTask(res.rows[0]);
}

export async function listRunsByTask(params: { pool: Pool; tenantId: string; taskId: string; limit: number }) {
  const res = await params.pool.query(
    `
      SELECT
        r.run_id,
        r.status,
        r.tool_ref,
        r.policy_snapshot_ref,
        r.idempotency_key,
        r.started_at,
        r.finished_at,
        r.created_at,
        r.updated_at,
        j.job_type
      FROM runs r
      LEFT JOIN jobs j ON j.tenant_id = r.tenant_id AND j.run_id = r.run_id
      WHERE r.tenant_id = $1 AND (r.input_digest->>'taskId') = $2
      ORDER BY r.created_at DESC
      LIMIT $3
    `,
    [params.tenantId, params.taskId, params.limit],
  );
  return res.rows.map((r: any) => ({
    runId: r.run_id,
    status: r.status,
    toolRef: r.tool_ref,
    policySnapshotRef: r.policy_snapshot_ref,
    idempotencyKey: r.idempotency_key,
    jobType: r.job_type ?? null,
    startedAt: r.started_at ?? null,
    finishedAt: r.finished_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function listLongTasks(params: { pool: Pool; tenantId: string; spaceId: string | null; limit: number; offset: number }) {
  const where: string[] = ["t.tenant_id = $1"];
  const args: any[] = [params.tenantId];
  let idx = 2;
  if (params.spaceId) {
    where.push(`t.space_id = $${idx++}`);
    args.push(params.spaceId);
  } else {
    where.push("t.space_id IS NULL");
  }
  args.push(params.limit);
  args.push(params.offset);
  const res = await params.pool.query(
    `
      WITH latest_run AS (
        SELECT DISTINCT ON (r.input_digest->>'taskId')
          r.*,
          j.job_type
        FROM runs r
        LEFT JOIN jobs j ON j.tenant_id = r.tenant_id AND j.run_id = r.run_id
        WHERE r.tenant_id = $1 AND (r.input_digest->>'taskId') IS NOT NULL
        ORDER BY (r.input_digest->>'taskId') ASC, r.created_at DESC
      )
      SELECT
        t.*,
        lr.run_id AS latest_run_id,
        lr.status AS latest_run_status,
        lr.tool_ref AS latest_tool_ref,
        lr.job_type AS latest_job_type,
        lr.started_at AS latest_started_at,
        lr.finished_at AS latest_finished_at,
        lr.updated_at AS latest_run_updated_at,
        mts.phase AS latest_phase
      FROM tasks t
      LEFT JOIN latest_run lr ON (lr.input_digest->>'taskId') = (t.task_id::text)
      LEFT JOIN memory_task_states mts ON mts.tenant_id = t.tenant_id AND t.space_id IS NOT NULL AND mts.space_id = t.space_id AND mts.run_id = lr.run_id AND mts.deleted_at IS NULL
      WHERE ${where.join(" AND ")}
      ORDER BY t.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `,
    args,
  );
  return res.rows.map((r: any) => ({
    task: toTask(r),
    latest: r.latest_run_id
      ? {
          runId: r.latest_run_id,
          status: r.latest_run_status,
          toolRef: r.latest_tool_ref,
          jobType: r.latest_job_type ?? null,
          traceId: null,
          startedAt: r.latest_started_at ?? null,
          finishedAt: r.latest_finished_at ?? null,
          updatedAt: r.latest_run_updated_at ?? null,
          phase: r.latest_phase ?? null,
        }
      : null,
  }));
}
