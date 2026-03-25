import type { Pool } from "pg";

export type OAuthGrantRow = {
  grantId: string;
  tenantId: string;
  spaceId: string | null;
  connectorInstanceId: string;
  provider: string;
  secretRecordId: string;
  scopes: string | null;
  tokenExpiresAt: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

function toRow(r: any): OAuthGrantRow {
  return {
    grantId: r.grant_id,
    tenantId: r.tenant_id,
    spaceId: r.space_id ?? null,
    connectorInstanceId: r.connector_instance_id,
    provider: r.provider,
    secretRecordId: r.secret_record_id,
    scopes: r.scopes ?? null,
    tokenExpiresAt: r.token_expires_at ?? null,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function getOAuthGrantById(params: { pool: Pool; tenantId: string; grantId: string }) {
  const res = await params.pool.query("SELECT * FROM oauth_grants WHERE tenant_id = $1 AND grant_id = $2 LIMIT 1", [params.tenantId, params.grantId]);
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function getOAuthGrantByConnectorInstance(params: { pool: Pool; tenantId: string; connectorInstanceId: string; provider: string }) {
  const res = await params.pool.query(
    "SELECT * FROM oauth_grants WHERE tenant_id = $1 AND connector_instance_id = $2 AND provider = $3 LIMIT 1",
    [params.tenantId, params.connectorInstanceId, params.provider],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function upsertOAuthGrant(params: {
  pool: Pool;
  tenantId: string;
  spaceId?: string | null;
  connectorInstanceId: string;
  provider: string;
  secretRecordId: string;
  scopes?: string | null;
  tokenExpiresAt?: string | null;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO oauth_grants (tenant_id, space_id, connector_instance_id, provider, secret_record_id, scopes, token_expires_at, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,'active')
      ON CONFLICT (tenant_id, connector_instance_id, provider)
      DO UPDATE SET
        secret_record_id = EXCLUDED.secret_record_id,
        scopes = EXCLUDED.scopes,
        token_expires_at = EXCLUDED.token_expires_at,
        status = 'active',
        updated_at = now()
      RETURNING *
    `,
    [
      params.tenantId,
      params.spaceId ?? null,
      params.connectorInstanceId,
      params.provider,
      params.secretRecordId,
      params.scopes ?? null,
      params.tokenExpiresAt ?? null,
    ],
  );
  return toRow(res.rows[0]);
}

