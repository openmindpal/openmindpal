import crypto from "node:crypto";
import type { Pool } from "pg";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ChannelBindingStateRow = {
  id: string;
  tenantId: string;
  provider: string;
  workspaceId: string;
  spaceId: string;
  targetSubjectId: string | null;
  stateHash: string;
  label: string | null;
  status: string;
  boundChannelUserId: string | null;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
};

function toRow(r: any): ChannelBindingStateRow {
  return {
    id: String(r.id ?? ""),
    tenantId: String(r.tenant_id ?? ""),
    provider: String(r.provider ?? ""),
    workspaceId: String(r.workspace_id ?? ""),
    spaceId: String(r.space_id ?? ""),
    targetSubjectId: r.target_subject_id != null ? String(r.target_subject_id) : null,
    stateHash: String(r.state_hash ?? ""),
    label: r.label != null ? String(r.label) : null,
    status: String(r.status ?? "pending"),
    boundChannelUserId: r.bound_channel_user_id != null ? String(r.bound_channel_user_id) : null,
    createdAt: String(r.created_at ?? ""),
    expiresAt: String(r.expires_at ?? ""),
    consumedAt: r.consumed_at != null ? String(r.consumed_at) : null,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

export function newBindingStateValue() {
  return crypto.randomBytes(32).toString("base64url");
}

// ─── Create ──────────────────────────────────────────────────────────────────

export async function createBindingState(params: {
  pool: Pool;
  tenantId: string;
  provider: string;
  workspaceId: string;
  spaceId: string;
  targetSubjectId?: string | null;
  state: string;
  label?: string | null;
  ttlSeconds?: number;
}): Promise<{ row: ChannelBindingStateRow; state: string }> {
  const ttl = params.ttlSeconds ?? 600;
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  const stateHash = sha256Hex(params.state);

  const res = await params.pool.query(
    `INSERT INTO channel_binding_states
       (tenant_id, provider, workspace_id, space_id, target_subject_id, state_hash, label, status, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8::timestamptz)
     RETURNING *`,
    [
      params.tenantId,
      params.provider,
      params.workspaceId,
      params.spaceId,
      params.targetSubjectId ?? null,
      stateHash,
      params.label ?? null,
      expiresAt,
    ],
  );
  return { row: toRow(res.rows[0]), state: params.state };
}

// ─── Lookup by state ─────────────────────────────────────────────────────────

export async function getBindingStateByState(params: {
  pool: Pool;
  state: string;
}): Promise<ChannelBindingStateRow | null> {
  const stateHash = sha256Hex(params.state);
  const res = await params.pool.query(
    `SELECT * FROM channel_binding_states WHERE state_hash = $1 LIMIT 1`,
    [stateHash],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

// ─── Consume ─────────────────────────────────────────────────────────────────

export async function consumeBindingState(params: {
  pool: Pool;
  state: string;
  boundChannelUserId: string;
}): Promise<ChannelBindingStateRow | null> {
  const stateHash = sha256Hex(params.state);
  const res = await params.pool.query(
    `UPDATE channel_binding_states
     SET status = 'consumed', consumed_at = now(), bound_channel_user_id = $2
     WHERE state_hash = $1 AND status = 'pending' AND expires_at > now()
     RETURNING *`,
    [stateHash, params.boundChannelUserId],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

// ─── List ────────────────────────────────────────────────────────────────────

export async function listBindingStates(params: {
  pool: Pool;
  tenantId: string;
  provider?: string;
  workspaceId?: string;
  status?: string;
  limit?: number;
}): Promise<ChannelBindingStateRow[]> {
  const conditions = ["tenant_id = $1"];
  const values: any[] = [params.tenantId];
  let idx = 2;

  if (params.provider) {
    conditions.push(`provider = $${idx++}`);
    values.push(params.provider);
  }
  if (params.workspaceId) {
    conditions.push(`workspace_id = $${idx++}`);
    values.push(params.workspaceId);
  }
  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  const limit = params.limit ?? 50;
  conditions.push(`expires_at > now() OR status = 'consumed'`);

  const res = await params.pool.query(
    `SELECT * FROM channel_binding_states
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT ${limit}`,
    values,
  );
  return res.rows.map(toRow);
}

// ─── Expire stale (housekeeping) ─────────────────────────────────────────────

export async function expireStaleBindingStates(params: { pool: Pool }) {
  await params.pool.query(
    `UPDATE channel_binding_states SET status = 'expired' WHERE status = 'pending' AND expires_at <= now()`,
  );
}
