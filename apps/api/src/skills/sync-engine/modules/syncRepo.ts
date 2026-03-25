import type { Pool } from "pg";

export type SyncOpRow = {
  cursor: number;
  tenantId: string;
  spaceId: string;
  opId: string;
  clientId: string | null;
  deviceId: string | null;
  schemaName: string;
  entityName: string;
  recordId: string;
  baseRevision: number | null;
  patch: any;
  contentDigest: string;
  status: "accepted" | "rejected";
  conflictJson: any;
  createdAt: string;
};

function toOp(r: any): SyncOpRow {
  return {
    cursor: Number(r.cursor),
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    opId: r.op_id,
    clientId: r.client_id,
    deviceId: r.device_id,
    schemaName: r.schema_name,
    entityName: r.entity_name,
    recordId: r.record_id,
    baseRevision: r.base_revision,
    patch: r.patch ?? {},
    contentDigest: r.content_digest,
    status: r.status,
    conflictJson: r.conflict_json,
    createdAt: r.created_at,
  };
}

export async function listOpsAfterCursor(params: { pool: Pool; tenantId: string; spaceId: string; cursor: number; limit: number }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM sync_ops
      WHERE tenant_id = $1 AND space_id = $2 AND cursor > $3 AND status = 'accepted'
      ORDER BY cursor ASC
      LIMIT $4
    `,
    [params.tenantId, params.spaceId, params.cursor, params.limit],
  );
  return res.rows.map(toOp);
}

export async function getOpByOpId(params: { pool: Pool; tenantId: string; spaceId: string; opId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM sync_ops
      WHERE tenant_id = $1 AND space_id = $2 AND op_id = $3
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, params.opId],
  );
  if (!res.rowCount) return null;
  return toOp(res.rows[0]);
}

export async function insertSyncOp(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  opId: string;
  clientId?: string | null;
  deviceId?: string | null;
  schemaName: string;
  entityName: string;
  recordId: string;
  baseRevision?: number | null;
  patch: any;
  contentDigest: string;
  status: "accepted" | "rejected";
  conflictJson?: any;
}) {
  const patch = JSON.stringify(params.patch ?? {});
  const conflictJson = params.conflictJson === undefined ? null : JSON.stringify(params.conflictJson);
  const res = await params.pool.query(
    `
      INSERT INTO sync_ops
        (tenant_id, space_id, op_id, client_id, device_id, schema_name, entity_name, record_id, base_revision, patch, content_digest, status, conflict_json)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb)
      ON CONFLICT (tenant_id, space_id, op_id) DO NOTHING
      RETURNING *
    `,
    [
      params.tenantId,
      params.spaceId,
      params.opId,
      params.clientId ?? null,
      params.deviceId ?? null,
      params.schemaName,
      params.entityName,
      params.recordId,
      params.baseRevision ?? null,
      patch,
      params.contentDigest,
      params.status,
      conflictJson,
    ],
  );
  if (res.rowCount) return { inserted: true, row: toOp(res.rows[0]) };
  const existing = await getOpByOpId({ pool: params.pool, tenantId: params.tenantId, spaceId: params.spaceId, opId: params.opId });
  return { inserted: false, row: existing! };
}

export async function upsertWatermark(params: { pool: Pool; tenantId: string; spaceId: string; clientId: string; deviceId?: string | null; lastPushedCursor: number }) {
  await params.pool.query(
    `
      INSERT INTO sync_watermarks (tenant_id, space_id, client_id, device_id, last_pushed_cursor)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (tenant_id, space_id, client_id, device_id)
      DO UPDATE SET last_pushed_cursor = GREATEST(sync_watermarks.last_pushed_cursor, EXCLUDED.last_pushed_cursor), updated_at = now()
    `,
    [params.tenantId, params.spaceId, params.clientId, params.deviceId ?? null, params.lastPushedCursor],
  );
}

export async function getServerWatermark(params: { pool: Pool; tenantId: string; spaceId: string }) {
  const res = await params.pool.query(
    `
      SELECT COALESCE(MAX(cursor), 0)::bigint AS c
      FROM sync_ops
      WHERE tenant_id = $1 AND space_id = $2 AND status = 'accepted'
    `,
    [params.tenantId, params.spaceId],
  );
  return Number(res.rows[0].c);
}

