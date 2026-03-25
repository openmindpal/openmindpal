import type { Pool } from "pg";

export type ArtifactPolicy = {
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  downloadTokenExpiresInSec: number;
  downloadTokenMaxUses: number;
  watermarkHeadersEnabled: boolean;
  updatedAt: string;
};

function toRow(r: any): ArtifactPolicy {
  return {
    tenantId: String(r.tenant_id),
    scopeType: String(r.scope_type) === "tenant" ? "tenant" : "space",
    scopeId: String(r.scope_id),
    downloadTokenExpiresInSec: Number(r.download_token_expires_in_sec),
    downloadTokenMaxUses: Number(r.download_token_max_uses),
    watermarkHeadersEnabled: Boolean(r.watermark_headers_enabled),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export function defaultArtifactPolicy(params: { tenantId: string; scopeType: "tenant" | "space"; scopeId: string }): ArtifactPolicy {
  return {
    tenantId: params.tenantId,
    scopeType: params.scopeType,
    scopeId: params.scopeId,
    downloadTokenExpiresInSec: 300,
    downloadTokenMaxUses: 1,
    watermarkHeadersEnabled: true,
    updatedAt: new Date(0).toISOString(),
  };
}

export async function getArtifactPolicy(params: { pool: Pool; tenantId: string; scopeType: "tenant" | "space"; scopeId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM artifact_policies
      WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3
      LIMIT 1
    `,
    [params.tenantId, params.scopeType, params.scopeId],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

export async function getEffectiveArtifactPolicy(params: { pool: Pool; tenantId: string; spaceId?: string | null }) {
  if (params.spaceId) {
    const space = await getArtifactPolicy({ pool: params.pool, tenantId: params.tenantId, scopeType: "space", scopeId: params.spaceId });
    if (space) return space;
  }
  const tenant = await getArtifactPolicy({ pool: params.pool, tenantId: params.tenantId, scopeType: "tenant", scopeId: params.tenantId });
  return tenant;
}

export async function upsertArtifactPolicy(params: {
  pool: Pool;
  tenantId: string;
  scopeType: "tenant" | "space";
  scopeId: string;
  downloadTokenExpiresInSec: number;
  downloadTokenMaxUses: number;
  watermarkHeadersEnabled: boolean;
}) {
  await params.pool.query(
    `
      INSERT INTO artifact_policies (
        tenant_id, scope_type, scope_id,
        download_token_expires_in_sec, download_token_max_uses, watermark_headers_enabled
      )
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (tenant_id, scope_type, scope_id) DO UPDATE
      SET download_token_expires_in_sec = EXCLUDED.download_token_expires_in_sec,
          download_token_max_uses = EXCLUDED.download_token_max_uses,
          watermark_headers_enabled = EXCLUDED.watermark_headers_enabled,
          updated_at = now()
    `,
    [
      params.tenantId,
      params.scopeType,
      params.scopeId,
      Math.max(1, Math.min(3600, Math.floor(params.downloadTokenExpiresInSec))),
      Math.max(1, Math.min(10, Math.floor(params.downloadTokenMaxUses))),
      Boolean(params.watermarkHeadersEnabled),
    ],
  );
  return { ok: true as const };
}

