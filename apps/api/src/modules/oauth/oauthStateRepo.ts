import crypto from "node:crypto";
import type { Pool } from "pg";

export type OAuthStateRow = {
  id: string;
  tenantId: string;
  spaceId: string | null;
  subjectId: string;
  connectorInstanceId: string;
  provider: string;
  stateHash: string;
  nonceHash: string | null;
  pkceEncFormat: string | null;
  pkceKeyVersion: number | null;
  pkceEncryptedPayload: any | null;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
};

function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function toRow(r: any): OAuthStateRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    spaceId: r.space_id ?? null,
    subjectId: r.subject_id,
    connectorInstanceId: r.connector_instance_id,
    provider: r.provider,
    stateHash: r.state_hash,
    nonceHash: r.nonce_hash ?? null,
    pkceEncFormat: r.pkce_enc_format ?? null,
    pkceKeyVersion: typeof r.pkce_key_version === "number" ? r.pkce_key_version : r.pkce_key_version != null ? Number(r.pkce_key_version) : null,
    pkceEncryptedPayload: r.pkce_encrypted_payload ?? null,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    consumedAt: r.consumed_at ?? null,
  };
}

export function newOAuthStateValue() {
  return crypto.randomBytes(32).toString("base64url");
}

export async function createOAuthState(params: {
  pool: Pool;
  tenantId: string;
  spaceId?: string | null;
  subjectId: string;
  connectorInstanceId: string;
  provider: string;
  state: string;
  nonce?: string | null;
  pkceEncFormat?: string | null;
  pkceKeyVersion?: number | null;
  pkceEncryptedPayload?: any | null;
  ttlSeconds: number;
}) {
  const now = Date.now();
  const expiresAt = new Date(now + params.ttlSeconds * 1000).toISOString();
  const stateHash = sha256Hex(params.state);
  const nonceHash = params.nonce ? sha256Hex(params.nonce) : null;
  const res = await params.pool.query(
    `
      INSERT INTO oauth_states (tenant_id, space_id, subject_id, connector_instance_id, provider, state_hash, nonce_hash, pkce_enc_format, pkce_key_version, pkce_encrypted_payload, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::timestamptz)
      RETURNING *
    `,
    [
      params.tenantId,
      params.spaceId ?? null,
      params.subjectId,
      params.connectorInstanceId,
      params.provider,
      stateHash,
      nonceHash,
      params.pkceEncFormat ?? null,
      params.pkceKeyVersion ?? null,
      params.pkceEncryptedPayload != null ? JSON.stringify(params.pkceEncryptedPayload) : null,
      expiresAt,
    ],
  );
  return { row: toRow(res.rows[0]), expiresAt };
}

export async function getOAuthStateByState(params: { pool: Pool; state: string }) {
  const stateHash = sha256Hex(params.state);
  const res = await params.pool.query("SELECT * FROM oauth_states WHERE state_hash = $1 LIMIT 1", [stateHash]);
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function consumeOAuthState(params: { pool: Pool; state: string }) {
  const stateHash = sha256Hex(params.state);
  const res = await params.pool.query(
    `
      UPDATE oauth_states
      SET consumed_at = now()
      WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING *
    `,
    [stateHash],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}
