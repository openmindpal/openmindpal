/**
 * SSO/OIDC Runtime — architecture-05 section 15.15
 * Handles: login initiation, OIDC callback token exchange, JWKS verification, session creation.
 */
import crypto from "node:crypto";
import type { Pool } from "pg";
import type { SsoProviderConfigRow } from "./ssoScimRepo";
import { ensureSubject } from "./subjectRepo";

/* --- OIDC Discovery --- */

export type OidcDiscovery = {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  issuer: string;
};

const discoveryCache = new Map<string, { doc: OidcDiscovery; expiresAt: number }>();

export async function fetchOidcDiscovery(issuerUrl: string): Promise<OidcDiscovery> {
  const cached = discoveryCache.get(issuerUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.doc;

  const wellKnown = issuerUrl.replace(/\/+$/, "") + "/.well-known/openid-configuration";
  const res = await fetch(wellKnown);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const doc = (await res.json()) as OidcDiscovery;
  discoveryCache.set(issuerUrl, { doc, expiresAt: Date.now() + 300_000 });
  return doc;
}

/* --- JWKS Cache --- */

export type JwkKey = {
  kty: string;
  kid?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
};

const jwksCache = new Map<string, { keys: JwkKey[]; expiresAt: number }>();

export async function fetchJwks(jwksUri: string): Promise<JwkKey[]> {
  const cached = jwksCache.get(jwksUri);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;

  const res = await fetch(jwksUri);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: JwkKey[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache.set(jwksUri, { keys, expiresAt: Date.now() + 300_000 });
  return keys;
}

/* --- JWT Helpers --- */

function base64UrlDecode(input: string): Buffer {
  let s = input.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4 !== 0) s += "=";
  return Buffer.from(s, "base64");
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT");
  return JSON.parse(base64UrlDecode(parts[1]).toString("utf8"));
}

export function decodeJwtHeader(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT");
  return JSON.parse(base64UrlDecode(parts[0]).toString("utf8"));
}

export function verifyJwtSignature(jwt: string, jwk: JwkKey): boolean {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return false;
    const signedContent = `${parts[0]}.${parts[1]}`;
    const signature = base64UrlDecode(parts[2]);
    const keyObj = crypto.createPublicKey({ key: jwk as any, format: "jwk" });
    return crypto.verify("RSA-SHA256", Buffer.from(signedContent), keyObj, signature);
  } catch {
    return false;
  }
}

/* --- Token Exchange --- */

export async function exchangeCodeForTokens(params: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier?: string;
}): Promise<{ id_token?: string; access_token?: string; refresh_token?: string; expires_in?: number }> {
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
  };
  if (params.codeVerifier) body.code_verifier = params.codeVerifier;

  const res = await fetch(params.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Token exchange failed: ${res.status} ${errBody}`);
  }
  return (await res.json()) as any;
}

/* --- Claim Mapping --- */

export function mapClaims(claims: Record<string, unknown>, mappings: Record<string, string>): {
  subjectId: string;
  email: string | null;
  displayName: string | null;
} {
  const subField = mappings.sub ?? "sub";
  const emailField = mappings.email ?? "email";
  const nameField = mappings.name ?? "name";

  const sub = String(claims[subField] ?? "").trim();
  if (!sub) throw new Error("Missing subject claim in ID token");

  const email = typeof claims[emailField] === "string" ? String(claims[emailField]).trim() : null;
  const displayName = typeof claims[nameField] === "string" ? String(claims[nameField]).trim() : null;

  return { subjectId: sub, email, displayName };
}

/* --- SSO Login State --- */

export async function createSsoLoginState(params: {
  pool: Pool;
  tenantId: string;
  providerId: string;
  state: string;
  nonce: string;
  redirectUri: string;
  ttlSeconds?: number;
}) {
  const ttl = params.ttlSeconds ?? 600;
  await params.pool.query(
    `INSERT INTO sso_login_states (tenant_id, provider_id, state, nonce, redirect_uri, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' seconds')::interval)
     ON CONFLICT (state) DO UPDATE SET nonce = EXCLUDED.nonce, expires_at = EXCLUDED.expires_at`,
    [params.tenantId, params.providerId, params.state, params.nonce, params.redirectUri, String(ttl)],
  );
  return { state: params.state, nonce: params.nonce };
}

export async function consumeSsoLoginState(params: { pool: Pool; state: string }) {
  const res = await params.pool.query(
    `DELETE FROM sso_login_states WHERE state = $1 AND expires_at > now() RETURNING *`,
    [params.state],
  );
  if (!res.rowCount) return null;
  const r = res.rows[0] as any;
  return {
    tenantId: String(r.tenant_id),
    providerId: String(r.provider_id),
    nonce: String(r.nonce),
    redirectUri: String(r.redirect_uri),
  };
}

/* --- Build SSO Authorize URL --- */

export function buildSsoAuthorizeUrl(params: {
  provider: SsoProviderConfigRow;
  authorizationEndpoint: string;
  state: string;
  nonce: string;
  redirectUri: string;
}): string {
  const u = new URL(params.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", params.provider.clientId);
  u.searchParams.set("redirect_uri", params.redirectUri);
  u.searchParams.set("scope", params.provider.scopes || "openid profile email");
  u.searchParams.set("state", params.state);
  u.searchParams.set("nonce", params.nonce);
  return u.toString();
}

/* --- Auto-Provision User --- */

export async function autoProvisionSsoUser(params: {
  pool: Pool;
  tenantId: string;
  provider: SsoProviderConfigRow;
  subjectId: string;
  email: string | null;
  displayName: string | null;
}) {
  await ensureSubject({ pool: params.pool, tenantId: params.tenantId, subjectId: params.subjectId });
  if (params.provider.defaultRoleId) {
    await params.pool.query(
      `INSERT INTO role_bindings (subject_id, role_id, scope_type, scope_id)
       VALUES ($1, $2, 'tenant', $3)
       ON CONFLICT DO NOTHING`,
      [params.subjectId, params.provider.defaultRoleId, params.tenantId],
    );
  }
}
