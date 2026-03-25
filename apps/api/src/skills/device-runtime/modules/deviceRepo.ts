import type { Pool } from "pg";

export type DeviceRecordRow = {
  deviceId: string;
  tenantId: string;
  ownerScope: string;
  ownerSubjectId: string | null;
  spaceId: string | null;
  deviceType: string;
  os: string;
  agentVersion: string;
  status: string;
  enrolledAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  updatedAt: string;
};

function toRow(r: any): DeviceRecordRow {
  return {
    deviceId: r.device_id,
    tenantId: r.tenant_id,
    ownerScope: r.owner_scope,
    ownerSubjectId: r.owner_subject_id ?? null,
    spaceId: r.space_id ?? null,
    deviceType: r.device_type,
    os: r.os,
    agentVersion: r.agent_version,
    status: r.status,
    enrolledAt: r.enrolled_at,
    lastSeenAt: r.last_seen_at ?? null,
    revokedAt: r.revoked_at ?? null,
    updatedAt: r.updated_at,
  };
}

export async function createDeviceRecord(params: {
  pool: Pool;
  tenantId: string;
  ownerScope: "user" | "space";
  ownerSubjectId?: string | null;
  spaceId?: string | null;
  deviceType: "desktop" | "mobile";
  os: string;
  agentVersion: string;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO device_records (
        tenant_id, owner_scope, owner_subject_id, space_id,
        device_type, os, agent_version, status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')
      RETURNING *
    `,
    [
      params.tenantId,
      params.ownerScope,
      params.ownerSubjectId ?? null,
      params.spaceId ?? null,
      params.deviceType,
      params.os,
      params.agentVersion,
    ],
  );
  return toRow(res.rows[0]);
}

export async function getDeviceRecord(params: { pool: Pool; tenantId: string; deviceId: string }) {
  const res = await params.pool.query("SELECT * FROM device_records WHERE tenant_id = $1 AND device_id = $2 LIMIT 1", [
    params.tenantId,
    params.deviceId,
  ]);
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function listDeviceRecords(params: { pool: Pool; tenantId: string; ownerScope: "user" | "space"; ownerSubjectId?: string | null; spaceId?: string | null; limit: number; offset: number }) {
  const where: string[] = ["tenant_id = $1", "owner_scope = $2"];
  const args: any[] = [params.tenantId, params.ownerScope];
  let idx = 3;
  if (params.ownerScope === "user") {
    where.push(`owner_subject_id = $${idx++}`);
    args.push(params.ownerSubjectId ?? "");
  } else {
    where.push(`space_id = $${idx++}`);
    args.push(params.spaceId ?? "");
  }
  args.push(params.limit);
  args.push(params.offset);
  const res = await params.pool.query(
    `
      SELECT *
      FROM device_records
      WHERE ${where.join(" AND ")}
      ORDER BY enrolled_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `,
    args,
  );
  return res.rows.map(toRow);
}

export async function activateDeviceWithToken(params: { pool: Pool; tenantId: string; deviceId: string; deviceTokenHash: string; deviceType: "desktop" | "mobile"; os: string; agentVersion: string }) {
  const res = await params.pool.query(
    `
      UPDATE device_records
      SET status = 'active',
          device_token_hash = $3,
          device_type = $4,
          os = $5,
          agent_version = $6,
          last_seen_at = now(),
          updated_at = now()
      WHERE tenant_id = $1 AND device_id = $2 AND status = 'pending'
      RETURNING *
    `,
    [params.tenantId, params.deviceId, params.deviceTokenHash, params.deviceType, params.os, params.agentVersion],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function updateDeviceLastSeen(params: { pool: Pool; tenantId: string; deviceId: string; os: string; agentVersion: string }) {
  const res = await params.pool.query(
    `
      UPDATE device_records
      SET last_seen_at = now(), os = $3, agent_version = $4, updated_at = now()
      WHERE tenant_id = $1 AND device_id = $2 AND status = 'active'
      RETURNING *
    `,
    [params.tenantId, params.deviceId, params.os, params.agentVersion],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function revokeDeviceRecord(params: { pool: Pool; tenantId: string; deviceId: string }) {
  const res = await params.pool.query(
    `
      UPDATE device_records
      SET status = 'revoked', revoked_at = now(), device_token_hash = NULL, updated_at = now()
      WHERE tenant_id = $1 AND device_id = $2
      RETURNING *
    `,
    [params.tenantId, params.deviceId],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function getDeviceByTokenHash(params: { pool: Pool; deviceTokenHash: string }) {
  const res = await params.pool.query("SELECT * FROM device_records WHERE device_token_hash = $1 AND status = 'active' LIMIT 1", [
    params.deviceTokenHash,
  ]);
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

