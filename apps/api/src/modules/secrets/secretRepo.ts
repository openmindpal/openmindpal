import type { Pool, PoolClient } from "pg";
import type { EncryptedPayload } from "./crypto";

type Q = Pool | PoolClient;

export type SecretRecordRow = {
  id: string;
  tenantId: string;
  scopeType: string;
  scopeId: string;
  connectorInstanceId: string;
  status: string;
  keyVersion: number;
  credentialVersion: number;
  rotatedFromId: string | null;
  encFormat: string;
  keyRef: any;
  createdAt: string;
  updatedAt: string;
  activatedAt: string;
  retiredAt: string | null;
  gracePeriodSec: number | null;
  revokedAt: string | null;
};

function toSecret(r: any): SecretRecordRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    connectorInstanceId: r.connector_instance_id,
    status: r.status,
    keyVersion: r.key_version,
    credentialVersion: typeof r.credential_version === "number" ? r.credential_version : Number(r.credential_version ?? 1),
    rotatedFromId: r.rotated_from_id ? String(r.rotated_from_id) : null,
    encFormat: r.enc_format ?? "legacy.a256gcm",
    keyRef: r.key_ref ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    activatedAt: r.activated_at ?? r.created_at,
    retiredAt: r.retired_at ?? null,
    gracePeriodSec: r.grace_period_sec ?? null,
    revokedAt: r.revoked_at,
  };
}

export async function createSecretRecord(params: {
  pool: Q;
  tenantId: string;
  scopeType: string;
  scopeId: string;
  connectorInstanceId: string;
  encryptedPayload: any;
  keyVersion: number;
  encFormat: string;
  keyRef?: any;
  credentialVersion?: number | null;
  rotatedFromId?: string | null;
}) {
  let credentialVersion = typeof params.credentialVersion === "number" && Number.isFinite(params.credentialVersion) && params.credentialVersion > 0 ? Math.round(params.credentialVersion) : null;
  if (!credentialVersion) {
    const cur = await params.pool.query(
      "SELECT COALESCE(MAX(credential_version), 0)::int AS v FROM secret_records WHERE tenant_id = $1 AND connector_instance_id = $2::uuid",
      [params.tenantId, params.connectorInstanceId],
    );
    credentialVersion = Number(cur.rows[0]?.v ?? 0) + 1;
  }
  const res = await params.pool.query(
    `
      INSERT INTO secret_records (tenant_id, scope_type, scope_id, connector_instance_id, status, key_version, credential_version, rotated_from_id, enc_format, key_ref, encrypted_payload)
      VALUES ($1, $2, $3, $4, 'active', $5, $6, $7::uuid, $8, $9::jsonb, $10::jsonb)
      RETURNING *
    `,
    [
      params.tenantId,
      params.scopeType,
      params.scopeId,
      params.connectorInstanceId,
      params.keyVersion,
      credentialVersion,
      params.rotatedFromId ?? null,
      params.encFormat,
      JSON.stringify(params.keyRef ?? null),
      JSON.stringify(params.encryptedPayload),
    ],
  );
  return toSecret(res.rows[0]);
}

export async function listSecretRecords(pool: Pool, tenantId: string, scopeType: string, scopeId: string) {
  const res = await pool.query(
    `
      SELECT id, tenant_id, scope_type, scope_id, connector_instance_id, status, key_version, credential_version, rotated_from_id, enc_format, key_ref, created_at, updated_at, activated_at, retired_at, grace_period_sec, revoked_at
      FROM secret_records
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3
      ORDER BY created_at DESC
      LIMIT 200
    `,
    [tenantId, scopeType, scopeId],
  );
  return res.rows.map(toSecret);
}

export async function getSecretRecord(pool: Pool, tenantId: string, id: string) {
  const res = await pool.query(
    `
      SELECT id, tenant_id, scope_type, scope_id, connector_instance_id, status, key_version, credential_version, rotated_from_id, enc_format, key_ref, created_at, updated_at, activated_at, retired_at, grace_period_sec, revoked_at
      FROM secret_records
      WHERE tenant_id = $1 AND id = $2
      LIMIT 1
    `,
    [tenantId, id],
  );
  if (!res.rowCount) return null;
  return toSecret(res.rows[0]);
}

export async function revokeSecretRecord(pool: Q, tenantId: string, id: string) {
  const res = await pool.query(
    `
      UPDATE secret_records
      SET status = 'revoked', revoked_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING id, tenant_id, scope_type, scope_id, connector_instance_id, status, key_version, credential_version, rotated_from_id, enc_format, key_ref, created_at, updated_at, activated_at, retired_at, grace_period_sec, revoked_at
    `,
    [tenantId, id],
  );
  if (!res.rowCount) return null;
  return toSecret(res.rows[0]);
}

export async function getSecretRecordEncryptedPayload(pool: Pool, tenantId: string, id: string) {
  const res = await pool.query(
    `
      SELECT id, tenant_id, scope_type, scope_id, connector_instance_id, status, key_version, credential_version, rotated_from_id, enc_format, key_ref, encrypted_payload, created_at, updated_at, activated_at, retired_at, grace_period_sec, revoked_at
      FROM secret_records
      WHERE tenant_id = $1 AND id = $2
      LIMIT 1
    `,
    [tenantId, id],
  );
  if (!res.rowCount) return null;
  return { secret: toSecret(res.rows[0]), encryptedPayload: res.rows[0].encrypted_payload as any };
}

export async function updateSecretRecordEncryptedPayload(params: { pool: Q; tenantId: string; id: string; encryptedPayload: any; encFormat?: string | null; keyVersion?: number | null; keyRef?: any }) {
  const res = await params.pool.query(
    `
      UPDATE secret_records
      SET encrypted_payload = $3, enc_format = COALESCE($4, enc_format), key_version = COALESCE($5, key_version), key_ref = COALESCE($6::jsonb, key_ref), updated_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING *
    `,
    [params.tenantId, params.id, params.encryptedPayload, params.encFormat ?? null, params.keyVersion ?? null, params.keyRef === undefined ? null : JSON.stringify(params.keyRef)],
  );
  if (!res.rowCount) return null;
  return toSecret(res.rows[0]);
}

export async function retireSecretRecord(params: { pool: Q; tenantId: string; id: string; gracePeriodSec?: number | null }) {
  const grace = typeof params.gracePeriodSec === "number" && Number.isFinite(params.gracePeriodSec) && params.gracePeriodSec > 0 ? Math.round(params.gracePeriodSec) : null;
  const res = await params.pool.query(
    `
      UPDATE secret_records
      SET status = 'retired', retired_at = now(), grace_period_sec = COALESCE($3, grace_period_sec), updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'active'
      RETURNING *
    `,
    [params.tenantId, params.id, grace],
  );
  if (!res.rowCount) return null;
  return toSecret(res.rows[0]);
}

export async function getLatestSecretForConnectorInstance(params: { pool: Q; tenantId: string; connectorInstanceId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM secret_records
      WHERE tenant_id = $1 AND connector_instance_id = $2
      ORDER BY credential_version DESC, created_at DESC
      LIMIT 1
    `,
    [params.tenantId, params.connectorInstanceId],
  );
  if (!res.rowCount) return null;
  return toSecret(res.rows[0]);
}
