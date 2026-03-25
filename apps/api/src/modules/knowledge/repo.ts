import crypto from "node:crypto";
import type { Pool } from "pg";

export function sha256(text: string) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function tokenize(text: string) {
  const out: string[] = [];
  const s = text.toLowerCase();
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const ok = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_" || ch === "-";
    if (ok) buf += ch;
    else {
      if (buf.length >= 2) out.push(buf);
      buf = "";
    }
    if (out.length >= 256) break;
  }
  if (buf.length >= 2) out.push(buf);
  return out;
}

function hash32(str: string) {
  const h = crypto.createHash("sha256").update(str, "utf8").digest();
  return h.readInt32BE(0);
}

function computeMinhash(text: string, k: number) {
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

export type KnowledgeDocumentRow = {
  id: string;
  tenantId: string;
  spaceId: string;
  version: number;
  title: string;
  sourceType: string;
  tags: any;
  contentDigest: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeIndexJobRow = {
  id: string;
  tenantId: string;
  spaceId: string;
  documentId: string;
  documentVersion: number;
  status: string;
  attempt: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

function toDoc(r: any): KnowledgeDocumentRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    version: r.version,
    title: r.title,
    sourceType: r.source_type,
    tags: r.tags,
    contentDigest: r.content_digest,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toJob(r: any): KnowledgeIndexJobRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    documentId: r.document_id,
    documentVersion: r.document_version,
    status: r.status,
    attempt: r.attempt,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function createDocument(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  title: string;
  sourceType: string;
  tags?: any;
  contentText: string;
  visibility?: "space" | "subject";
  ownerSubjectId?: string | null;
}) {
  const digest = sha256(params.contentText);
  const res = await params.pool.query(
    `
      INSERT INTO knowledge_documents (tenant_id, space_id, version, title, source_type, tags, content_text, content_digest, status, visibility, owner_subject_id)
      VALUES ($1, $2, 1, $3, $4, $5, $6, $7, 'active', $8, $9)
      RETURNING id, tenant_id, space_id, version, title, source_type, tags, content_digest, status, created_at, updated_at
    `,
    [
      params.tenantId,
      params.spaceId,
      params.title,
      params.sourceType,
      params.tags ?? null,
      params.contentText,
      digest,
      params.visibility ?? "space",
      params.ownerSubjectId ?? null,
    ],
  );
  return toDoc(res.rows[0]);
}

export async function getDocumentContent(pool: Pool, tenantId: string, spaceId: string, documentId: string) {
  const res = await pool.query(
    `
      SELECT id, tenant_id, space_id, version, title, source_type, tags, content_text, content_digest, status, created_at, updated_at
      FROM knowledge_documents
      WHERE tenant_id = $1 AND space_id = $2 AND id = $3
      LIMIT 1
    `,
    [tenantId, spaceId, documentId],
  );
  if (!res.rowCount) return null;
  return res.rows[0] as any;
}

export async function createIndexJob(params: { pool: Pool; tenantId: string; spaceId: string; documentId: string; documentVersion: number }) {
  const res = await params.pool.query(
    `
      INSERT INTO knowledge_index_jobs (tenant_id, space_id, document_id, document_version, status)
      VALUES ($1, $2, $3, $4, 'queued')
      RETURNING *
    `,
    [params.tenantId, params.spaceId, params.documentId, params.documentVersion],
  );
  return toJob(res.rows[0]);
}

export async function setIndexJobRunning(pool: Pool, id: string) {
  const res = await pool.query(
    `
      UPDATE knowledge_index_jobs
      SET status = 'running', attempt = attempt + 1, updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [id],
  );
  if (!res.rowCount) return null;
  return toJob(res.rows[0]);
}

export async function setIndexJobSucceeded(pool: Pool, id: string) {
  await pool.query("UPDATE knowledge_index_jobs SET status = 'succeeded', last_error = NULL, updated_at = now() WHERE id = $1", [id]);
}

export async function setIndexJobFailed(pool: Pool, id: string, msg: string) {
  await pool.query("UPDATE knowledge_index_jobs SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1", [id, msg]);
}

export async function insertChunks(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  documentId: string;
  documentVersion: number;
  chunks: Array<{ chunkIndex: number; startOffset: number; endOffset: number; snippet: string; contentDigest: string }>;
}) {
  const values: any[] = [];
  const rowsSql: string[] = [];
  for (let i = 0; i < params.chunks.length; i++) {
    const c = params.chunks[i]!;
    const base = i * 8;
    rowsSql.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`);
    values.push(
      params.tenantId,
      params.spaceId,
      params.documentId,
      params.documentVersion,
      c.chunkIndex,
      c.startOffset,
      c.endOffset,
      JSON.stringify({ snippet: c.snippet, digest: c.contentDigest }),
    );
  }

  if (!rowsSql.length) return 0;
  const sql = `
    INSERT INTO knowledge_chunks (
      tenant_id, space_id, document_id, document_version, chunk_index, start_offset, end_offset, snippet, content_digest
    )
    SELECT v.tenant_id, v.space_id, v.document_id, v.document_version, v.chunk_index, v.start_offset, v.end_offset,
           (v.meta->>'snippet')::text, (v.meta->>'digest')::text
    FROM (
      VALUES ${rowsSql.join(",")}
    ) AS v(tenant_id, space_id, document_id, document_version, chunk_index, start_offset, end_offset, meta)
    ON CONFLICT (tenant_id, space_id, document_id, document_version, chunk_index) DO NOTHING
  `;
  const res = await params.pool.query(sql, values);
  return res.rowCount ?? 0;
}

export async function searchChunks(params: { pool: Pool; tenantId: string; spaceId: string; subjectId: string; query: string; limit: number }) {
  const res = await params.pool.query(
    `
      SELECT
        id, document_id, document_version, chunk_index, start_offset, end_offset, snippet, created_at,
        POSITION(lower($3) IN lower(snippet)) AS match_pos
      FROM knowledge_chunks
      WHERE tenant_id = $1 AND space_id = $2 AND snippet ILIKE ('%' || $3 || '%')
        AND EXISTS (
          SELECT 1
          FROM knowledge_documents d
          WHERE d.tenant_id = knowledge_chunks.tenant_id
            AND d.space_id = knowledge_chunks.space_id
            AND d.id = knowledge_chunks.document_id
            AND d.version = knowledge_chunks.document_version
            AND (
              d.visibility = 'space'
              OR (d.visibility = 'subject' AND d.owner_subject_id = $4)
            )
        )
      ORDER BY match_pos ASC NULLS LAST, created_at DESC
      LIMIT $5
    `,
    [params.tenantId, params.spaceId, params.query, params.subjectId, params.limit],
  );
  return res.rows as any[];
}

export async function searchChunksHybrid(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  query: string;
  limit: number;
  lexicalLimit?: number;
  embedLimit?: number;
}) {
  const k = 16;
  const qMinhash = computeMinhash(params.query, k);
  const lexicalLimit = Math.max(0, Math.min(500, params.lexicalLimit ?? 80));
  const embedLimit = Math.max(0, Math.min(500, params.embedLimit ?? 120));

  const startedAt = Date.now();
  const lexRes = await params.pool.query(
    `
      SELECT
        id, document_id, document_version, chunk_index, start_offset, end_offset, snippet, created_at,
        POSITION(lower($3) IN lower(snippet)) AS match_pos,
        embedding_minhash
      FROM knowledge_chunks
      WHERE tenant_id = $1 AND space_id = $2 AND snippet ILIKE ('%' || $3 || '%')
        AND EXISTS (
          SELECT 1
          FROM knowledge_documents d
          WHERE d.tenant_id = knowledge_chunks.tenant_id
            AND d.space_id = knowledge_chunks.space_id
            AND d.id = knowledge_chunks.document_id
            AND d.version = knowledge_chunks.document_version
            AND (
              d.visibility = 'space'
              OR (d.visibility = 'subject' AND d.owner_subject_id = $4)
            )
        )
      ORDER BY match_pos ASC NULLS LAST, created_at DESC
      LIMIT $5
    `,
    [params.tenantId, params.spaceId, params.query, params.subjectId, lexicalLimit],
  );
  const embRes = await params.pool.query(
    `
      SELECT
        id, document_id, document_version, chunk_index, start_offset, end_offset, snippet, created_at,
        NULL::int AS match_pos,
        embedding_minhash
      FROM knowledge_chunks
      WHERE tenant_id = $1 AND space_id = $2
        AND embedding_minhash && $3::int[]
        AND EXISTS (
          SELECT 1
          FROM knowledge_documents d
          WHERE d.tenant_id = knowledge_chunks.tenant_id
            AND d.space_id = knowledge_chunks.space_id
            AND d.id = knowledge_chunks.document_id
            AND d.version = knowledge_chunks.document_version
            AND (
              d.visibility = 'space'
              OR (d.visibility = 'subject' AND d.owner_subject_id = $4)
            )
        )
      ORDER BY embedding_updated_at DESC NULLS LAST, created_at DESC
      LIMIT $5
    `,
    [params.tenantId, params.spaceId, qMinhash, params.subjectId, embedLimit],
  );

  const byId = new Map<string, any>();
  for (const r of lexRes.rows as any[]) byId.set(String(r.id), { ...r, _stage: "lex" });
  for (const r of embRes.rows as any[]) if (!byId.has(String(r.id))) byId.set(String(r.id), { ...r, _stage: "emb" });
  const candidates = Array.from(byId.values());

  const qLower = params.query.toLowerCase();
  function overlapScore(mh: any) {
    const arr = Array.isArray(mh) ? (mh as number[]) : [];
    if (!arr.length) return 0;
    let hit = 0;
    const set = new Set(qMinhash);
    for (const v of arr) if (set.has(Number(v))) hit++;
    return hit / k;
  }
  function lexScore(snippet: string) {
    const pos = snippet.toLowerCase().indexOf(qLower);
    if (pos < 0) return 0;
    return 1 / (1 + pos);
  }

  const scored = candidates
    .map((c) => {
      const snippet = String(c.snippet ?? "");
      const sLex = lexScore(snippet);
      const sEmb = overlapScore(c.embedding_minhash);
      const score = sLex * 1.2 + sEmb;
      return { ...c, _score: score, _sLex: sLex, _sEmb: sEmb };
    })
    .sort((a, b) => (b._score as number) - (a._score as number))
    .slice(0, params.limit);

  const latencyMs = Date.now() - startedAt;
  const stageStats = {
    lexical: { returned: lexRes.rowCount, limit: lexicalLimit },
    embedding: { returned: embRes.rowCount, limit: embedLimit, k },
    merged: { candidateCount: candidates.length },
    rerank: { returned: scored.length },
    latencyMs,
  };
  const rankPolicy = "hybrid_minhash_rerank_v1";

  const hits = scored.map((h) => ({
    ...h,
    rank_reason: { kind: rankPolicy, stage: h._stage, sLex: Number(h._sLex.toFixed(4)), sEmb: Number(h._sEmb.toFixed(4)) },
  }));
  return { rankPolicy, stageStats, queryMinhashK: k, hits };
}

