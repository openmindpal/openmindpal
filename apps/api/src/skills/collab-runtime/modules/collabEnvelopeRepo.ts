import type { Pool } from "pg";

export type CollabEnvelopeRow = {
  envelopeId: string;
  tenantId: string;
  spaceId: string | null;
  collabRunId: string;
  taskId: string;
  fromRole: string;
  toRole: string | null;
  broadcast: boolean;
  kind: string;
  correlationId: string | null;
  policySnapshotRef: string | null;
  payloadDigest: any;
  payloadRedacted: any | null;
  createdAt: string;
};

function toEnvelope(r: any): CollabEnvelopeRow {
  return {
    envelopeId: String(r.envelope_id),
    tenantId: String(r.tenant_id),
    spaceId: r.space_id ? String(r.space_id) : null,
    collabRunId: String(r.collab_run_id),
    taskId: String(r.task_id),
    fromRole: String(r.from_role),
    toRole: r.to_role ? String(r.to_role) : null,
    broadcast: Boolean(r.broadcast),
    kind: String(r.kind),
    correlationId: r.correlation_id ? String(r.correlation_id) : null,
    policySnapshotRef: r.policy_snapshot_ref ? String(r.policy_snapshot_ref) : null,
    payloadDigest: r.payload_digest ?? null,
    payloadRedacted: r.payload_redacted ?? null,
    createdAt: String(r.created_at),
  };
}

export async function appendCollabEnvelope(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  collabRunId: string;
  taskId: string;
  fromRole: string;
  toRole?: string | null;
  broadcast?: boolean;
  kind: string;
  correlationId?: string | null;
  policySnapshotRef?: string | null;
  payloadDigest: any;
  payloadRedacted?: any | null;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO collab_envelopes (
        tenant_id, space_id, collab_run_id, task_id,
        from_role, to_role, broadcast, kind, correlation_id, policy_snapshot_ref,
        payload_digest, payload_redacted
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `,
    [
      params.tenantId,
      params.spaceId,
      params.collabRunId,
      params.taskId,
      params.fromRole,
      params.toRole ?? null,
      params.broadcast ?? false,
      params.kind,
      params.correlationId ?? null,
      params.policySnapshotRef ?? null,
      params.payloadDigest ?? null,
      params.payloadRedacted ?? null,
    ],
  );
  return toEnvelope(res.rows[0]);
}

export async function listCollabEnvelopes(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  limit: number;
  before?: string | null;
  fromRole?: string | null;
  toRole?: string | null;
  kind?: string | null;
  correlationId?: string | null;
}) {
  const limit = Math.max(1, Math.min(200, params.limit));
  const where: string[] = ["tenant_id = $1", "collab_run_id = $2"];
  const args: any[] = [params.tenantId, params.collabRunId];
  let idx = 3;
  if (params.before) {
    where.push(`created_at < $${idx++}`);
    args.push(params.before);
  }
  if (params.fromRole) {
    where.push(`from_role = $${idx++}`);
    args.push(params.fromRole);
  }
  if (params.toRole) {
    where.push(`to_role = $${idx++}`);
    args.push(params.toRole);
  }
  if (params.kind) {
    where.push(`kind = $${idx++}`);
    args.push(params.kind);
  }
  if (params.correlationId) {
    where.push(`correlation_id = $${idx++}`);
    args.push(params.correlationId);
  }
  args.push(limit);
  const res = await params.pool.query(
    `
      SELECT *
      FROM collab_envelopes
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${idx++}
    `,
    args,
  );
  return res.rows.map(toEnvelope);
}
