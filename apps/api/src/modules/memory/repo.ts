import crypto from "node:crypto";
import type { Pool } from "pg";
import { redactValue } from "@openslin/shared";

export type MemoryEntryRow = {
  id: string;
  tenantId: string;
  spaceId: string;
  ownerSubjectId: string | null;
  scope: "user" | "space";
  type: string;
  title: string | null;
  contentText: string;
  contentDigest: string;
  expiresAt: string | null;
  retentionDays: number | null;
  writePolicy: string;
  sourceRef: any;
  createdAt: string;
  updatedAt: string;
};

export type TaskStateRow = {
  id: string;
  tenantId: string;
  spaceId: string;
  runId: string;
  stepId: string | null;
  phase: string;
  plan: any;
  artifactsDigest: any;
  createdAt: string;
  updatedAt: string;
};

function sha256(text: string) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function toEntry(r: any): MemoryEntryRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    ownerSubjectId: r.owner_subject_id,
    scope: r.scope,
    type: r.type,
    title: r.title,
    contentText: r.content_text,
    contentDigest: r.content_digest,
    expiresAt: r.expires_at,
    retentionDays: r.retention_days,
    writePolicy: r.write_policy,
    sourceRef: r.source_ref,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toTaskState(r: any): TaskStateRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    runId: r.run_id,
    stepId: r.step_id,
    phase: r.phase,
    plan: r.plan,
    artifactsDigest: r.artifacts_digest,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function createMemoryEntry(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  ownerSubjectId: string | null;
  scope: "user" | "space";
  type: string;
  title?: string | null;
  contentText: string;
  retentionDays?: number | null;
  expiresAt?: string | null;
  writePolicy: "confirmed" | "approved" | "policyAllowed";
  sourceRef?: any;
}) {
  const redacted = redactValue(params.contentText);
  const contentText = String(redacted.value ?? "");
  const contentDigest = sha256(contentText);

  const res = await params.pool.query(
    `
      INSERT INTO memory_entries (
        tenant_id, space_id, owner_subject_id, scope, type, title,
        content_text, content_digest, retention_days, expires_at, write_policy, source_ref
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `,
    [
      params.tenantId,
      params.spaceId,
      params.ownerSubjectId,
      params.scope,
      params.type,
      params.title ?? null,
      contentText,
      contentDigest,
      params.retentionDays ?? null,
      params.expiresAt ?? null,
      params.writePolicy,
      params.sourceRef ?? null,
    ],
  );
  return { entry: toEntry(res.rows[0]), dlpSummary: redacted.summary };
}

export async function listMemoryEntries(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  scope?: "user" | "space";
  type?: string;
  limit: number;
  offset: number;
}) {
  const where: string[] = ["tenant_id = $1", "space_id = $2", "deleted_at IS NULL"];
  where.push("(expires_at IS NULL OR expires_at > now())");
  const args: any[] = [params.tenantId, params.spaceId];
  let idx = 3;

  if (params.scope) {
    where.push(`scope = $${idx++}`);
    args.push(params.scope);
    if (params.scope === "user") {
      where.push(`owner_subject_id = $${idx++}`);
      args.push(params.subjectId);
    }
  }

  if (params.type) {
    where.push(`type = $${idx++}`);
    args.push(params.type);
  }

  const res = await params.pool.query(
    `
      SELECT *
      FROM memory_entries
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `,
    [...args, params.limit, params.offset],
  );
  return res.rows.map(toEntry);
}

export async function deleteMemoryEntry(params: { pool: Pool; tenantId: string; spaceId: string; subjectId: string; id: string }) {
  const res = await params.pool.query(
    `
      UPDATE memory_entries
      SET deleted_at = now(), updated_at = now()
      WHERE tenant_id = $1
        AND space_id = $2
        AND id = $3
        AND deleted_at IS NULL
        AND (scope <> 'user' OR owner_subject_id = $4)
      RETURNING id
    `,
    [params.tenantId, params.spaceId, params.id, params.subjectId],
  );
  return Boolean(res.rowCount);
}

export async function clearMemory(params: { pool: Pool; tenantId: string; spaceId: string; subjectId: string; scope: "user" | "space" }) {
  const res = await params.pool.query(
    `
      UPDATE memory_entries
      SET deleted_at = now(), updated_at = now()
      WHERE tenant_id = $1
        AND space_id = $2
        AND deleted_at IS NULL
        AND scope = $3
        AND ($3 <> 'user' OR owner_subject_id = $4)
    `,
    [params.tenantId, params.spaceId, params.scope, params.subjectId],
  );
  return res.rowCount ?? 0;
}

