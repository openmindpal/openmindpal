import type { Pool, PoolClient } from "pg";

type Q = Pool | PoolClient;

export type OAuthProviderConfigRow = {
  tenantId: string;
  connectorInstanceId: string;
  provider: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  refreshEndpoint: string | null;
  userinfoEndpoint: string | null;
  clientId: string;
  clientSecretSecretId: string;
  scopes: string | null;
  pkceEnabled: boolean;
  tokenAuthMethod: "client_secret_post" | "client_secret_basic";
  extraAuthorizeParams: any;
  extraTokenParams: any;
  createdAt: string;
  updatedAt: string;
};

function toRow(r: any): OAuthProviderConfigRow {
  const m = String(r.token_auth_method ?? "client_secret_post");
  const tokenAuthMethod = m === "client_secret_basic" ? "client_secret_basic" : "client_secret_post";
  return {
    tenantId: r.tenant_id,
    connectorInstanceId: r.connector_instance_id,
    provider: r.provider,
    authorizeEndpoint: r.authorize_endpoint,
    tokenEndpoint: r.token_endpoint,
    refreshEndpoint: r.refresh_endpoint ?? null,
    userinfoEndpoint: r.userinfo_endpoint ?? null,
    clientId: r.client_id,
    clientSecretSecretId: r.client_secret_secret_id,
    scopes: r.scopes ?? null,
    pkceEnabled: Boolean(r.pkce_enabled),
    tokenAuthMethod,
    extraAuthorizeParams: r.extra_authorize_params ?? {},
    extraTokenParams: r.extra_token_params ?? {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function getOAuthProviderConfig(params: { pool: Q; tenantId: string; connectorInstanceId: string; provider: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM oauth_provider_configs
      WHERE tenant_id = $1 AND connector_instance_id = $2 AND provider = $3
      LIMIT 1
    `,
    [params.tenantId, params.connectorInstanceId, params.provider],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function upsertOAuthProviderConfig(params: {
  pool: Q;
  tenantId: string;
  connectorInstanceId: string;
  provider: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  refreshEndpoint: string | null;
  userinfoEndpoint: string | null;
  clientId: string;
  clientSecretSecretId: string;
  scopes: string | null;
  pkceEnabled: boolean;
  tokenAuthMethod: "client_secret_post" | "client_secret_basic";
  extraAuthorizeParams: any;
  extraTokenParams: any;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO oauth_provider_configs (
        tenant_id, connector_instance_id, provider,
        authorize_endpoint, token_endpoint, refresh_endpoint, userinfo_endpoint,
        client_id, client_secret_secret_id, scopes, pkce_enabled, token_auth_method,
        extra_authorize_params, extra_token_params
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb)
      ON CONFLICT (tenant_id, connector_instance_id, provider)
      DO UPDATE SET
        authorize_endpoint = EXCLUDED.authorize_endpoint,
        token_endpoint = EXCLUDED.token_endpoint,
        refresh_endpoint = EXCLUDED.refresh_endpoint,
        userinfo_endpoint = EXCLUDED.userinfo_endpoint,
        client_id = EXCLUDED.client_id,
        client_secret_secret_id = EXCLUDED.client_secret_secret_id,
        scopes = EXCLUDED.scopes,
        pkce_enabled = EXCLUDED.pkce_enabled,
        token_auth_method = EXCLUDED.token_auth_method,
        extra_authorize_params = EXCLUDED.extra_authorize_params,
        extra_token_params = EXCLUDED.extra_token_params,
        updated_at = now()
      RETURNING *
    `,
    [
      params.tenantId,
      params.connectorInstanceId,
      params.provider,
      params.authorizeEndpoint,
      params.tokenEndpoint,
      params.refreshEndpoint,
      params.userinfoEndpoint,
      params.clientId,
      params.clientSecretSecretId,
      params.scopes,
      params.pkceEnabled,
      params.tokenAuthMethod,
      JSON.stringify(params.extraAuthorizeParams ?? {}),
      JSON.stringify(params.extraTokenParams ?? {}),
    ],
  );
  return toRow(res.rows[0]);
}
