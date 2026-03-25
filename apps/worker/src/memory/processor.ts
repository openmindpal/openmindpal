import crypto from "node:crypto";
import type { Pool } from "pg";
import { redactValue } from "@openslin/shared";

function sha256(text: string) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/* ── Minhash 语义向量工具（与 knowledge 层 / memory-manager minhash:16@1 对齐）── */

const MINHASH_K = 16;
const MINHASH_MODEL_REF = "minhash:16@1";

function tokenize(text: string) {
  const out: string[] = [];
  const s = text.toLowerCase();
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const code = ch.charCodeAt(0);
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

function minhashOverlapScore(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let hit = 0;
  for (const v of a) if (setB.has(v)) hit++;
  return a.length ? hit / a.length : 0;
}

export async function memoryWrite(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  input: any;
}) {
  const scope = params.input?.scope === "space" ? "space" : "user";
  const type = String(params.input?.type ?? "other");
  const title = params.input?.title ? String(params.input.title) : null;
  const contentTextRaw = String(params.input?.contentText ?? "");
  const writePolicy = String(params.input?.writePolicy ?? "confirmed");
  const priority = typeof params.input?.priority === "number" && Number.isFinite(params.input.priority) ? Math.max(0, Math.min(100, params.input.priority)) : null;
  const confidence = typeof params.input?.confidence === "number" && Number.isFinite(params.input.confidence) ? Math.max(0, Math.min(1, params.input.confidence)) : null;
  const retentionDays = typeof params.input?.retentionDays === "number" && Number.isFinite(params.input.retentionDays) ? params.input.retentionDays : null;
  const expiresAt = retentionDays ? new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString() : null;

  const redacted = redactValue(contentTextRaw);
  const contentText = String(redacted.value ?? "");
  const digest = sha256(contentText);

  const ownerSubjectId = scope === "user" ? params.subjectId : null;

  // 计算 minhash 向量
  const embeddingInput = (title ? `${title} ` : "") + contentText;
  const minhash = computeMinhash(embeddingInput);

  const mergeThreshold = typeof params.input?.mergeThreshold === "number" && Number.isFinite(params.input.mergeThreshold) ? Math.max(0.6, Math.min(0.95, params.input.mergeThreshold)) : 0.86;
  const mergeLimit = typeof params.input?.mergeCandidateLimit === "number" && Number.isFinite(params.input.mergeCandidateLimit) ? Math.max(5, Math.min(200, Math.floor(params.input.mergeCandidateLimit))) : 50;

  try {
    const where: string[] = ["tenant_id = $1", "space_id = $2", "deleted_at IS NULL", "scope = $3", "type = $4"];
    const args: any[] = [params.tenantId, params.spaceId, scope, type];
    let idx = 5;
    if (scope === "user") {
      where.push(`owner_subject_id = $${idx++}`);
      args.push(params.subjectId);
    }
    const candRes = await params.pool.query(
      `
        SELECT id, embedding_minhash
        FROM memory_entries
        WHERE ${where.join(" AND ")}
        ORDER BY updated_at DESC
        LIMIT $${idx}
      `,
      [...args, mergeLimit],
    );
    let bestId: string | null = null;
    let bestScore = 0;
    for (const r of candRes.rows as any[]) {
      const mh = Array.isArray(r.embedding_minhash) ? (r.embedding_minhash as number[]) : [];
      const score = minhashOverlapScore(minhash, mh);
      if (score > bestScore) {
        bestScore = score;
        bestId = String(r.id);
      }
    }
    if (bestId && bestScore >= mergeThreshold) {
      const src = {
        kind: "tool",
        tool: "memory.write",
        merged: { into: bestId, score: Number(bestScore.toFixed(4)) },
        ...(priority !== null ? { priority } : {}),
        ...(confidence !== null ? { confidence } : {}),
      };
      await params.pool.query(
        `
          UPDATE memory_entries
          SET title = $3,
              content_text = $4,
              content_digest = $5,
              retention_days = $6,
              expires_at = $7,
              write_policy = $8,
              source_ref = COALESCE(source_ref, '{}'::jsonb) || $9::jsonb,
              embedding_model_ref = $10,
              embedding_minhash = $11,
              embedding_updated_at = now(),
              updated_at = now()
          WHERE id = $1 AND tenant_id = $2
          RETURNING id, scope, type, title, created_at
        `,
        [bestId, params.tenantId, title, contentText, digest, retentionDays, expiresAt, writePolicy, JSON.stringify(src), MINHASH_MODEL_REF, minhash],
      );
      return { entry: { id: bestId, scope, type, title, createdAt: new Date().toISOString() }, dlpSummary: redacted.summary };
    }
  } catch {}

  const res = await params.pool.query(
    `
      INSERT INTO memory_entries (
        tenant_id, space_id, owner_subject_id, scope, type, title,
        content_text, content_digest, retention_days, expires_at, write_policy, source_ref,
        embedding_model_ref, embedding_minhash, embedding_updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
      RETURNING id, scope, type, title, created_at
    `,
    [
      params.tenantId,
      params.spaceId,
      ownerSubjectId,
      scope,
      type,
      title,
      contentText,
      digest,
      retentionDays,
      expiresAt,
      writePolicy,
      JSON.stringify({ kind: "tool", tool: "memory.write", ...(priority !== null ? { priority } : {}), ...(confidence !== null ? { confidence } : {}) }),
      MINHASH_MODEL_REF,
      minhash,
    ],
  );
  const row = res.rows[0] as any;
  return { entry: { id: row.id, scope: row.scope, type: row.type, title: row.title, createdAt: row.created_at }, dlpSummary: redacted.summary };
}

