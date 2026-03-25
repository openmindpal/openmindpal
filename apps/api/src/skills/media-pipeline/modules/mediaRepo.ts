import type { Pool } from "pg";
import crypto from "node:crypto";

export type MediaObjectRow = {
  mediaId: string;
  tenantId: string;
  spaceId: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  status: string;
  storageProvider: string | null;
  storageKey: string | null;
  source: any;
  provenance: any;
  safetyDigest: any;
  watermark: any;
  copyright: any;
  traceability: any;
  createdBySubjectId: string | null;
  createdAt: string;
  updatedAt: string;
};

function toMediaObject(r: any): MediaObjectRow {
  return {
    mediaId: r.media_id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    contentType: r.content_type,
    byteSize: Number(r.byte_size),
    sha256: r.sha256,
    status: r.status,
    storageProvider: r.storage_provider ?? null,
    storageKey: r.storage_key ?? null,
    source: r.source ?? null,
    provenance: r.provenance ?? null,
    safetyDigest: r.safety_digest ?? null,
    watermark: r.watermark ?? null,
    copyright: r.copyright ?? null,
    traceability: r.traceability ?? null,
    createdBySubjectId: r.created_by_subject_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function sha256Hex(bytes: Buffer) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export async function createMediaObject(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  contentType: string;
  contentBytes?: Buffer | null;
  storageProvider?: string | null;
  storageKey?: string | null;
  byteSize?: number | null;
  sha256?: string | null;
  source?: any;
  provenance?: any;
  safetyDigest?: any;
  watermark?: any;
  copyright?: any;
  traceability?: any;
  createdBySubjectId?: string | null;
}) {
  const bytes = params.contentBytes ?? null;
  const sha256 = params.sha256 ?? (bytes ? sha256Hex(bytes) : null);
  const byteSize = params.byteSize ?? (bytes ? bytes.length : null);
  if (!sha256 || !byteSize) throw new Error("media_bytes_or_ref_required");
  const res = await params.pool.query(
    `
      INSERT INTO media_objects (
        tenant_id, space_id, content_type, byte_size, sha256, status,
        storage_provider, storage_key,
        source, provenance, safety_digest, watermark, copyright, traceability,
        content_bytes, created_by_subject_id
      )
      VALUES ($1,$2,$3,$4,$5,'uploaded',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
    `,
    [
      params.tenantId,
      params.spaceId,
      params.contentType,
      byteSize,
      sha256,
      params.storageProvider ?? null,
      params.storageKey ?? null,
      params.source ?? null,
      params.provenance ?? null,
      params.safetyDigest ?? null,
      params.watermark ? JSON.stringify(params.watermark) : null,
      params.copyright ? JSON.stringify(params.copyright) : null,
      params.traceability ? JSON.stringify(params.traceability) : null,
      bytes,
      params.createdBySubjectId ?? null,
    ],
  );
  return toMediaObject(res.rows[0]);
}

export async function getMediaObject(params: { pool: Pool; tenantId: string; mediaId: string }) {
  const res = await params.pool.query("SELECT * FROM media_objects WHERE tenant_id = $1 AND media_id = $2 LIMIT 1", [
    params.tenantId,
    params.mediaId,
  ]);
  if (!res.rowCount) return null;
  return toMediaObject(res.rows[0]);
}

export async function getMediaContent(params: { pool: Pool; tenantId: string; mediaId: string }) {
  const res = await params.pool.query(
    "SELECT media_id, tenant_id, space_id, content_type, byte_size, sha256, status, storage_provider, storage_key, content_bytes FROM media_objects WHERE tenant_id = $1 AND media_id = $2 LIMIT 1",
    [params.tenantId, params.mediaId],
  );
  if (!res.rowCount) return null;
  const r = res.rows[0] as any;
  return {
    mediaId: r.media_id as string,
    tenantId: r.tenant_id as string,
    spaceId: r.space_id as string,
    contentType: r.content_type as string,
    byteSize: Number(r.byte_size),
    sha256: r.sha256 as string,
    status: r.status as string,
    storageProvider: (r.storage_provider as string | null) ?? null,
    storageKey: (r.storage_key as string | null) ?? null,
    contentBytes: (r.content_bytes as Buffer | null) ?? null,
  };
}
