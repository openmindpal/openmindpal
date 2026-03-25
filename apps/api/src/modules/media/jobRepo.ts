import type { Pool } from "pg";

export type MediaJobRow = {
  jobId: string;
  tenantId: string;
  spaceId: string;
  mediaId: string;
  ops: any;
  status: string;
  errorDigest: any;
  createdBySubjectId: string | null;
  createdAt: string;
  updatedAt: string;
};

function toRow(r: any): MediaJobRow {
  return {
    jobId: r.job_id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    mediaId: r.media_id,
    ops: r.ops ?? [],
    status: r.status,
    errorDigest: r.error_digest ?? null,
    createdBySubjectId: r.created_by_subject_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function createMediaJob(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  mediaId: string;
  ops: any;
  createdBySubjectId?: string | null;
}) {
  const opsJson = JSON.stringify(params.ops ?? []);
  const res = await params.pool.query(
    `
      INSERT INTO media_jobs (tenant_id, space_id, media_id, ops, status, created_by_subject_id)
      VALUES ($1,$2,$3,$4::jsonb,'pending',$5)
      RETURNING *
    `,
    [params.tenantId, params.spaceId, params.mediaId, opsJson, params.createdBySubjectId ?? null],
  );
  return toRow(res.rows[0]);
}

export async function getMediaJob(params: { pool: Pool; tenantId: string; jobId: string }) {
  const res = await params.pool.query("SELECT * FROM media_jobs WHERE tenant_id = $1 AND job_id = $2 LIMIT 1", [params.tenantId, params.jobId]);
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}