export async function createRetrievalLog(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  queryDigest: any;
  filtersDigest: any;
  candidateCount: number;
  citedRefs: any;
  rankPolicy?: string | null;
  stageStats?: any;
  rankedEvidenceRefs?: any;
  returnedCount?: number | null;
  degraded?: boolean;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO knowledge_retrieval_logs (
        tenant_id, space_id, query_digest, filters_digest, candidate_count, cited_refs,
        rank_policy, stage_stats, ranked_evidence_refs, returned_count, degraded
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::jsonb, $10, $11)
      RETURNING id
    `,
    [
      params.tenantId,
      params.spaceId,
      params.queryDigest,
      params.filtersDigest,
      params.candidateCount,
      JSON.stringify(params.citedRefs ?? []),
      params.rankPolicy ?? null,
      params.stageStats ? JSON.stringify(params.stageStats) : null,
      params.rankedEvidenceRefs ? JSON.stringify(params.rankedEvidenceRefs) : null,
      params.returnedCount ?? null,
      Boolean(params.degraded ?? false),
    ],
  );
  return res.rows[0]!.id as string;
}

export type KnowledgeRetrievalLogRow = {
  id: string;
  tenantId: string;
  spaceId: string;
  queryDigest: any;
  filtersDigest: any;
  candidateCount: number;
  citedRefs: any;
  rankPolicy: string | null;
  stageStats: any | null;
  rankedEvidenceRefs: any | null;
  returnedCount: number | null;
  degraded: boolean;
  createdAt: string;
};

export async function listRetrievalLogs(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  limit: number;
  offset: number;
  rankPolicy?: string;
  degraded?: boolean;
  runId?: string;
  source?: string;
}) {
  const args: any[] = [params.tenantId, params.spaceId];
  let idx = 3;
  const where: string[] = ["tenant_id = $1", "space_id = $2"];
  if (params.rankPolicy) {
    where.push(`rank_policy = $${idx++}`);
    args.push(params.rankPolicy);
  }
  if (params.degraded != null) {
    where.push(`degraded = $${idx++}`);
    args.push(Boolean(params.degraded));
  }
  if (params.runId) {
    where.push(`(filters_digest->>'runId') = $${idx++}`);
    args.push(params.runId);
  }
  if (params.source) {
    where.push(`(filters_digest->>'source') = $${idx++}`);
    args.push(params.source);
  }
  where.push(`true`);
  args.push(params.limit);
  args.push(params.offset);
  const res = await params.pool.query(
    `
      SELECT
        id, tenant_id, space_id, query_digest, filters_digest, candidate_count, cited_refs,
        rank_policy, stage_stats, ranked_evidence_refs, returned_count, degraded, created_at
      FROM knowledge_retrieval_logs
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `,
    args,
  );
  return (res.rows as any[]).map(
    (r): KnowledgeRetrievalLogRow => ({
      id: r.id,
      tenantId: r.tenant_id,
      spaceId: r.space_id,
      queryDigest: r.query_digest,
      filtersDigest: r.filters_digest,
      candidateCount: Number(r.candidate_count),
      citedRefs: r.cited_refs,
      rankPolicy: r.rank_policy ?? null,
      stageStats: r.stage_stats ?? null,
      rankedEvidenceRefs: r.ranked_evidence_refs ?? null,
      returnedCount: r.returned_count != null ? Number(r.returned_count) : null,
      degraded: Boolean(r.degraded),
      createdAt: r.created_at,
    }),
  );
}

export async function getRetrievalLog(params: { pool: Pool; tenantId: string; spaceId: string; id: string }) {
  const res = await params.pool.query(
    `
      SELECT
        id, tenant_id, space_id, query_digest, filters_digest, candidate_count, cited_refs,
        rank_policy, stage_stats, ranked_evidence_refs, returned_count, degraded, created_at
      FROM knowledge_retrieval_logs
      WHERE tenant_id = $1 AND space_id = $2 AND id = $3
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, params.id],
  );
  if (!res.rowCount) return null;
  const r: any = res.rows[0];
  const out: KnowledgeRetrievalLogRow = {
    id: r.id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    queryDigest: r.query_digest,
    filtersDigest: r.filters_digest,
    candidateCount: Number(r.candidate_count),
    citedRefs: r.cited_refs,
    rankPolicy: r.rank_policy ?? null,
    stageStats: r.stage_stats ?? null,
    rankedEvidenceRefs: r.ranked_evidence_refs ?? null,
    returnedCount: r.returned_count != null ? Number(r.returned_count) : null,
    degraded: Boolean(r.degraded),
    createdAt: r.created_at,
  };
  return out;
}

