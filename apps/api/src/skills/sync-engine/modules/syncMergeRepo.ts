import type { Pool } from "pg";

export type SyncMergeRunRow = {
  mergeId: string;
  tenantId: string;
  spaceId: string;
  actorSubjectId: string | null;
  inputDigest: string;
  mergeDigest: string;
  acceptedCount: number;
  rejectedCount: number;
  conflictsCount: number;
  transcriptJson: any;
  traceId: string | null;
  requestId: string | null;
  createdAt: string;
};

function toMergeRun(r: any): SyncMergeRunRow {
  return {
    mergeId: String(r.merge_id),
    tenantId: String(r.tenant_id),
    spaceId: String(r.space_id),
    actorSubjectId: r.actor_subject_id ? String(r.actor_subject_id) : null,
    inputDigest: String(r.input_digest),
    mergeDigest: String(r.merge_digest),
    acceptedCount: Number(r.accepted_count ?? 0),
    rejectedCount: Number(r.rejected_count ?? 0),
    conflictsCount: Number(r.conflicts_count ?? 0),
    transcriptJson: r.transcript_json ?? null,
    traceId: r.trace_id ? String(r.trace_id) : null,
    requestId: r.request_id ? String(r.request_id) : null,
    createdAt: String(r.created_at),
  };
}

export async function insertMergeRun(params: {
  pool: Pool;
  mergeId: string;
  tenantId: string;
  spaceId: string;
  actorSubjectId?: string | null;
  inputDigest: string;
  mergeDigest: string;
  acceptedCount: number;
  rejectedCount: number;
  conflictsCount: number;
  transcriptJson: any;
  traceId?: string | null;
  requestId?: string | null;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO sync_merge_runs (
        merge_id, tenant_id, space_id, actor_subject_id,
        input_digest, merge_digest,
        accepted_count, rejected_count, conflicts_count,
        transcript_json, trace_id, request_id
      ) VALUES (
        $1,$2,$3,$4,
        $5,$6,
        $7,$8,$9,
        $10::jsonb,$11,$12
      )
      ON CONFLICT (merge_id) DO NOTHING
      RETURNING *
    `,
    [
      params.mergeId,
      params.tenantId,
      params.spaceId,
      params.actorSubjectId ?? null,
      params.inputDigest,
      params.mergeDigest,
      params.acceptedCount,
      params.rejectedCount,
      params.conflictsCount,
      JSON.stringify(params.transcriptJson ?? {}),
      params.traceId ?? null,
      params.requestId ?? null,
    ],
  );
  if (res.rowCount) return { inserted: true, row: toMergeRun(res.rows[0]) };
  const existing = await getMergeRunById({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId, mergeId: params.mergeId });
  return { inserted: false, row: existing! };
}

export async function getMergeRunById(params: { pool: Pool; tenantId: string; spaceId: string; mergeId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM sync_merge_runs
      WHERE tenant_id = $1 AND space_id = $2 AND merge_id = $3
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, params.mergeId],
  );
  if (!res.rowCount) return null;
  return toMergeRun(res.rows[0]);
}

