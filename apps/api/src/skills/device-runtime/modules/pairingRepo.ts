import type { Pool } from "pg";

export type DevicePairingRow = {
  id: string;
  tenantId: string;
  deviceId: string;
  codeHash: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
};

function toRow(r: any): DevicePairingRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    deviceId: r.device_id,
    codeHash: r.code_hash,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    consumedAt: r.consumed_at ?? null,
  };
}

export async function createDevicePairing(params: { pool: Pool; tenantId: string; deviceId: string; codeHash: string; ttlSeconds: number }) {
  const expiresAt = new Date(Date.now() + params.ttlSeconds * 1000).toISOString();
  const res = await params.pool.query(
    `
      INSERT INTO device_pairings (tenant_id, device_id, code_hash, expires_at)
      VALUES ($1,$2,$3,$4::timestamptz)
      RETURNING *
    `,
    [params.tenantId, params.deviceId, params.codeHash, expiresAt],
  );
  return { pairing: toRow(res.rows[0]), expiresAt };
}

export async function getDevicePairingByCodeHash(params: { pool: Pool; codeHash: string }) {
  const res = await params.pool.query("SELECT * FROM device_pairings WHERE code_hash = $1 LIMIT 1", [params.codeHash]);
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function consumeDevicePairing(params: { pool: Pool; codeHash: string }) {
  const res = await params.pool.query(
    `
      UPDATE device_pairings
      SET consumed_at = now()
      WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING *
    `,
    [params.codeHash],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

