import type { Pool } from "pg";

export type EvidenceRetentionPolicyRow = {
  tenantId: string;
  spaceId: string;
  allowSnippet: boolean;
  retentionDays: number;
  maxSnippetLen: number;
};

export async function getEvidenceRetentionPolicy(params: { pool: Pool; tenantId: string; spaceId: string }): Promise<EvidenceRetentionPolicyRow> {
  const res = await params.pool.query(
    `
      SELECT tenant_id, space_id, allow_snippet, retention_days, max_snippet_len
      FROM knowledge_evidence_retention_policies
      WHERE tenant_id = $1 AND space_id = $2
      LIMIT 1
    `,
    [params.tenantId, params.spaceId],
  );
  if (!res.rowCount) {
    return { tenantId: params.tenantId, spaceId: params.spaceId, allowSnippet: true, retentionDays: 30, maxSnippetLen: 600 };
  }
  const r: any = res.rows[0];
  return {
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    allowSnippet: Boolean(r.allow_snippet),
    retentionDays: Number(r.retention_days ?? 30),
    maxSnippetLen: Number(r.max_snippet_len ?? 600),
  };
}

export async function upsertEvidenceRetentionPolicy(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  allowSnippet: boolean;
  retentionDays: number;
  maxSnippetLen: number;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO knowledge_evidence_retention_policies (tenant_id, space_id, allow_snippet, retention_days, max_snippet_len, updated_at)
      VALUES ($1, $2, $3, $4, $5, now())
      ON CONFLICT (tenant_id, space_id)
      DO UPDATE SET allow_snippet = EXCLUDED.allow_snippet, retention_days = EXCLUDED.retention_days, max_snippet_len = EXCLUDED.max_snippet_len, updated_at = now()
      RETURNING tenant_id, space_id, allow_snippet, retention_days, max_snippet_len
    `,
    [params.tenantId, params.spaceId, Boolean(params.allowSnippet), Math.max(1, Math.round(params.retentionDays)), Math.max(50, Math.round(params.maxSnippetLen))],
  );
  return res.rows[0] as any;
}

export async function insertEvidenceAccessEvent(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string | null;
  retrievalLogId: string | null;
  documentId: string | null;
  documentVersion: number | null;
  chunkId: string | null;
  allowed: boolean;
  reason: string | null;
}) {
  await params.pool.query(
    `
      INSERT INTO knowledge_evidence_access_events
        (tenant_id, space_id, subject_id, retrieval_log_id, document_id, document_version, chunk_id, allowed, reason)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    [
      params.tenantId,
      params.spaceId,
      params.subjectId,
      params.retrievalLogId,
      params.documentId,
      params.documentVersion,
      params.chunkId,
      Boolean(params.allowed),
      params.reason,
    ],
  );
}

