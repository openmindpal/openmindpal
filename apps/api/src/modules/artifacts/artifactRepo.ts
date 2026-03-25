import type { Pool } from "pg";

export type ArtifactRow = {
  artifactId: string;
  tenantId: string;
  spaceId: string;
  type: string;
  format: string;
  contentType: string;
  byteSize: number;
  source: any;
  runId: string | null;
  stepId: string | null;
  createdBySubjectId: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function toArtifact(r: any): ArtifactRow {
  return {
    artifactId: r.artifact_id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    type: r.type,
    format: r.format,
    contentType: r.content_type,
    byteSize: r.byte_size,
    source: r.source,
    runId: r.run_id ?? null,
    stepId: r.step_id ?? null,
    createdBySubjectId: r.created_by_subject_id ?? null,
    expiresAt: r.expires_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function createArtifact(params: {
  pool: Pool;
  artifactId?: string;
  tenantId: string;
  spaceId: string;
  type: string;
  format: string;
  contentType: string;
  contentText: string;
  source?: any;
  runId?: string | null;
  stepId?: string | null;
  createdBySubjectId?: string | null;
  expiresAt?: string | null;
}) {
  const byteSize = Buffer.byteLength(params.contentText ?? "", "utf8");
  const res = params.artifactId
    ? await params.pool.query(
        `
          INSERT INTO artifacts (artifact_id, tenant_id, space_id, type, format, content_type, byte_size, content_text, source, run_id, step_id, created_by_subject_id, expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          RETURNING *
        `,
        [
          params.artifactId,
          params.tenantId,
          params.spaceId,
          params.type,
          params.format,
          params.contentType,
          byteSize,
          params.contentText,
          params.source ?? null,
          params.runId ?? null,
          params.stepId ?? null,
          params.createdBySubjectId ?? null,
          params.expiresAt ?? null,
        ],
      )
    : await params.pool.query(
        `
          INSERT INTO artifacts (tenant_id, space_id, type, format, content_type, byte_size, content_text, source, run_id, step_id, created_by_subject_id, expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          RETURNING *
        `,
        [
          params.tenantId,
          params.spaceId,
          params.type,
          params.format,
          params.contentType,
          byteSize,
          params.contentText,
          params.source ?? null,
          params.runId ?? null,
          params.stepId ?? null,
          params.createdBySubjectId ?? null,
          params.expiresAt ?? null,
        ],
      );
  return toArtifact(res.rows[0]);
}

export async function getArtifact(pool: Pool, tenantId: string, artifactId: string) {
  const res = await pool.query("SELECT * FROM artifacts WHERE tenant_id = $1 AND artifact_id = $2 LIMIT 1", [tenantId, artifactId]);
  if (!res.rowCount) return null;
  return toArtifact(res.rows[0]);
}

export async function getArtifactContent(pool: Pool, tenantId: string, artifactId: string) {
  const res = await pool.query(
    "SELECT artifact_id, tenant_id, space_id, type, format, content_type, content_text, run_id, step_id, expires_at FROM artifacts WHERE tenant_id = $1 AND artifact_id = $2 LIMIT 1",
    [tenantId, artifactId],
  );
  if (!res.rowCount) return null;
  const r = res.rows[0] as any;
  return {
    artifactId: r.artifact_id as string,
    tenantId: r.tenant_id as string,
    spaceId: r.space_id as string,
    type: String(r.type ?? "unknown"),
    format: String(r.format ?? "jsonl"),
    contentType: r.content_type as string,
    contentText: r.content_text as string,
    runId: (r.run_id as string | null) ?? null,
    stepId: (r.step_id as string | null) ?? null,
    expiresAt: (r.expires_at as string | null) ?? null,
  };
}

export async function listArtifactsByType(params: { pool: Pool; tenantId: string; spaceId: string; type: string; limit?: number }) {
  const limit = Math.max(1, Math.min(200, params.limit ?? 50));
  const res = await params.pool.query(
    `
      SELECT *
      FROM artifacts
      WHERE tenant_id = $1 AND space_id = $2 AND type = $3
      ORDER BY created_at DESC
      LIMIT $4
    `,
    [params.tenantId, params.spaceId, params.type, limit],
  );
  return res.rows.map(toArtifact);
}
