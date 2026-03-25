import crypto from "node:crypto";
import type { Pool } from "pg";
import { redactValue } from "@openslin/shared";

/* ── Minhash 语义向量工具（与 knowledge 层 minhash:16@1 对齐）── */

const MINHASH_K = 16;
const MINHASH_MODEL_REF = "minhash:16@1";

function tokenize(text: string) {
  const out: string[] = [];
  const s = text.toLowerCase();
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const code = ch.charCodeAt(0);
    // CJK 统一表意文字区间：每个汉字作为独立 token
    if (code >= 0x4e00 && code <= 0x9fff) {
      if (buf.length >= 2) out.push(buf);
      buf = "";
      out.push(ch);
      if (out.length >= 512) break;
      continue;
    }
    const ok = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_" || ch === "-";
    if (ok) buf += ch;
    else {
      if (buf.length >= 2) out.push(buf);
      buf = "";
    }
    if (out.length >= 512) break;
  }
  if (buf.length >= 2) out.push(buf);
  return out;
}

function hash32(str: string) {
  const h = crypto.createHash("sha256").update(str, "utf8").digest();
  return h.readInt32BE(0);
}

function computeMinhash(text: string, k: number = MINHASH_K): number[] {
  const toks = tokenize(text);
  const mins = new Array<number>(k).fill(2147483647);
  for (const t of toks) {
    for (let i = 0; i < k; i++) {
      const v = hash32(`${i}:${t}`);
      if (v < mins[i]!) mins[i] = v;
    }
  }
  return mins.map((x) => (x === 2147483647 ? 0 : x));
}

