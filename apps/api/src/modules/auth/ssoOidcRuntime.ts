import crypto from "node:crypto";
import type { Pool } from "pg";
import { getSsoProvider, getSsoProviderByIssuer, type SsoProviderConfigRow } from "./ssoScimRepo";

/* ─── OIDC Discovery / JWKS cache ─── */

type JwksCache = { keys: any[]; fetchedAt: number };
const jwksCache = new Map<string, JwksCache>();
const JWKS_TTL_MS = 300_000; // 5 min

export async function fetchJwks(jwksUri: string): Promise<any[]> {
  const cached = jwksCache.get(jwksUri);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  const res = await fetch(jwksUri);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const json: any = await res.json();
  const keys = Array.isArray(json?.keys) ? json.keys : [];
  jwksCache.set(jwksUri, { keys, fetchedAt: Date.now() });
  return keys;
}

export async function discoverOidcEndpoints(issuerUrl: string) {
  const wellKnown = issuerUrl.replace(/\/+$/, "") + "/.well-known/openid-configuration";
  const res = await fetch(wellKnown);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const cfg: any = await res.json();
  return {
    authorization_endpoint: String(cfg.authorization_endpoint ?? ""),
    token_endpoint: String(cfg.token_endpoint ?? ""),
    userinfo_endpoint: String(cfg.userinfo_endpoint ?? ""),
    jwks_uri: String(cfg.jwks_uri ?? ""),
    issuer: String(cfg.issuer ?? ""),
  };
}

/* ─── Token verification (simplified – production should use jose/jwks) ─── */

export function decodeJwtPayload(token: string): Record<string, any> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT");
  const payload = Buffer.from(parts[1], "base64url").toString("utf8");
  return JSON.parse(payload);
}

export function validateIdTokenClaims(params: {
  claims: Record<string, any>;
  issuer: string;
  clientId: string;
  clockSkewSec?: number;
}) {
  const { claims, issuer, clientId, clockSkewSec = 120 } = params;
  if (claims.iss !== issuer) throw new Error(`iss mismatch: expected ${issuer}, got ${claims.iss}`);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new Error(`aud mismatch`);
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && claims.exp + clockSkewSec < now) throw new Error("id_token expired");
  if (typeof claims.iat === "number" && claims.iat - clockSkewSec > now) throw new Error("id_token iat in future");
}

/* ─── Claim mapping ─── */

export function mapClaims(claims: Record<string, any>, mapping: Record<string, string>): {
  subjectId: string;
  email: string | null;
  displayName: string | null;
} {
  const subField = mapping.subjectId ?? mapping.sub ?? "sub";
  const emailField = mapping.email ?? "email";
  const nameField = mapping.displayName ?? mapping.name ?? "name";
  return {
    subjectId: String(claims[subField] ?? claims.sub ?? ""),
    email: claims[emailField] ? String(claims[emailField]) : null,
    displayName: claims[nameField] ? String(claims[nameField]) : null,
  };
}

/* ─── SSO State (nonce + state) ─── */

export function generateSsoState() {
  return crypto.randomBytes(24).toString("base64url");
}

export function generateNonce() {
  return crypto.randomBytes(16).toString("base64url");
}

/* ─── SSO state persistence ─── */

export async function createSsoLoginState(params: {
  pool: Pool;
  tenantId: string;
  providerId: string;
  state: string;
  nonce: string;
  redirectUri: string;
  ttlSeconds?: number;
}) {
  const id = crypto.randomUUID();
  const ttl = params.ttlSeconds ?? 600;
  await params.pool.query(
    `INSERT INTO sso_login_states (id, tenant_id, provider_id, state, nonce, redirect_uri, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' seconds')::interval)`,
    [id, params.tenantId, params.providerId, params.state, params.nonce, params.redirectUri, String(ttl)],
  );
  return { id, state: params.state, nonce: params.nonce };
}

export async function consumeSsoLoginState(params: { pool: Pool; state: string }) {
  const res = await params.pool.query(
    `UPDATE sso_login_states SET consumed_at = now()
     WHERE state = $1 AND consumed_at IS NULL AND expires_at > now()
     RETURNING *`,
    [params.state],
  );
  if (!res.rowCount) return null;
  const r = res.rows[0] as any;
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    providerId: String(r.provider_id),
    state: String(r.state),
    nonce: String(r.nonce),
    redirectUri: String(r.redirect_uri),
  };
}

/* ─── OIDC Token Exchange ─── */

export async function exchangeCodeForTokens(params: {
  tokenEndpoint: string;
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });
  const res = await fetch(params.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${json?.error ?? ""}`);
  return {
    access_token: String(json.access_token ?? ""),
    id_token: String(json.id_token ?? ""),
    refresh_token: json.refresh_token ? String(json.refresh_token) : null,
    expires_in: typeof json.expires_in === "number" ? json.expires_in : null,
    token_type: String(json.token_type ?? "Bearer"),
  };
}

/* ─── Build authorize URL ─── */

export function buildSsoAuthorizeUrl(params: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  scopes: string;
}) {
  const u = new URL(params.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", params.clientId);
  u.searchParams.set("redirect_uri", params.redirectUri);
  u.searchParams.set("state", params.state);
  u.searchParams.set("nonce", params.nonce);
  u.searchParams.set("scope", params.scopes || "openid profile email");
  return u.toString();
}
