import type { Pool } from "pg";

export type MediaUploadRow = {
  uploadId: string;
  tenantId: string;
  spaceId: string;
  contentType: string;
  status: string;
  totalBytes: number;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

export type MediaUploadPartRow = {
  uploadId: string;
  partNumber: number;
  storageProvider: string;
  storageKey: string;
  byteSize: number;
  sha256: string;
  createdAt: string;
};

function toUpload(r: any): MediaUploadRow {
  return {
    uploadId: r.upload_id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    contentType: r.content_type,
    status: r.status,
    totalBytes: Number(r.total_bytes),
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function createUpload(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  contentType: string;
  expiresAt: Date;
  createdBySubjectId?: string | null;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO media_uploads (tenant_id, space_id, content_type, status, total_bytes, created_by_subject_id, expires_at)
      VALUES ($1,$2,$3,'open',0,$4,$5)
      RETURNING *
    `,
    [params.tenantId, params.spaceId, params.contentType, params.createdBySubjectId ?? null, params.expiresAt.toISOString()],
  );
  return toUpload(res.rows[0]);
}

export async function getUpload(params: { pool: Pool; tenantId: string; uploadId: string }) {
  const res = await params.pool.query("SELECT * FROM media_uploads WHERE tenant_id = $1 AND upload_id = $2 LIMIT 1", [
    params.tenantId,
    params.uploadId,
  ]);
  if (!res.rowCount) return null;
  return toUpload(res.rows[0]);
}

export async function upsertPart(params: {
  pool: Pool;
  uploadId: string;
  partNumber: number;
  storageProvider: string;
  storageKey: string;
  byteSize: number;
  sha256: string;
}) {
  await params.pool.query(
    `
      INSERT INTO media_upload_parts (upload_id, part_number, storage_provider, storage_key, byte_size, sha256)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (upload_id, part_number)
      DO UPDATE SET storage_provider = EXCLUDED.storage_provider, storage_key = EXCLUDED.storage_key, byte_size = EXCLUDED.byte_size, sha256 = EXCLUDED.sha256
    `,
    [params.uploadId, params.partNumber, params.storageProvider, params.storageKey, params.byteSize, params.sha256],
  );
}

export async function listParts(params: { pool: Pool; uploadId: string }) {
  const res = await params.pool.query(
    "SELECT upload_id, part_number, storage_provider, storage_key, byte_size, sha256, created_at FROM media_upload_parts WHERE upload_id = $1 ORDER BY part_number ASC",
    [params.uploadId],
  );
  return res.rows.map(
    (r: any): MediaUploadPartRow => ({
      uploadId: r.upload_id,
      partNumber: Number(r.part_number),
      storageProvider: r.storage_provider,
      storageKey: r.storage_key,
      byteSize: Number(r.byte_size),
      sha256: r.sha256,
      createdAt: r.created_at,
    }),
  );
}

export async function setUploadStatus(params: { pool: Pool; uploadId: string; status: string; totalBytes?: number | null }) {
  await params.pool.query("UPDATE media_uploads SET status = $2, total_bytes = COALESCE($3, total_bytes), updated_at = now() WHERE upload_id = $1", [
    params.uploadId,
    params.status,
    params.totalBytes ?? null,
  ]);
}

