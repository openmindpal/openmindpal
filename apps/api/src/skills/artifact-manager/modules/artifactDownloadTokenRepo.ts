import crypto from "node:crypto";
import type { Pool } from "pg";

export type ArtifactDownloadTokenRow = {
  tokenId: string;
  tenantId: string;
  spaceId: string;
  artifactId: string;
  issuedBySubjectId: string | null;
  tokenHash: string;
  expiresAt: string;
  maxUses: number;
  usedCount: number;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function toRow(r: any): ArtifactDownloadTokenRow {
  return {
    tokenId: String(r.token_id),
    tenantId: String(r.tenant_id),
    spaceId: String(r.space_id),
    artifactId: String(r.artifact_id),
    issuedBySubjectId: r.issued_by_subject_id ? String(r.issued_by_subject_id) : null,
    tokenHash: String(r.token_hash),
    expiresAt: new Date(r.expires_at).toISOString(),
    maxUses: Number(r.max_uses),
    usedCount: Number(r.used_count),
    revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export function hashDownloadToken(token: string) {
  return sha256Hex(token);
}

export function generateDownloadToken() {
  return crypto.randomBytes(24).toString("base64url");
}

export async function createArtifactDownloadToken(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  artifactId: string;
  issuedBySubjectId: string | null;
  tokenId: string;
  tokenHash: string;
  expiresAt: string;
  maxUses: number;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO artifact_download_tokens (
        token_id, tenant_id, space_id, artifact_id, issued_by_subject_id,
        token_hash, expires_at, max_uses
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
    `,
    [
      params.tokenId,
      params.tenantId,
      params.spaceId,
      params.artifactId,
      params.issuedBySubjectId,
      params.tokenHash,
      params.expiresAt,
      params.maxUses,
    ],
  );
  return toRow(res.rows[0]);
}

export async function getArtifactDownloadTokenByHash(params: { pool: Pool; tokenHash: string }) {
  const res = await params.pool.query("SELECT * FROM artifact_download_tokens WHERE token_hash = $1 LIMIT 1", [params.tokenHash]);
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function consumeArtifactDownloadTokenByHash(params: { pool: Pool; tokenHash: string }) {
  const res = await params.pool.query(
    `
      UPDATE artifact_download_tokens
      SET used_count = used_count + 1,
          updated_at = now()
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > now()
        AND used_count < max_uses
      RETURNING *
    `,
    [params.tokenHash],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

