/**
 * Device Authentication — kernel-level device token lookup.
 *
 * This module lives in lib/ so that plugins/authentication.ts can resolve
 * device tokens WITHOUT importing from the device-runtime Skill's modules.
 * The device-runtime Skill's deviceRepo.ts re-exports this for backward compat.
 */
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

export async function getDeviceByTokenHash(params: { pool: Pool; deviceTokenHash: string }) {
  const res = await params.pool.query("SELECT * FROM device_records WHERE device_token_hash = $1 AND status = 'active' LIMIT 1", [
    params.deviceTokenHash,
  ]);
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}