/** 计算两个 minhash 向量的 overlap 得分（0~1） */
function minhashOverlapScore(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let hit = 0;
  for (const v of a) if (setB.has(v)) hit++;
  return a.length ? hit / a.length : 0;
}

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

  // 计算 minhash 向量：合并 title + contentText 作为语义输入
  const embeddingInput = (params.title ? `${params.title} ` : "") + contentText;
  const minhash = computeMinhash(embeddingInput);

  const res = await params.pool.query(
    `
      INSERT INTO memory_entries (
        tenant_id, space_id, owner_subject_id, scope, type, title,
        content_text, content_digest, retention_days, expires_at, write_policy, source_ref,
        embedding_model_ref, embedding_minhash, embedding_updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
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
      MINHASH_MODEL_REF,
      minhash,
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

/**
 * 混合检索记忆：lexical(ILIKE) + semantic(minhash overlap) 双通道，加权 rerank。
 * - Stage 1：ILIKE 关键词召回（兼容旧数据与精确匹配场景）
 * - Stage 2：minhash overlap 向量召回（语义近似）
 * - Merge + Rerank：去重合并，按综合得分排序
 * - 失败时静默降级到纯 ILIKE（不阻塞）
 */
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
  const baseWhere: string[] = ["tenant_id = $1", "space_id = $2", "deleted_at IS NULL"];
  baseWhere.push("(expires_at IS NULL OR expires_at > now())");
  const baseArgs: any[] = [params.tenantId, params.spaceId];
  let idx = 3;

  if (params.scope) {
    baseWhere.push(`scope = $${idx++}`);
    baseArgs.push(params.scope);
    if (params.scope === "user") {
      baseWhere.push(`owner_subject_id = $${idx++}`);
      baseArgs.push(params.subjectId);
    }
  }

  if (params.types?.length) {
    baseWhere.push(`type = ANY($${idx++}::text[])`);
    baseArgs.push(params.types);
  }

  const scopeWhereClause = baseWhere.join(" AND ");
  const scopeArgs = [...baseArgs];
  const scopeNextIdx = idx;

  // ── Stage 1: Lexical (ILIKE) 召回 ──
  const lexLimit = Math.max(params.limit, params.limit * 3);
  const lexIdx = scopeNextIdx;
  const lexRes = await params.pool.query(
    `
      SELECT *, 'lexical' AS _stage
      FROM memory_entries
      WHERE ${scopeWhereClause}
        AND (content_text ILIKE $${lexIdx} OR COALESCE(title,'') ILIKE $${lexIdx})
      ORDER BY created_at DESC
      LIMIT $${lexIdx + 1}
    `,
    [...scopeArgs, `%${params.query}%`, lexLimit],
  );

  // ── Stage 2: Semantic (minhash overlap) 召回 ──
  const qMinhash = computeMinhash(params.query);
  const vecLimit = Math.max(params.limit, params.limit * 3);
  let vecRows: any[] = [];
  try {
    const vecIdx = scopeNextIdx;
    const vecRes = await params.pool.query(
      `
        SELECT *, 'vector' AS _stage, embedding_minhash
        FROM memory_entries
        WHERE ${scopeWhereClause}
          AND embedding_minhash IS NOT NULL
          AND embedding_minhash && $${vecIdx}::int[]
        ORDER BY embedding_updated_at DESC NULLS LAST
        LIMIT $${vecIdx + 1}
      `,
      [...scopeArgs, qMinhash, vecLimit],
    );
    vecRows = vecRes.rows as any[];
  } catch {
    // 向量通道失败时静默降级，仅用 lexical 结果
  }

  // ── Merge + Dedup ──
  const seen = new Map<string, any>();
  for (const r of lexRes.rows as any[]) {
    const id = String(r.id);
    if (!seen.has(id)) seen.set(id, { ...r, _stage: "lexical" });
  }
  for (const r of vecRows) {
    const id = String(r.id);
    if (!seen.has(id)) seen.set(id, { ...r, _stage: "vector" });
    else {
      // 同时命中两个通道的，标记为 both
      const existing = seen.get(id)!;
      existing._stage = "both";
      existing.embedding_minhash = existing.embedding_minhash ?? r.embedding_minhash;
    }
  }

  // ── Rerank：lexical_score * 1.2 + vector_score + recency_boost * 0.05 ──
  const candidates = Array.from(seen.values());
  const queryLower = params.query.toLowerCase();
  const nowMs = Date.now();

  const scored = candidates.map((c) => {
    // Lexical score: 1 if matched, 0 otherwise
    const text = String(c.content_text ?? "").toLowerCase();
    const title = String(c.title ?? "").toLowerCase();
    const sLex = (text.includes(queryLower) || title.includes(queryLower)) ? 1 : 0;

    // Vector score: minhash overlap
    const mh = Array.isArray(c.embedding_minhash) ? (c.embedding_minhash as number[]) : [];
    const sVec = minhashOverlapScore(qMinhash, mh);

    // Recency boost: newer = higher
    const createdAtMs = Date.parse(String(c.created_at ?? ""));
    const ageMs = Number.isFinite(createdAtMs) ? Math.max(0, nowMs - createdAtMs) : 0;
    const recencyBoost = 1 / (1 + ageMs / (24 * 60 * 60 * 1000));

    // Both-stage bonus
    const bothBonus = c._stage === "both" ? 0.1 : 0;

    const score = sLex * 1.2 + sVec + recencyBoost * 0.05 + bothBonus;
    return { ...c, _score: score, _sLex: sLex, _sVec: sVec };
  });

  scored.sort((a, b) => (b._score as number) - (a._score as number));
  const topEntries = scored.slice(0, params.limit).map((r) => toEntry(r));

  const evidence = topEntries.map((e) => {
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

  return {
    evidence,
    searchMode: vecRows.length > 0 ? "hybrid" : "lexical_only",
    stageStats: {
      lexical: { returned: lexRes.rowCount ?? 0 },
      vector: { returned: vecRows.length },
      merged: { candidateCount: candidates.length },
      reranked: { returned: evidence.length },
    },
  };
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

/**
 * 查询该空间最近的任务状态（用于编排层记忆召回）。
 * 按 updated_at 倒序，返回最近 N 条任务摘要。
 */
export async function listRecentTaskStates(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  limit: number;
}) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM memory_task_states
      WHERE tenant_id = $1 AND space_id = $2 AND deleted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT $3
    `,
    [params.tenantId, params.spaceId, params.limit],
  );
  return res.rows.map(toTaskState);
}
