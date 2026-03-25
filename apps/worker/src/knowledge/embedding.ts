import crypto from "node:crypto";
import type { Pool } from "pg";
import { attachDlpSummary, normalizeAuditErrorCategory, redactValue } from "@openslin/shared";
import { createVectorStore, resolveVectorStoreConfigFromEnv } from "./vectorStore";

function sha256Hex(text: string) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function stableStringifyValue(v: any): any {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(stableStringifyValue);
  const keys = Object.keys(v).sort();
  const out: any = {};
  for (const k of keys) out[k] = stableStringifyValue(v[k]);
  return out;
}

function stableStringify(v: any): string {
  return JSON.stringify(stableStringifyValue(v));
}

function computeEventHash(params: { prevHash: string | null; normalized: any }) {
  const input = stableStringify({ prevHash: params.prevHash ?? null, event: params.normalized });
  return sha256Hex(input);
}

async function writeAudit(pool: Pool, params: { traceId: string; tenantId: string; spaceId: string; action: string; inputDigest?: any; outputDigest?: any; errorCategory?: string }) {
  const errorCategory = normalizeAuditErrorCategory(params.errorCategory);
  const redactedIn = redactValue(params.inputDigest);
  const redactedOut = redactValue(params.outputDigest);
  const outputDigest = attachDlpSummary(redactedOut.value, redactedOut.summary);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [params.tenantId]);
    const prevRes = await client.query(
      "SELECT event_hash, timestamp FROM audit_events WHERE tenant_id = $1 AND event_hash IS NOT NULL ORDER BY timestamp DESC, event_id DESC LIMIT 1",
      [params.tenantId],
    );
    const prevHash = prevRes.rowCount ? (prevRes.rows[0].event_hash as string | null) : null;
    const prevTs = prevRes.rowCount ? (prevRes.rows[0].timestamp as any) : null;
    const prevMs = prevTs ? new Date(prevTs).getTime() : NaN;
    const ts = new Date(Math.max(Date.now(), Number.isFinite(prevMs) ? prevMs + 1 : 0)).toISOString();
    const normalized = {
      timestamp: ts,
      subjectId: "system",
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      resourceType: "knowledge",
      action: params.action,
      toolRef: null,
      workflowRef: null,
      result: errorCategory ? "error" : "success",
      traceId: params.traceId,
      requestId: null,
      runId: null,
      stepId: null,
      idempotencyKey: null,
      errorCategory,
      latencyMs: null,
      policyDecision: null,
      inputDigest: redactedIn.value ?? null,
      outputDigest: outputDigest ?? null,
    };
    const eventHash = computeEventHash({ prevHash, normalized });

    await client.query(
      `
        INSERT INTO audit_events (
          timestamp, subject_id, tenant_id, space_id, resource_type, action,
          policy_decision, input_digest, output_digest, idempotency_key,
          result, trace_id, request_id, run_id, step_id, error_category, latency_ms,
          prev_hash, event_hash
        ) VALUES (
          $1,$2,$3,$4,$5,$6,
          $7,$8,$9,$10,
          $11,$12,$13,$14,$15,$16,$17,
          $18,$19
        )
      `,
      [
        ts,
        "system",
        params.tenantId,
        params.spaceId,
        "knowledge",
        params.action,
        null,
        redactedIn.value ?? null,
        outputDigest ?? null,
        null,
        errorCategory ? "error" : "success",
        params.traceId,
        null,
        null,
        null,
        errorCategory,
        null,
        prevHash,
        eventHash,
      ],
    );
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
    }
    throw err;
  } finally {
    client.release();
  }
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

export async function processKnowledgeEmbeddingJob(params: { pool: Pool; embeddingJobId: string }) {
  const jobRes = await params.pool.query("SELECT * FROM knowledge_embedding_jobs WHERE id = $1 LIMIT 1", [params.embeddingJobId]);
  if (!jobRes.rowCount) throw new Error("embedding_job_not_found");
  const job = jobRes.rows[0] as any;
  const tenantId = String(job.tenant_id ?? "");
  const spaceId = String(job.space_id ?? "");
  const documentId = String(job.document_id ?? "");
  const documentVersion = Number(job.document_version ?? 0);
  const modelRef = String(job.embedding_model_ref ?? "");
  const traceId = `kemb-${params.embeddingJobId}`;

  if (!tenantId || !spaceId || !documentId || !documentVersion || !modelRef) throw new Error("embedding_job_invalid");
  await params.pool.query("UPDATE knowledge_embedding_jobs SET status='running', attempt=attempt+1, updated_at=now() WHERE id=$1", [params.embeddingJobId]);

  const startedAt = Date.now();
  try {
    const chunksRes = await params.pool.query(
      `
        SELECT id, snippet
        FROM knowledge_chunks
        WHERE tenant_id=$1 AND space_id=$2 AND document_id=$3 AND document_version=$4
        ORDER BY chunk_index ASC
        LIMIT 5000
      `,
      [tenantId, spaceId, documentId, documentVersion],
    );
    const chunks = chunksRes.rows as any[];
    const k = 16;
    let updated = 0;
    const nowIso = new Date().toISOString();
    const embeddings: any[] = [];
    for (const c of chunks) {
      const id = String(c.id ?? "");
      const snippet = String(c.snippet ?? "");
      if (!id) continue;
      const minhash = computeMinhash(snippet, k);
      await params.pool.query(
        "UPDATE knowledge_chunks SET embedding_model_ref=$2, embedding_minhash=$3, embedding_updated_at=now() WHERE id=$1 AND tenant_id=$4 AND space_id=$5",
        [id, modelRef, minhash, tenantId, spaceId],
      );
      embeddings.push({ chunkId: id, documentId, documentVersion, embeddingModelRef: modelRef, vector: minhash, updatedAt: nowIso });
      updated++;
    }

    const vectorStore = createVectorStore(resolveVectorStoreConfigFromEnv());
    const upsertRes = await vectorStore.upsertEmbeddings({ pool: params.pool, embeddings });

    await params.pool.query("UPDATE knowledge_embedding_jobs SET status='succeeded', last_error=NULL, updated_at=now() WHERE id=$1", [params.embeddingJobId]);
    const latencyMs = Date.now() - startedAt;
    await writeAudit(params.pool, {
      traceId,
      tenantId,
      spaceId,
      action: "embed",
      inputDigest: { embeddingJobId: params.embeddingJobId, documentId, version: documentVersion, modelRef },
      outputDigest: { chunkCount: chunks.length, updatedCount: updated, latencyMs, vectorStoreRef: vectorStore.ref, vectorStoreUpsert: upsertRes },
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    await params.pool.query("UPDATE knowledge_embedding_jobs SET status='failed', last_error=$2, updated_at=now() WHERE id=$1", [params.embeddingJobId, msg]);
    await writeAudit(params.pool, {
      traceId,
      tenantId,
      spaceId,
      action: "embed",
      inputDigest: { embeddingJobId: params.embeddingJobId, documentId, version: documentVersion, modelRef },
      outputDigest: { error: msg },
      errorCategory: "retryable",
    });
    throw e;
  }
}