export type KnowledgeIngestJobRow = {
  id: string;
  tenantId: string;
  spaceId: string;
  provider: string;
  workspaceId: string;
  eventId: string;
  sourceEventPk: string | null;
  status: string;
  attempt: number;
  lastError: string | null;
  documentId: string | null;
  documentVersion: number | null;
  createdAt: string;
  updatedAt: string;
};

export async function listIngestJobs(params: { pool: Pool; tenantId: string; spaceId: string; status?: string; limit: number; offset: number }) {
  const args: any[] = [params.tenantId, params.spaceId];
  let idx = 3;
  const where: string[] = ["tenant_id = $1", "space_id = $2"];
  if (params.status) {
    where.push(`status = $${idx++}`);
    args.push(params.status);
  }
  args.push(params.limit);
  args.push(params.offset);
  const res = await params.pool.query(
    `
      SELECT *
      FROM knowledge_ingest_jobs
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `,
    args,
  );
  return (res.rows as any[]).map(
    (r): KnowledgeIngestJobRow => ({
      id: r.id,
      tenantId: r.tenant_id,
      spaceId: r.space_id,
      provider: r.provider,
      workspaceId: r.workspace_id,
      eventId: r.event_id,
      sourceEventPk: r.source_event_pk ?? null,
      status: r.status,
      attempt: Number(r.attempt),
      lastError: r.last_error ?? null,
      documentId: r.document_id ?? null,
      documentVersion: r.document_version != null ? Number(r.document_version) : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }),
  );
}

