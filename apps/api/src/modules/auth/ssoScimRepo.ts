import type { Pool } from "pg";
import crypto from "node:crypto";

// ---- SSO Provider Config ----

export type SsoProviderConfigRow = {
  providerId: string;
  tenantId: string;
  providerType: string;
  issuerUrl: string;
  clientId: string;
  clientSecretRef: string | null;
  scopes: string;
  redirectUri: string | null;
  jwksUri: string | null;
  userinfoEndpoint: string | null;
  claimMappings: any;
  autoProvision: boolean;
  defaultRoleId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

function toProvider(r: any): SsoProviderConfigRow {
  return {
    providerId: String(r.provider_id),
    tenantId: String(r.tenant_id),
    providerType: String(r.provider_type ?? "oidc"),
    issuerUrl: String(r.issuer_url),
    clientId: String(r.client_id),
    clientSecretRef: r.client_secret_ref ? String(r.client_secret_ref) : null,
    scopes: String(r.scopes ?? "openid profile email"),
    redirectUri: r.redirect_uri ? String(r.redirect_uri) : null,
    jwksUri: r.jwks_uri ? String(r.jwks_uri) : null,
    userinfoEndpoint: r.userinfo_endpoint ? String(r.userinfo_endpoint) : null,
    claimMappings: r.claim_mappings ?? {},
    autoProvision: Boolean(r.auto_provision),
    defaultRoleId: r.default_role_id ? String(r.default_role_id) : null,
    status: String(r.status ?? "active"),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function createSsoProvider(params: {
  pool: Pool;
  tenantId: string;
  providerType?: string;
  issuerUrl: string;
  clientId: string;
  clientSecretRef?: string | null;
  scopes?: string;
  redirectUri?: string | null;
  jwksUri?: string | null;
  userinfoEndpoint?: string | null;
  claimMappings?: any;
  autoProvision?: boolean;
  defaultRoleId?: string | null;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO sso_provider_configs (tenant_id, provider_type, issuer_url, client_id, client_secret_ref, scopes, redirect_uri, jwks_uri, userinfo_endpoint, claim_mappings, auto_provision, default_role_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
      RETURNING *
    `,
    [
      params.tenantId,
      params.providerType ?? "oidc",
      params.issuerUrl,
      params.clientId,
      params.clientSecretRef ?? null,
      params.scopes ?? "openid profile email",
      params.redirectUri ?? null,
      params.jwksUri ?? null,
      params.userinfoEndpoint ?? null,
      JSON.stringify(params.claimMappings ?? {}),
      params.autoProvision ?? false,
      params.defaultRoleId ?? null,
    ],
  );
  return toProvider(res.rows[0]);
}

export async function getSsoProvider(params: { pool: Pool; tenantId: string; providerId: string }) {
  const res = await params.pool.query("SELECT * FROM sso_provider_configs WHERE tenant_id = $1 AND provider_id = $2 LIMIT 1", [params.tenantId, params.providerId]);
  if (!res.rowCount) return null;
  return toProvider(res.rows[0]);
}

export async function getSsoProviderByIssuer(params: { pool: Pool; tenantId: string; issuerUrl: string }) {
  const res = await params.pool.query("SELECT * FROM sso_provider_configs WHERE tenant_id = $1 AND issuer_url = $2 AND status = 'active' LIMIT 1", [params.tenantId, params.issuerUrl]);
  if (!res.rowCount) return null;
  return toProvider(res.rows[0]);
}

export async function listSsoProviders(params: { pool: Pool; tenantId: string }) {
  const res = await params.pool.query("SELECT * FROM sso_provider_configs WHERE tenant_id = $1 ORDER BY created_at ASC", [params.tenantId]);
  return res.rows.map(toProvider);
}

export async function updateSsoProviderStatus(params: { pool: Pool; tenantId: string; providerId: string; status: string }) {
  const res = await params.pool.query(
    "UPDATE sso_provider_configs SET status = $3, updated_at = now() WHERE tenant_id = $1 AND provider_id = $2 RETURNING *",
    [params.tenantId, params.providerId, params.status],
  );
  if (!res.rowCount) return null;
  return toProvider(res.rows[0]);
}

export async function deleteSsoProvider(params: { pool: Pool; tenantId: string; providerId: string }) {
  const res = await params.pool.query("DELETE FROM sso_provider_configs WHERE tenant_id = $1 AND provider_id = $2", [params.tenantId, params.providerId]);
  return Boolean(res.rowCount);
}

// ---- SCIM Config ----

export type ScimConfigRow = {
  scimConfigId: string;
  tenantId: string;
  bearerTokenHash: string;
  allowedOperations: string[];
  autoProvision: boolean;
  defaultRoleId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

function toScimConfig(r: any): ScimConfigRow {
  return {
    scimConfigId: String(r.scim_config_id),
    tenantId: String(r.tenant_id),
    bearerTokenHash: String(r.bearer_token_hash),
    allowedOperations: Array.isArray(r.allowed_operations) ? r.allowed_operations : [],
    autoProvision: Boolean(r.auto_provision),
    defaultRoleId: r.default_role_id ? String(r.default_role_id) : null,
    status: String(r.status ?? "active"),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function hashScimToken(token: string) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export async function upsertScimConfig(params: {
  pool: Pool;
  tenantId: string;
  bearerToken: string;
  allowedOperations?: string[];
  autoProvision?: boolean;
  defaultRoleId?: string | null;
}) {
  const hash = hashScimToken(params.bearerToken);
  const ops = params.allowedOperations ?? ["Users.list", "Users.get", "Users.create", "Users.update", "Users.delete", "Groups.list", "Groups.get"];
  const res = await params.pool.query(
    `
      INSERT INTO scim_configs (tenant_id, bearer_token_hash, allowed_operations, auto_provision, default_role_id)
      VALUES ($1,$2,$3::jsonb,$4,$5)
      ON CONFLICT (tenant_id) DO UPDATE
      SET bearer_token_hash = EXCLUDED.bearer_token_hash,
          allowed_operations = EXCLUDED.allowed_operations,
          auto_provision = EXCLUDED.auto_provision,
          default_role_id = EXCLUDED.default_role_id,
          updated_at = now()
      RETURNING *
    `,
    [params.tenantId, hash, JSON.stringify(ops), params.autoProvision ?? true, params.defaultRoleId ?? null],
  );
  return toScimConfig(res.rows[0]);
}

export async function getScimConfig(params: { pool: Pool; tenantId: string }) {
  const res = await params.pool.query("SELECT * FROM scim_configs WHERE tenant_id = $1 AND status = 'active' LIMIT 1", [params.tenantId]);
  if (!res.rowCount) return null;
  return toScimConfig(res.rows[0]);
}

export async function validateScimToken(params: { pool: Pool; tenantId: string; bearerToken: string }) {
  const hash = hashScimToken(params.bearerToken);
  const res = await params.pool.query("SELECT * FROM scim_configs WHERE tenant_id = $1 AND bearer_token_hash = $2 AND status = 'active' LIMIT 1", [params.tenantId, hash]);
  if (!res.rowCount) return null;
  return toScimConfig(res.rows[0]);
}

// ---- SCIM Provisioned Users ----

export type ScimProvisionedUserRow = {
  scimUserId: string;
  tenantId: string;
  externalId: string;
  subjectId: string;
  displayName: string | null;
  email: string | null;
  active: boolean;
  lastSyncedAt: string;
  createdAt: string;
  updatedAt: string;
};

function toScimUser(r: any): ScimProvisionedUserRow {
  return {
    scimUserId: String(r.scim_user_id),
    tenantId: String(r.tenant_id),
    externalId: String(r.external_id),
    subjectId: String(r.subject_id),
    displayName: r.display_name ? String(r.display_name) : null,
    email: r.email ? String(r.email) : null,
    active: Boolean(r.active),
    lastSyncedAt: String(r.last_synced_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function upsertScimUser(params: {
  pool: Pool;
  tenantId: string;
  externalId: string;
  subjectId: string;
  displayName?: string | null;
  email?: string | null;
  active?: boolean;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO scim_provisioned_users (tenant_id, external_id, subject_id, display_name, email, active, last_synced_at)
      VALUES ($1,$2,$3,$4,$5,$6,now())
      ON CONFLICT (tenant_id, external_id) DO UPDATE
      SET subject_id = EXCLUDED.subject_id,
          display_name = COALESCE(EXCLUDED.display_name, scim_provisioned_users.display_name),
          email = COALESCE(EXCLUDED.email, scim_provisioned_users.email),
          active = EXCLUDED.active,
          last_synced_at = now(),
          updated_at = now()
      RETURNING *
    `,
    [params.tenantId, params.externalId, params.subjectId, params.displayName ?? null, params.email ?? null, params.active ?? true],
  );
  return toScimUser(res.rows[0]);
}

export async function getScimUserByExternalId(params: { pool: Pool; tenantId: string; externalId: string }) {
  const res = await params.pool.query("SELECT * FROM scim_provisioned_users WHERE tenant_id = $1 AND external_id = $2 LIMIT 1", [params.tenantId, params.externalId]);
  if (!res.rowCount) return null;
  return toScimUser(res.rows[0]);
}

export async function listScimUsers(params: { pool: Pool; tenantId: string; limit?: number; offset?: number }) {
  const limit = Math.max(1, Math.min(200, params.limit ?? 50));
  const offset = Math.max(0, params.offset ?? 0);
  const res = await params.pool.query(
    "SELECT * FROM scim_provisioned_users WHERE tenant_id = $1 ORDER BY created_at ASC LIMIT $2 OFFSET $3",
    [params.tenantId, limit, offset],
  );
  return res.rows.map(toScimUser);
}

export async function deactivateScimUser(params: { pool: Pool; tenantId: string; externalId: string }) {
  const res = await params.pool.query(
    "UPDATE scim_provisioned_users SET active = false, updated_at = now() WHERE tenant_id = $1 AND external_id = $2 RETURNING *",
    [params.tenantId, params.externalId],
  );
  if (!res.rowCount) return null;
  return toScimUser(res.rows[0]);
}
