import type { Pool } from "pg";

export type SyncConflictTicketStatus = "open" | "resolved" | "abandoned";

export type SyncConflictTicketRow = {
  ticketId: string;
  tenantId: string;
  spaceId: string;
  mergeId: string;
  status: SyncConflictTicketStatus;
  conflictsJson: any;
  resolvedMergeId: string | null;
  abandonedReason: string | null;
  traceId: string | null;
  requestId: string | null;
  createdAt: string;
  updatedAt: string;
};

function toTicket(r: any): SyncConflictTicketRow {
  return {
    ticketId: String(r.ticket_id),
    tenantId: String(r.tenant_id),
    spaceId: String(r.space_id),
    mergeId: String(r.merge_id),
    status: String(r.status) as SyncConflictTicketStatus,
    conflictsJson: r.conflicts_json ?? null,
    resolvedMergeId: r.resolved_merge_id ? String(r.resolved_merge_id) : null,
    abandonedReason: r.abandoned_reason ? String(r.abandoned_reason) : null,
    traceId: r.trace_id ? String(r.trace_id) : null,
    requestId: r.request_id ? String(r.request_id) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function createConflictTicket(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  mergeId: string;
  status?: SyncConflictTicketStatus;
  conflictsJson: any;
  traceId?: string | null;
  requestId?: string | null;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO sync_conflict_tickets (
        tenant_id, space_id, merge_id, status, conflicts_json, trace_id, request_id
      ) VALUES (
        $1,$2,$3,$4,$5::jsonb,$6,$7
      )
      RETURNING *
    `,
    [
      params.tenantId,
      params.spaceId,
      params.mergeId,
      params.status ?? "open",
      JSON.stringify(params.conflictsJson ?? []),
      params.traceId ?? null,
      params.requestId ?? null,
    ],
  );
  return toTicket(res.rows[0]);
}

export async function listConflictTickets(params: { pool: Pool; tenantId: string; spaceId: string; status?: SyncConflictTicketStatus; limit: number; cursor?: { updatedAt: string; ticketId: string } | null }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM sync_conflict_tickets
      WHERE tenant_id = $1 AND space_id = $2
        AND ($3::text IS NULL OR status = $3)
        AND ($4::timestamptz IS NULL OR (updated_at, ticket_id) < ($4::timestamptz, $5::uuid))
      ORDER BY updated_at DESC, ticket_id DESC
      LIMIT $6
    `,
    [params.tenantId, params.spaceId, params.status ?? null, params.cursor?.updatedAt ?? null, params.cursor?.ticketId ?? null, params.limit],
  );
  return res.rows.map(toTicket);
}

export async function getConflictTicketById(params: { pool: Pool; tenantId: string; spaceId: string; ticketId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM sync_conflict_tickets
      WHERE tenant_id = $1 AND space_id = $2 AND ticket_id = $3::uuid
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, params.ticketId],
  );
  if (!res.rowCount) return null;
  return toTicket(res.rows[0]);
}

export async function resolveConflictTicket(params: { pool: Pool; tenantId: string; spaceId: string; ticketId: string; resolvedMergeId: string }) {
  const res = await params.pool.query(
    `
      UPDATE sync_conflict_tickets
      SET status = 'resolved', resolved_merge_id = $4, updated_at = now()
      WHERE tenant_id = $1 AND space_id = $2 AND ticket_id = $3::uuid
      RETURNING *
    `,
    [params.tenantId, params.spaceId, params.ticketId, params.resolvedMergeId],
  );
  if (!res.rowCount) return null;
  return toTicket(res.rows[0]);
}

export async function abandonConflictTicket(params: { pool: Pool; tenantId: string; spaceId: string; ticketId: string; reason?: string | null }) {
  const res = await params.pool.query(
    `
      UPDATE sync_conflict_tickets
      SET status = 'abandoned', abandoned_reason = $4, updated_at = now()
      WHERE tenant_id = $1 AND space_id = $2 AND ticket_id = $3::uuid
      RETURNING *
    `,
    [params.tenantId, params.spaceId, params.ticketId, params.reason ?? null],
  );
  if (!res.rowCount) return null;
  return toTicket(res.rows[0]);
}