export async function memoryRead(params: { pool: Pool; tenantId: string; spaceId: string; subjectId: string; input: any }) {
  const scope = params.input?.scope === "space" ? "space" : params.input?.scope === "user" ? "user" : null;
  const query = String(params.input?.query ?? "");
  const limit = typeof params.input?.limit === "number" && Number.isFinite(params.input.limit) ? Math.max(1, Math.min(20, params.input.limit)) : 5;
  const types = Array.isArray(params.input?.types) ? params.input.types.map((t: any) => String(t)).slice(0, 20) : null;

  if (!query) return { evidence: [], candidateCount: 0 };

  const baseWhere: string[] = ["tenant_id = $1", "space_id = $2", "deleted_at IS NULL", "(expires_at IS NULL OR expires_at > now())"];
  const baseArgs: any[] = [params.tenantId, params.spaceId];
  let idx = 3;

  if (scope) {
    baseWhere.push(`scope = $${idx++}`);
    baseArgs.push(scope);
    if (scope === "user") {
      baseWhere.push(`owner_subject_id = $${idx++}`);
      baseArgs.push(params.subjectId);
    }
  }

  if (types?.length) {
    baseWhere.push(`type = ANY($${idx++}::text[])`);
    baseArgs.push(types);
  }

  const scopeWhereClause = baseWhere.join(" AND ");
  const scopeArgs = [...baseArgs];
  const scopeNextIdx = idx;

  // Stage 1: Lexical (ILIKE)
  const lexLimit = Math.max(limit, limit * 3);
  const lexIdx = scopeNextIdx;
  const lexRes = await params.pool.query(
    `
      SELECT id, scope, type, title, content_text, created_at, embedding_minhash, 'lexical' AS _stage
      FROM memory_entries
      WHERE ${scopeWhereClause}
        AND (content_text ILIKE $${lexIdx} OR COALESCE(title,'') ILIKE $${lexIdx})
      ORDER BY created_at DESC
      LIMIT $${lexIdx + 1}
    `,
    [...scopeArgs, `%${query}%`, lexLimit],
  );

  // Stage 2: Semantic (minhash overlap)
  const qMinhash = computeMinhash(query);
  const vecLimit = Math.max(limit, limit * 3);
  let vecRows: any[] = [];
  try {
    const vecIdx = scopeNextIdx;
    const vecRes = await params.pool.query(
      `
        SELECT id, scope, type, title, content_text, created_at, embedding_minhash, 'vector' AS _stage
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
    // 向量通道降级
  }

  // Merge + Dedup
  const seen = new Map<string, any>();
  for (const r of lexRes.rows as any[]) {
    const id = String(r.id);
    if (!seen.has(id)) seen.set(id, { ...r, _stage: "lexical" });
  }
  for (const r of vecRows) {
    const id = String(r.id);
    if (!seen.has(id)) seen.set(id, { ...r, _stage: "vector" });
    else {
      const existing = seen.get(id)!;
      existing._stage = "both";
      existing.embedding_minhash = existing.embedding_minhash ?? r.embedding_minhash;
    }
  }

  // Rerank
  const candidates = Array.from(seen.values());
  const queryLower = query.toLowerCase();
  const nowMs = Date.now();

  const scored = candidates.map((c) => {
    const text = String(c.content_text ?? "").toLowerCase();
    const title = String(c.title ?? "").toLowerCase();
    const sLex = (text.includes(queryLower) || title.includes(queryLower)) ? 1 : 0;

    const mh = Array.isArray(c.embedding_minhash) ? (c.embedding_minhash as number[]) : [];
    const sVec = minhashOverlapScore(qMinhash, mh);

    const createdAtMs = Date.parse(String(c.created_at ?? ""));
    const ageMs = Number.isFinite(createdAtMs) ? Math.max(0, nowMs - createdAtMs) : 0;
    const recencyBoost = 1 / (1 + ageMs / (24 * 60 * 60 * 1000));
    const bothBonus = c._stage === "both" ? 0.1 : 0;

    const src = c.source_ref && typeof c.source_ref === "object" ? c.source_ref : null;
    const priority = src && typeof src.priority === "number" && Number.isFinite(src.priority) ? Math.max(0, Math.min(100, src.priority)) : 0;
    const writePolicy = String(c.write_policy ?? "");
    const conf0 = src && typeof src.confidence === "number" && Number.isFinite(src.confidence) ? Math.max(0, Math.min(1, src.confidence)) : null;
    const confidence = conf0 !== null ? conf0 : writePolicy === "confirmed" ? 1 : 0.6;
    const priorityBoost = (priority / 100) * 0.08;
    const trustBoost = confidence * 0.06;
    const decay = Math.exp(-ageMs / (30 * 24 * 60 * 60 * 1000));
    const score = (sLex * 1.2 + sVec + recencyBoost * 0.05 + bothBonus + priorityBoost + trustBoost) * decay;
    return { ...c, _score: score };
  });

  scored.sort((a, b) => (b._score as number) - (a._score as number));
  const topRows = scored.slice(0, limit);

  const evidence = topRows.map((r: any) => {
    const snippetRaw = (r.title ? `${r.title}\n` : "") + String(r.content_text ?? "");
    const clipped = snippetRaw.slice(0, 280);
    const redacted = redactValue(clipped);
    return {
      id: r.id,
      type: r.type,
      scope: r.scope,
      title: r.title,
      snippet: String(redacted.value ?? ""),
      createdAt: r.created_at,
    };
  });

  return { evidence, candidateCount: evidence.length };
}
