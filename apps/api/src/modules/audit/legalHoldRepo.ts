import type { Pool } from "pg";

export type AuditLegalHoldStatus = "active" | "released";

export type AuditLegalHoldRow = {
  holdId: string;
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  fromTs: string | null;
  toTs: string | null;
  subjectId: string | null;
  traceId: string | null;
  runId: string | null;
  reason: string;
  status: AuditLegalHoldStatus;
  createdBy: string;
  createdAt: string;
  releasedBy: string | null;
  releasedAt: string | null;
  updatedAt: string;
};

function toRow(r: any): AuditLegalHoldRow {
  return {
    holdId: r.hold_id,
    tenantId: r.tenant_id,
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    fromTs: r.from_ts ?? null,
    toTs: r.to_ts ?? null,
    subjectId: r.subject_id ?? null,
    traceId: r.trace_id ?? null,
    runId: r.run_id ?? null,
    reason: r.reason,
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at,
    releasedBy: r.released_by ?? null,
    releasedAt: r.released_at ?? null,
    updatedAt: r.updated_at,
  };
}

export async function createAuditLegalHold(params: {
  pool: Pool;
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  fromTs?: string | null;
  toTs?: string | null;
  subjectId?: string | null;
  traceId?: string | null;
  runId?: string | null;
  reason: string;
  createdBy: string;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO audit_legal_holds (
        tenant_id, scope_type, scope_id,
        from_ts, to_ts, subject_id, trace_id, run_id,
        reason, status, created_by
      ) VALUES (
        $1,$2,$3,
        $4,$5,$6,$7,$8,
        $9,'active',$10
      )
      RETURNING *
    `,
    [
      params.tenantId,
      params.scopeType,
      params.scopeId,
      params.fromTs ?? null,
      params.toTs ?? null,
      params.subjectId ?? null,
      params.traceId ?? null,
      params.runId ?? null,
      params.reason,
      params.createdBy,
    ],
  );
  return toRow(res.rows[0]);
}

export async function listAuditLegalHolds(params: { pool: Pool; tenantId: string; status?: AuditLegalHoldStatus; limit: number }) {
  const where: string[] = ["tenant_id = $1"];
  const args: any[] = [params.tenantId];
  let idx = 2;
  if (params.status) {
    where.push(`status = $${idx++}`);
    args.push(params.status);
  }
  args.push(params.limit);
  const res = await params.pool.query(
    `
      SELECT *
      FROM audit_legal_holds
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${idx}
    `,
    args,
  );
  return res.rows.map(toRow);
}

export async function getAuditLegalHold(params: { pool: Pool; tenantId: string; holdId: string }) {
  const res = await params.pool.query(
    `SELECT * FROM audit_legal_holds WHERE tenant_id = $1 AND hold_id = $2 LIMIT 1`,
    [params.tenantId, params.holdId],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function releaseAuditLegalHold(params: { pool: Pool; tenantId: string; holdId: string; releasedBy: string }) {
  const res = await params.pool.query(
    `
      UPDATE audit_legal_holds
      SET status = 'released',
          released_by = $3,
          released_at = now(),
          updated_at = now()
      WHERE tenant_id = $1 AND hold_id = $2 AND status = 'active'
      RETURNING *
    `,
    [params.tenantId, params.holdId, params.releasedBy],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

