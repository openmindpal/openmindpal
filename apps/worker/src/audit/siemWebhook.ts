import crypto from "node:crypto";
import type { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";
import { normalizeAuditErrorCategory } from "@openslin/shared";
import { decryptSecretPayload } from "../secrets/envelope";

function computeBackoffMs(base: number, attemptCount: number) {
  const b = Math.max(0, Number(base) || 0);
  const exp = Math.max(0, attemptCount - 1);
  const ms = b * Math.pow(2, exp);
  return Math.min(ms, 60_000);
}

function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function normalizeAllowedDomains(v: any) {
  const arr = Array.isArray(v) ? v : [];
  return arr
    .map((x) => (typeof x === "string" ? x.trim().toLowerCase() : ""))
    .filter((x) => Boolean(x));
}

function getAllowedDomains(params: { connectorEgressPolicy: any; typeDefaultEgressPolicy: any }) {
  const p = params.connectorEgressPolicy ?? params.typeDefaultEgressPolicy ?? {};
  const a = Array.isArray(p.allowedDomains) ? p.allowedDomains : [];
  return normalizeAllowedDomains(a);
}

async function insertAuditEvent(params: {
  pool: Pool;
  tenantId: string;
  resourceType: string;
  action: string;
  inputDigest?: any;
  outputDigest?: any;
  result: "success" | "denied" | "error";
  traceId: string;
  errorCategory?: string | null;
  latencyMs?: number;
}) {
  const errorCategory = normalizeAuditErrorCategory(params.errorCategory);
  await params.pool.query(
    `
      INSERT INTO audit_events (
        subject_id, tenant_id, space_id, resource_type, action,
        input_digest, output_digest, result, trace_id, error_category, latency_ms
      )
      VALUES (NULL,$1,NULL,$2,$3,$4,$5,$6,$7,$8,$9)
    `,
    [
      params.tenantId,
      params.resourceType,
      params.action,
      params.inputDigest ?? null,
      params.outputDigest ?? null,
      params.result,
      params.traceId,
      errorCategory,
      params.latencyMs ?? null,
    ],
  );
}

async function listEnabledDestinations(params: { pool: Pool; limit: number }) {
  const res = await params.pool.query(
    `
      SELECT id, tenant_id, secret_id, batch_size, timeout_ms
      FROM audit_siem_destinations
      WHERE enabled = true
      ORDER BY created_at ASC
      LIMIT $1
    `,
    [params.limit],
  );
  return res.rows.map((r) => ({
    id: String(r.id),
    tenantId: String(r.tenant_id),
    secretId: String(r.secret_id),
    batchSize: Number(r.batch_size ?? 200),
    timeoutMs: Number(r.timeout_ms ?? 5000),
  }));
}

async function getCursor(params: { pool: Pool; tenantId: string; destinationId: string }) {
  const res = await params.pool.query(
    `SELECT last_ts, last_event_id FROM audit_siem_cursors WHERE tenant_id = $1 AND destination_id = $2 LIMIT 1`,
    [params.tenantId, params.destinationId],
  );
  if (!res.rowCount) return { lastTs: null as string | null, lastEventId: null as string | null };
  return {
    lastTs: res.rows[0].last_ts ? new Date(res.rows[0].last_ts).toISOString() : null,
    lastEventId: res.rows[0].last_event_id ? String(res.rows[0].last_event_id) : null,
  };
}

async function setCursor(params: { pool: Pool; tenantId: string; destinationId: string; lastTs: string | null; lastEventId: string | null }) {
  await params.pool.query(
    `
      INSERT INTO audit_siem_cursors (tenant_id, destination_id, last_ts, last_event_id)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (tenant_id, destination_id) DO UPDATE
      SET last_ts = EXCLUDED.last_ts,
          last_event_id = EXCLUDED.last_event_id,
          updated_at = now()
    `,
    [params.tenantId, params.destinationId, params.lastTs, params.lastEventId],
  );
}

async function loadWebhookConfig(params: { pool: Pool; tenantId: string; secretId: string; masterKey: string }) {
  const res = await params.pool.query(
    `
      SELECT
        s.id,
        s.tenant_id,
        s.scope_type,
        s.scope_id,
        s.connector_instance_id,
        s.status,
        s.key_version,
        s.enc_format,
        s.encrypted_payload,
        i.egress_policy,
        t.default_egress_policy
      FROM secret_records s
      JOIN connector_instances i ON i.id = s.connector_instance_id AND i.tenant_id = s.tenant_id
      JOIN connector_types t ON t.name = i.type_name
      WHERE s.tenant_id = $1 AND s.id = $2
      LIMIT 1
    `,
    [params.tenantId, params.secretId],
  );
  if (!res.rowCount) throw new Error("secret_not_found");
  const r = res.rows[0] as any;
  if (String(r.status) !== "active") throw new Error("secret_not_active");
  const decrypted = await decryptSecretPayload({
    pool: params.pool,
    tenantId: params.tenantId,
    masterKey: params.masterKey,
    scopeType: String(r.scope_type),
    scopeId: String(r.scope_id),
    keyVersion: Number(r.key_version),
    encFormat: String(r.enc_format ?? "legacy.a256gcm"),
    encryptedPayload: r.encrypted_payload,
  });
  const obj = decrypted && typeof decrypted === "object" ? (decrypted as Record<string, unknown>) : {};
  const webhookUrl = typeof obj.webhookUrl === "string" ? obj.webhookUrl : "";
  if (!webhookUrl) throw new Error("secret_payload_missing_webhook_url");
  const allowedDomains = getAllowedDomains({ connectorEgressPolicy: r.egress_policy, typeDefaultEgressPolicy: r.default_egress_policy });
  return { webhookUrl, allowedDomains };
}

function toAuditEventPayload(row: any) {
  return {
    eventId: String(row.event_id),
    timestamp: new Date(row.timestamp).toISOString(),
    subjectId: row.subject_id ?? null,
    tenantId: row.tenant_id ?? null,
    spaceId: row.space_id ?? null,
    resourceType: row.resource_type,
    action: row.action,
    toolRef: row.tool_ref ?? null,
    workflowRef: row.workflow_ref ?? null,
    result: row.result,
    traceId: row.trace_id,
    requestId: row.request_id ?? null,
    runId: row.run_id ?? null,
    stepId: row.step_id ?? null,
    idempotencyKey: row.idempotency_key ?? null,
    errorCategory: row.error_category ?? null,
    latencyMs: row.latency_ms ?? null,
    policyDecision: row.policy_decision ?? null,
    inputDigest: row.input_digest ?? null,
    outputDigest: row.output_digest ?? null,
    prevHash: row.prev_hash ?? null,
    eventHash: row.event_hash ?? null,
  };
}

async function enqueueFromCursor(params: { pool: Pool; dest: { id: string; tenantId: string; batchSize: number } }) {
  const cursor = await getCursor({ pool: params.pool, tenantId: params.dest.tenantId, destinationId: params.dest.id });
  const where: string[] = ["tenant_id = $1"];
  const args: any[] = [params.dest.tenantId];
  if (cursor.lastTs && cursor.lastEventId) {
    args.push(cursor.lastTs, cursor.lastEventId);
    where.push(`(timestamp > $2::timestamptz OR (timestamp = $2::timestamptz AND event_id > $3::uuid))`);
  } else if (cursor.lastTs) {
    args.push(cursor.lastTs);
    where.push(`timestamp > $2::timestamptz`);
  }
  args.push(Math.min(Math.max(1, params.dest.batchSize), 1000));
  const res = await params.pool.query(
    `
      SELECT *
      FROM audit_events
      WHERE ${where.join(" AND ")}
      ORDER BY timestamp ASC, event_id ASC
      LIMIT $${args.length}
    `,
    args,
  );
  if (!res.rowCount) return { enqueued: 0 };

  const rows = res.rows as any[];
  for (const r of rows) {
    const payload = toAuditEventPayload(r);
    await params.pool.query(
      `
        INSERT INTO audit_siem_outbox (tenant_id, destination_id, event_id, event_ts, payload)
        VALUES ($1,$2,$3,$4,$5::jsonb)
        ON CONFLICT (tenant_id, destination_id, event_id) DO NOTHING
      `,
      [params.dest.tenantId, params.dest.id, String(r.event_id), r.timestamp, JSON.stringify(payload)],
    );
  }

  const last = rows[rows.length - 1];
  await setCursor({
    pool: params.pool,
    tenantId: params.dest.tenantId,
    destinationId: params.dest.id,
    lastTs: new Date(last.timestamp).toISOString(),
    lastEventId: String(last.event_id),
  });
  return { enqueued: rows.length };
}

async function claimBatch(params: { pool: Pool; tenantId: string; destinationId: string; limit: number }) {
  const tx = await params.pool.connect();
  try {
    await tx.query("BEGIN");
    const res = await tx.query(
      `
        SELECT *
        FROM audit_siem_outbox
        WHERE tenant_id = $1 AND destination_id = $2 AND next_attempt_at <= now()
        ORDER BY event_ts ASC, event_id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $3
      `,
      [params.tenantId, params.destinationId, params.limit],
    );
    if (!res.rowCount) {
      await tx.query("COMMIT");
      return [];
    }
    const ids = res.rows.map((r: any) => String(r.id));
    await tx.query(
      `
        UPDATE audit_siem_outbox
        SET attempts = attempts + 1, updated_at = now()
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])
      `,
      [params.tenantId, ids],
    );
    await tx.query("COMMIT");
    return res.rows as any[];
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}

async function markSuccess(params: { pool: Pool; tenantId: string; outboxIds: string[] }) {
  await params.pool.query(`DELETE FROM audit_siem_outbox WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [params.tenantId, params.outboxIds]);
}

async function markFailure(params: { pool: Pool; tenantId: string; rows: any[]; maxAttempts: number; backoffMsBase: number; err: any }) {
  const msg = String(params.err?.message ?? "unknown");
  const digest = { message: msg, messageLen: msg.length, sha256_8: sha256Hex(msg).slice(0, 8) };
  for (const r of params.rows) {
    const attempts = Number(r.attempts ?? 0) + 1;
    const willDeadletter = attempts >= params.maxAttempts;
    if (willDeadletter) {
      await params.pool.query(
        `
          INSERT INTO audit_siem_dlq (tenant_id, destination_id, event_id, event_ts, payload, attempts, last_error_digest)
          VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb)
        `,
        [params.tenantId, String(r.destination_id), String(r.event_id), r.event_ts, JSON.stringify(r.payload), attempts, JSON.stringify(digest)],
      );
      await params.pool.query(`DELETE FROM audit_siem_outbox WHERE tenant_id = $1 AND id = $2`, [params.tenantId, String(r.id)]);
      continue;
    }
    const backoffMs = computeBackoffMs(params.backoffMsBase, attempts);
    await params.pool.query(
      `
        UPDATE audit_siem_outbox
        SET last_error_digest = $3::jsonb,
            next_attempt_at = now() + ($4 || ' milliseconds')::interval,
            updated_at = now()
        WHERE tenant_id = $1 AND id = $2
      `,
      [params.tenantId, String(r.id), JSON.stringify(digest), backoffMs],
    );
  }
  return { digest };
}

async function deliverBatch(params: { pool: Pool; masterKey: string; dest: { id: string; tenantId: string; secretId: string; batchSize: number; timeoutMs: number } }) {
  const rows = await claimBatch({ pool: params.pool, tenantId: params.dest.tenantId, destinationId: params.dest.id, limit: Math.min(Math.max(1, params.dest.batchSize), 1000) });
  if (!rows.length) return { sent: 0 };

  const deliveryId = uuidv4();
  const startedAtMs = Date.now();
  const traceId = uuidv4();
  const inputDigest = { destinationId: params.dest.id, count: rows.length, deliveryId };

  try {
    const cfg = await loadWebhookConfig({ pool: params.pool, tenantId: params.dest.tenantId, secretId: params.dest.secretId, masterKey: params.masterKey });
    const url = new URL(cfg.webhookUrl);
    const host = url.hostname.toLowerCase();
    const allowed = cfg.allowedDomains.includes(host);
    const egressPolicySnapshot = { allowedDomains: cfg.allowedDomains };
    const egressSummaryBase = [{ host, method: "POST" as const, allowed }];

    if (!allowed) {
      const out = await markFailure({
        pool: params.pool,
        tenantId: params.dest.tenantId,
        rows,
        maxAttempts: 1,
        backoffMsBase: 0,
        err: new Error(`policy_violation:egress_denied:${host}`),
      });
      await insertAuditEvent({
        pool: params.pool,
        tenantId: params.dest.tenantId,
        resourceType: "audit",
        action: "siem.delivery",
        inputDigest,
        outputDigest: { status: "failed", error: out.digest, egressPolicySnapshot, egressSummary: egressSummaryBase.map((x) => ({ ...x, errorCategory: "policy_violation" })) },
        result: "error",
        traceId,
        errorCategory: "policy_violation",
        latencyMs: Date.now() - startedAtMs,
      });
      return { sent: 0 };
    }

    const body = rows.map((r) => JSON.stringify(r.payload)).join("\n") + "\n";
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), params.dest.timeoutMs);
    try {
      const res = await fetch(cfg.webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-ndjson",
          "x-audit-tenant-id": params.dest.tenantId,
          "x-audit-delivery-id": deliveryId,
        },
        body,
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`http_${res.status}`);
    } finally {
      clearTimeout(t);
    }

    await markSuccess({ pool: params.pool, tenantId: params.dest.tenantId, outboxIds: rows.map((r) => String(r.id)) });
    const last = rows[rows.length - 1];
    await setCursor({
      pool: params.pool,
      tenantId: params.dest.tenantId,
      destinationId: params.dest.id,
      lastTs: new Date(last.event_ts).toISOString(),
      lastEventId: String(last.event_id),
    });
    await insertAuditEvent({
      pool: params.pool,
      tenantId: params.dest.tenantId,
      resourceType: "audit",
      action: "siem.delivery",
      inputDigest,
      outputDigest: { status: "succeeded", egressPolicySnapshot, egressSummary: egressSummaryBase.map((x) => ({ ...x, status: 200 })) },
      result: "success",
      traceId,
      latencyMs: Date.now() - startedAtMs,
    });
    return { sent: rows.length };
  } catch (e: any) {
    const out = await markFailure({ pool: params.pool, tenantId: params.dest.tenantId, rows, maxAttempts: 8, backoffMsBase: 500, err: e });
    await insertAuditEvent({
      pool: params.pool,
      tenantId: params.dest.tenantId,
      resourceType: "audit",
      action: "siem.delivery",
      inputDigest,
      outputDigest: { status: "failed", error: out.digest },
      result: "error",
      traceId,
      errorCategory: "upstream_error",
      latencyMs: Date.now() - startedAtMs,
    });
    return { sent: 0 };
  }
}

export async function tickAuditSiemWebhookExport(params: { pool: Pool; masterKey: string; destinationsLimit?: number }) {
  const dests = await listEnabledDestinations({ pool: params.pool, limit: params.destinationsLimit ?? 20 });
  for (const d of dests) {
    await enqueueFromCursor({ pool: params.pool, dest: { id: d.id, tenantId: d.tenantId, batchSize: d.batchSize } });
    for (let i = 0; i < 10; i++) {
      const out = await deliverBatch({ pool: params.pool, masterKey: params.masterKey, dest: { id: d.id, tenantId: d.tenantId, secretId: d.secretId, batchSize: d.batchSize, timeoutMs: d.timeoutMs } });
      if (!out.sent) break;
    }
  }
  return { ok: true };
}