export async function getIngestJob(params: { pool: Pool; tenantId: string; spaceId: string; id: string }) {
  const res = await params.pool.query(`SELECT * FROM knowledge_ingest_jobs WHERE tenant_id = $1 AND space_id = $2 AND id = $3 LIMIT 1`, [
    params.tenantId,
    params.spaceId,
    params.id,
  ]);
  if (!res.rowCount) return null;
  const r: any = res.rows[0];
  const out: KnowledgeIngestJobRow = {
    id: r.id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    provider: r.provider,
    workspaceId: r.workspace_id,
    eventId: r.event_id,
    sourceEventPk: r.source_event_pk ?? null,
    status: r.status,
    attempt: Number(r.attempt),
    lastError: r.last_error ?? null,
    documentId: r.document_id ?? null,
    documentVersion: r.document_version != null ? Number(r.document_version) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  return out;
}

export type KnowledgeEmbeddingJobRow = {
  id: string;
  tenantId: string;
  spaceId: string;
  documentId: string;
  documentVersion: number;
  embeddingModelRef: string;
  status: string;
  attempt: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function listEmbeddingJobs(params: { pool: Pool; tenantId: string; spaceId: string; status?: string; limit: number; offset: number }) {
  const args: any[] = [params.tenantId, params.spaceId];
  let idx = 3;
  const where: string[] = ["tenant_id = $1", "space_id = $2"];
  if (params.status) {
    where.push(`status = $${idx++}`);
    args.push(params.status);
  }
  args.push(params.limit);
  args.push(params.offset);
  const res = await params.pool.query(
    `
      SELECT *
      FROM knowledge_embedding_jobs
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `,
    args,
  );
  return (res.rows as any[]).map(
    (r): KnowledgeEmbeddingJobRow => ({
      id: r.id,
      tenantId: r.tenant_id,
      spaceId: r.space_id,
      documentId: r.document_id,
      documentVersion: Number(r.document_version),
      embeddingModelRef: r.embedding_model_ref,
      status: r.status,
      attempt: Number(r.attempt),
      lastError: r.last_error ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }),
  );
}

export async function getEmbeddingJob(params: { pool: Pool; tenantId: string; spaceId: string; id: string }) {
  const res = await params.pool.query(`SELECT * FROM knowledge_embedding_jobs WHERE tenant_id = $1 AND space_id = $2 AND id = $3 LIMIT 1`, [
    params.tenantId,
    params.spaceId,
    params.id,
  ]);
  if (!res.rowCount) return null;
  const r: any = res.rows[0];
  const out: KnowledgeEmbeddingJobRow = {
    id: r.id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    documentId: r.document_id,
    documentVersion: Number(r.document_version),
    embeddingModelRef: r.embedding_model_ref,
    status: r.status,
    attempt: Number(r.attempt),
    lastError: r.last_error ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  return out;
}

export async function listIndexJobs(params: { pool: Pool; tenantId: string; spaceId: string; status?: string; limit: number; offset: number }) {
  const args: any[] = [params.tenantId, params.spaceId];
  let idx = 3;
  const where: string[] = ["tenant_id = $1", "space_id = $2"];
  if (params.status) {
    where.push(`status = $${idx++}`);
    args.push(params.status);
  }
  args.push(params.limit);
  args.push(params.offset);
  const res = await params.pool.query(
    `
      SELECT *
      FROM knowledge_index_jobs
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `,
    args,
  );
  return (res.rows as any[]).map((r) => toJob(r));
}

export async function getIndexJob(params: { pool: Pool; tenantId: string; spaceId: string; id: string }) {
  const res = await params.pool.query(`SELECT * FROM knowledge_index_jobs WHERE tenant_id = $1 AND space_id = $2 AND id = $3 LIMIT 1`, [
    params.tenantId,
    params.spaceId,
    params.id,
  ]);
  if (!res.rowCount) return null;
  return toJob(res.rows[0]);
}

export async function resolveEvidenceRef(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  sourceRef: { documentId: string; version: number; chunkId: string };
}) {
  const res = await params.pool.query(
    `
      SELECT
        c.id AS chunk_id,
        c.document_id,
        c.document_version,
        c.chunk_index,
        c.start_offset,
        c.end_offset,
        c.snippet,
        d.title AS document_title,
        d.source_type AS document_source_type
      FROM knowledge_chunks c
      JOIN knowledge_documents d
        ON d.tenant_id = c.tenant_id
        AND d.space_id = c.space_id
        AND d.id = c.document_id
        AND d.version = c.document_version
      WHERE c.tenant_id = $1
        AND c.space_id = $2
        AND c.id = $3
        AND c.document_id = $4
        AND c.document_version = $5
        AND (
          d.visibility = 'space'
          OR (d.visibility = 'subject' AND d.owner_subject_id = $6)
        )
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, params.sourceRef.chunkId, params.sourceRef.documentId, params.sourceRef.version, params.subjectId],
  );
  if (!res.rowCount) return null;
  return res.rows[0] as any;
}
