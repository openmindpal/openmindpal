import crypto from "node:crypto";
import type { Pool } from "pg";
import { attachDlpSummary, normalizeAuditErrorCategory, redactValue } from "@openslin/shared";

function sha256(text: string) {
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
  return sha256(input);
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

async function loadMediaText(pool: Pool, tenantId: string, spaceId: string, mediaRef: string) {
  if (!mediaRef.startsWith("media:")) return "";
  const mediaId = mediaRef.slice("media:".length).trim();
  if (!mediaId) return "";
  const res = await pool.query(
    `
      SELECT content_type, byte_size, content_bytes
      FROM media_objects
      WHERE tenant_id = $1 AND space_id = $2 AND media_id = $3
      LIMIT 1
    `,
    [tenantId, spaceId, mediaId],
  );
  if (!res.rowCount) return "";
  const ct = String(res.rows[0].content_type ?? "");
  if (!ct.startsWith("text/")) return "";
  const bytes = res.rows[0].content_bytes as Buffer | null;
  if (!bytes) return "";
  const max = 200_000;
  const sliced = bytes.length > max ? bytes.subarray(0, max) : bytes;
  return sliced.toString("utf8");
}

export async function processKnowledgeIngestJob(params: { pool: Pool; ingestJobId: string }) {
  const jobRes = await params.pool.query("SELECT * FROM knowledge_ingest_jobs WHERE id = $1 LIMIT 1", [params.ingestJobId]);
  if (!jobRes.rowCount) return null;
  const job = jobRes.rows[0] as any;
  const tenantId = String(job.tenant_id ?? "");
  const spaceId = String(job.space_id ?? "");
  const provider = String(job.provider ?? "");
  const workspaceId = String(job.workspace_id ?? "");
  const eventId = String(job.event_id ?? "");
  const sourceEventPk = job.source_event_pk ? String(job.source_event_pk) : null;
  const traceId = `king-${params.ingestJobId}`;

  if (!tenantId || !spaceId || !provider || !workspaceId || !eventId) throw new Error("ingest_job_invalid");
  await params.pool.query("UPDATE knowledge_ingest_jobs SET status='running', attempt=attempt+1, updated_at=now() WHERE id=$1", [params.ingestJobId]);

  const startedAt = Date.now();
  try {
    const evRes = sourceEventPk
      ? await params.pool.query("SELECT id, body_json FROM channel_ingress_events WHERE id = $1 AND tenant_id = $2 LIMIT 1", [sourceEventPk, tenantId])
      : await params.pool.query(
          `
            SELECT id, body_json
            FROM channel_ingress_events
            WHERE tenant_id = $1 AND provider = $2 AND workspace_id = $3 AND event_id = $4
            LIMIT 1
          `,
          [tenantId, provider, workspaceId, eventId],
        );
    if (!evRes.rowCount) throw new Error("source_event_not_found");
    const evPk = String(evRes.rows[0].id ?? "");
    const bodyJson = (evRes.rows[0].body_json as any) ?? null;

    let contentText = "";
    if (bodyJson && typeof bodyJson === "object") {
      const body = (bodyJson as any).body;
      const mediaRef = typeof body?.mediaRef === "string" ? body.mediaRef : "";
      if (mediaRef) contentText = await loadMediaText(params.pool, tenantId, spaceId, mediaRef);
      if (!contentText) {
        const text0 = typeof (bodyJson as any).text === "string" ? String((bodyJson as any).text) : "";
        contentText = text0 || stableStringify(bodyJson);
      }
    } else {
      contentText = String(bodyJson ?? "");
    }
    if (!contentText.trim()) contentText = `provider=${provider} workspace=${workspaceId} event=${eventId}`;

    const title = `${provider}:${eventId}`;
    const contentDigest = sha256(contentText);
    const docRes = await params.pool.query(
      `
        INSERT INTO knowledge_documents (tenant_id, space_id, version, title, source_type, tags, content_text, content_digest, status, visibility, owner_subject_id)
        VALUES ($1,$2,1,$3,$4,$5::jsonb,$6,$7,'active','space',NULL)
        RETURNING id, version
      `,
      [tenantId, spaceId, title, `connector.${provider}`, JSON.stringify({ provider, workspaceId, eventId, sourceEventPk: evPk }), contentText, contentDigest],
    );
    const documentId = String(docRes.rows[0].id);
    const documentVersion = Number(docRes.rows[0].version ?? 1);

    const idxRes = await params.pool.query(
      `
        INSERT INTO knowledge_index_jobs (tenant_id, space_id, document_id, document_version, status)
        VALUES ($1,$2,$3,$4,'queued')
        RETURNING id
      `,
      [tenantId, spaceId, documentId, documentVersion],
    );
    const indexJobId = String(idxRes.rows[0].id);

    await params.pool.query(
      "UPDATE knowledge_ingest_jobs SET status='succeeded', last_error=NULL, source_event_pk=$2, document_id=$3, document_version=$4, updated_at=now() WHERE id=$1",
      [params.ingestJobId, evPk, documentId, documentVersion],
    );

    const latencyMs = Date.now() - startedAt;
    await writeAudit(params.pool, {
      traceId,
      tenantId,
      spaceId,
      action: "ingest_job",
      inputDigest: { ingestJobId: params.ingestJobId, provider, workspaceId, eventId },
      outputDigest: { sourceEventPk: evPk, documentId, documentVersion, indexJobId, contentLen: contentText.length, latencyMs },
    });

    return { tenantId, spaceId, indexJobId };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    await params.pool.query("UPDATE knowledge_ingest_jobs SET status='failed', last_error=$2, updated_at=now() WHERE id=$1", [params.ingestJobId, msg]);
    const code = typeof e?.code === "string" ? e.code : "";
    const permanent = msg === "source_event_not_found" || code === "23503" || msg.includes("violates foreign key constraint");
    await writeAudit(params.pool, {
      traceId,
      tenantId,
      spaceId,
      action: "ingest_job",
      inputDigest: { ingestJobId: params.ingestJobId, provider, workspaceId, eventId },
      outputDigest: { error: msg },
      errorCategory: permanent ? "policy_violation" : "retryable",
    });
    if (permanent) return null;
    throw e;
  }
}
