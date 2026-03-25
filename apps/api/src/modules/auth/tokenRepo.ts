import crypto from "node:crypto";
import type { Pool } from "pg";

export type AuthTokenRow = {
  id: string;
  tenantId: string;
  spaceId: string | null;
  subjectId: string;
  name: string | null;
  tokenHash: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
};

function rowToToken(r: any): AuthTokenRow {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    spaceId: r.space_id ? String(r.space_id) : null,
    subjectId: String(r.subject_id),
    name: r.name ? String(r.name) : null,
    tokenHash: String(r.token_hash),
    createdAt: String(r.created_at),
    lastUsedAt: r.last_used_at ? String(r.last_used_at) : null,
    expiresAt: r.expires_at ? String(r.expires_at) : null,
    revokedAt: r.revoked_at ? String(r.revoked_at) : null,
  };
}

export function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function genPatToken() {
  const raw = crypto.randomBytes(24).toString("base64url");
  return `pat_${raw}`;
}

export async function createAuthToken(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string;
  name?: string | null;
  expiresAt?: string | null;
}) {
  const token = genPatToken();
  const tokenHash = sha256Hex(token);
  const res = await params.pool.query(
    `
      INSERT INTO auth_tokens (tenant_id, space_id, subject_id, name, token_hash, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
    `,
    [params.tenantId, params.spaceId, params.subjectId, params.name ?? null, tokenHash, params.expiresAt ?? null],
  );
  return { token, record: rowToToken(res.rows[0]) };
}

export async function listAuthTokens(params: { pool: Pool; tenantId: string; subjectId: string; limit: number }) {
  const limit = Math.max(1, Math.min(200, params.limit));
  const res = await params.pool.query(
    `
      SELECT *
      FROM auth_tokens
      WHERE tenant_id = $1 AND subject_id = $2
      ORDER BY created_at DESC
      LIMIT $3
    `,
    [params.tenantId, params.subjectId, limit],
  );
  return res.rows.map(rowToToken);
}

export async function getAuthTokenByHash(params: { pool: Pool; tokenHash: string }) {
  const res = await params.pool.query("SELECT * FROM auth_tokens WHERE token_hash = $1 LIMIT 1", [params.tokenHash]);
  if (!res.rowCount) return null;
  return rowToToken(res.rows[0]);
}

export async function getAuthTokenById(params: { pool: Pool; tenantId: string; tokenId: string }) {
  const res = await params.pool.query("SELECT * FROM auth_tokens WHERE tenant_id = $1 AND id = $2 LIMIT 1", [params.tenantId, params.tokenId]);
  if (!res.rowCount) return null;
  return rowToToken(res.rows[0]);
}

export async function touchAuthTokenLastUsed(params: { pool: Pool; tokenId: string }) {
  await params.pool.query("UPDATE auth_tokens SET last_used_at = now() WHERE id = $1", [params.tokenId]);
}

export async function revokeAuthToken(params: { pool: Pool; tenantId: string; tokenId: string }) {
  const res = await params.pool.query(
    `
      UPDATE auth_tokens
      SET revoked_at = now()
      WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL
      RETURNING *
    `,
    [params.tenantId, params.tokenId],
  );
  if (!res.rowCount) return null;
  return rowToToken(res.rows[0]);
}