export async function exportAndClearMemory(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  scope: "user" | "space";
  types?: string[];
  limit: number;
}) {
  const limit = Math.max(1, Math.min(5000, params.limit));
  const where: string[] = ["tenant_id = $1", "space_id = $2", "deleted_at IS NULL", "scope = $3", "(expires_at IS NULL OR expires_at > now())"];
  const args: any[] = [params.tenantId, params.spaceId, params.scope];
  let idx = 4;

  if (params.scope === "user") {
    where.push(`owner_subject_id = $${idx++}`);
    args.push(params.subjectId);
  }
  if (params.types?.length) {
    where.push(`type = ANY($${idx++}::text[])`);
    args.push(params.types);
  }
  args.push(limit);

  await params.pool.query("BEGIN");
  try {
    const list = await params.pool.query(
      `
        SELECT *
        FROM memory_entries
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT $${idx++}
      `,
      args,
    );
    const ids = (list.rows as any[]).map((r) => String(r.id ?? "")).filter(Boolean);
    let deletedCount = 0;
    if (ids.length) {
      const del = await params.pool.query(
        `
          UPDATE memory_entries
          SET deleted_at = now(), updated_at = now()
          WHERE tenant_id = $1 AND space_id = $2 AND deleted_at IS NULL AND id = ANY($3::uuid[])
        `,
        [params.tenantId, params.spaceId, ids],
      );
      deletedCount = del.rowCount ?? 0;
    }
    await params.pool.query("COMMIT");

    const entries = (list.rows as any[]).map(toEntry).map((e) => {
      const redactedTitle = e.title ? String(redactValue(e.title).value ?? "") : null;
      const redactedText = String(redactValue(e.contentText).value ?? "");
      return { ...e, title: redactedTitle, contentText: redactedText };
    });
    return { entries, deletedCount };
  } catch (e) {
    await params.pool.query("ROLLBACK");
    throw e;
  }
}

export async function searchMemory(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  query: string;
  scope?: "user" | "space";
  types?: string[];
  limit: number;
}) {
  const where: string[] = ["tenant_id = $1", "space_id = $2", "deleted_at IS NULL"];
  where.push("(expires_at IS NULL OR expires_at > now())");
  const args: any[] = [params.tenantId, params.spaceId];
  let idx = 3;

  if (params.scope) {
    where.push(`scope = $${idx++}`);
    args.push(params.scope);
    if (params.scope === "user") {
      where.push(`owner_subject_id = $${idx++}`);
      args.push(params.subjectId);
    }
  }

  if (params.types?.length) {
    where.push(`type = ANY($${idx++}::text[])`);
    args.push(params.types);
  }

  where.push(`(content_text ILIKE $${idx} OR COALESCE(title,'') ILIKE $${idx})`);
  args.push(`%${params.query}%`);
  idx++;

  const res = await params.pool.query(
    `
      SELECT *
      FROM memory_entries
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${idx++}
    `,
    [...args, params.limit],
  );

  const entries = res.rows.map(toEntry);
  const evidence = entries.map((e) => {
    const snippetRaw = (e.title ? `${e.title}\n` : "") + e.contentText;
    const clipped = snippetRaw.slice(0, 280);
    const redacted = redactValue(clipped);
    return {
      id: e.id,
      type: e.type,
      scope: e.scope,
      title: e.title,
      snippet: String(redacted.value ?? ""),
      createdAt: e.createdAt,
    };
  });

  return { evidence };
}

export async function upsertTaskState(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  runId: string;
  stepId?: string | null;
  phase: string;
  plan?: any;
  artifactsDigest?: any;
}) {
  const redactedPlan = redactValue(params.plan);
  const redactedArtifacts = redactValue(params.artifactsDigest);

  const res = await params.pool.query(
    `
      INSERT INTO memory_task_states (tenant_id, space_id, run_id, step_id, phase, plan, artifacts_digest)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (tenant_id, space_id, run_id)
      WHERE deleted_at IS NULL
      DO UPDATE SET step_id = EXCLUDED.step_id, phase = EXCLUDED.phase, plan = EXCLUDED.plan, artifacts_digest = EXCLUDED.artifacts_digest, updated_at = now()
      RETURNING *
    `,
    [
      params.tenantId,
      params.spaceId,
      params.runId,
      params.stepId ?? null,
      params.phase,
      redactedPlan.value ?? null,
      redactedArtifacts.value ?? null,
    ],
  );
  return { taskState: toTaskState(res.rows[0]), dlpSummary: { plan: redactedPlan.summary, artifacts: redactedArtifacts.summary } };
}

export async function getTaskState(params: { pool: Pool; tenantId: string; spaceId: string; runId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM memory_task_states
      WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND deleted_at IS NULL
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, params.runId],
  );
  if (!res.rowCount) return null;
  return toTaskState(res.rows[0]);
}
