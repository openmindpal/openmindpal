import type { Pool } from "pg";

export type SessionRole = "user" | "assistant" | "system";

export type SessionMessage = {
  role: SessionRole;
  content: string;
  at?: string;
};

export type SessionContext = {
  v: 1;
  messages: SessionMessage[];
};

function toRow(r: any) {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    spaceId: r.space_id as string,
    subjectId: r.subject_id as string,
    sessionId: r.session_id as string,
    context: (r.context_digest ?? null) as any,
    expiresAt: (r.expires_at ?? null) as string | null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export async function getSessionContext(params: { pool: Pool; tenantId: string; spaceId: string; subjectId: string; sessionId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM memory_session_contexts
      WHERE tenant_id = $1
        AND space_id = $2
        AND subject_id = $3
        AND session_id = $4
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, params.subjectId, params.sessionId],
  );
  if (!res.rowCount) return null;
  const row = toRow(res.rows[0]);
  const ctx = row.context && typeof row.context === "object" ? (row.context as SessionContext) : null;
  if (!ctx || ctx.v !== 1 || !Array.isArray(ctx.messages)) return null;
  return { sessionId: row.sessionId, context: ctx, expiresAt: row.expiresAt };
}

export async function upsertSessionContext(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  sessionId: string;
  context: SessionContext;
  expiresAt: string | null;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO memory_session_contexts (tenant_id, space_id, subject_id, session_id, context_digest, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (tenant_id, space_id, subject_id, session_id)
      DO UPDATE SET context_digest = EXCLUDED.context_digest, expires_at = EXCLUDED.expires_at, updated_at = now()
      RETURNING *
    `,
    [params.tenantId, params.spaceId, params.subjectId, params.sessionId, params.context, params.expiresAt],
  );
  return toRow(res.rows[0]);
}

export async function clearSessionContext(params: { pool: Pool; tenantId: string; spaceId: string; subjectId: string; sessionId: string }) {
  const res = await params.pool.query(
    `
      DELETE FROM memory_session_contexts
      WHERE tenant_id = $1 AND space_id = $2 AND subject_id = $3 AND session_id = $4
    `,
    [params.tenantId, params.spaceId, params.subjectId, params.sessionId],
  );
  return (res.rowCount ?? 0) > 0;
}

