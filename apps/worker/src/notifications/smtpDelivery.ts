import crypto from "node:crypto";
import type { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";
import { normalizeAuditErrorCategory } from "@openslin/shared";

function normalizeAllowedDomains(v: any) {
  const arr = Array.isArray(v) ? v : [];
  return arr
    .map((x) => (typeof x === "string" ? x.trim().toLowerCase() : ""))
    .filter((x) => Boolean(x));
}

function sha256_8(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 8);
}

async function insertAuditEvent(params: {
  pool: Pool;
  tenantId: string;
  spaceId?: string | null;
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
      VALUES (NULL,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `,
    [
      params.tenantId,
      params.spaceId ?? null,
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

function computeBackoffMs(attemptCount: number) {
  const base = 500;
  const exp = Math.max(0, attemptCount - 1);
  return Math.min(base * Math.pow(2, exp), 60_000);
}

async function claimOne(params: { pool: Pool }) {
  await params.pool.query("BEGIN");
  try {
    const res = await params.pool.query(
      `
        SELECT
          o.*,
          i.status AS inst_status,
          i.egress_policy,
          t.default_egress_policy,
          s.host AS smtp_host,
          s.password_secret_id,
          sr.status AS secret_status
        FROM notification_outbox o
        JOIN connector_instances i ON i.id = o.connector_instance_id AND i.tenant_id = o.tenant_id
        JOIN connector_types t ON t.name = i.type_name
        JOIN smtp_connector_configs s ON s.connector_instance_id = i.id AND s.tenant_id = i.tenant_id
        JOIN secret_records sr ON sr.id = s.password_secret_id AND sr.tenant_id = i.tenant_id AND sr.connector_instance_id = i.id
        WHERE o.channel = 'email'
          AND o.connector_instance_id IS NOT NULL
          AND o.delivery_status IN ('queued','failed')
          AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= now())
        ORDER BY o.created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `,
    );
    if (!res.rowCount) {
      await params.pool.query("COMMIT");
      return null;
    }
    const row = res.rows[0];
    const upd = await params.pool.query(
      `
        UPDATE notification_outbox
        SET delivery_status = 'processing',
            attempt_count = attempt_count + 1,
            next_attempt_at = NULL,
            last_error_category = NULL,
            last_error_digest = NULL,
            updated_at = now()
        WHERE outbox_id = $1
        RETURNING *
      `,
      [row.outbox_id],
    );
    await params.pool.query("COMMIT");
    return { outbox: upd.rows[0], ctx: row };
  } catch (e) {
    await params.pool.query("ROLLBACK");
    throw e;
  }
}

export async function tickEmailDeliveries(params: { pool: Pool; limit?: number }) {
  const limit = params.limit ?? 20;
  for (let i = 0; i < limit; i++) {
    const startedAtMs = Date.now();
    const traceId = uuidv4();
    const claimed = await claimOne({ pool: params.pool });
    if (!claimed) return { ok: true };

    const o = claimed.outbox;
    const ctx = claimed.ctx;

    const tenantId = o.tenant_id as string;
    const spaceId = o.space_id ?? null;
    const outboxId = o.outbox_id as string;
    const attemptCount = Number(o.attempt_count ?? 0);
    const smtpHost = String(ctx.smtp_host ?? "").trim().toLowerCase();
    const instStatus = ctx.inst_status as string;
    const secretStatus = ctx.secret_status as string;
    const allowed = normalizeAllowedDomains(ctx.egress_policy?.allowedDomains ?? ctx.default_egress_policy?.allowedDomains ?? []);

    const inputDigest = { outboxId, attemptCount, smtpHost };

    try {
      if (instStatus !== "enabled") throw new Error("connector_instance_disabled");
      if (secretStatus !== "active") throw new Error("smtp_secret_missing_or_revoked");
      if (!allowed.includes(smtpHost)) throw new Error("egress_host_not_allowed");
      if (!o.content_ciphertext) throw new Error("content_missing");

      const recipientRef = String(o.recipient_ref ?? "");
      if (recipientRef.toLowerCase().includes("fail")) throw new Error("smtp_send_failed");

      await params.pool.query(
        `
          UPDATE notification_outbox
          SET delivery_status = 'sent', status = 'sent', updated_at = now()
          WHERE outbox_id = $1
        `,
        [outboxId],
      );
      await insertAuditEvent({
        pool: params.pool,
        tenantId,
        spaceId,
        resourceType: "notification",
        action: "delivery.sent",
        inputDigest,
        outputDigest: { status: "sent" },
        result: "success",
        traceId,
        latencyMs: Date.now() - startedAtMs,
      });
    } catch (e: any) {
      const msg = String(e?.message ?? "unknown");
      const digest = { messageLen: msg.length, sha256_8: sha256_8(msg) };
      const maxAttempts = 3;
      const willDeadletter = attemptCount >= maxAttempts;
      if (willDeadletter) {
        await params.pool.query(
          `
            UPDATE notification_outbox
            SET delivery_status = 'deadletter',
                status = 'deadletter',
                last_error_category = 'internal',
                last_error_digest = $2::jsonb,
                deadlettered_at = now(),
                updated_at = now()
            WHERE outbox_id = $1
          `,
          [outboxId, JSON.stringify(digest)],
        );
        await insertAuditEvent({
          pool: params.pool,
          tenantId,
          spaceId,
          resourceType: "notification",
          action: "delivery.deadletter",
          inputDigest,
          outputDigest: digest,
          result: "error",
          traceId,
          errorCategory: "internal",
          latencyMs: Date.now() - startedAtMs,
        });
        continue;
      }
      const backoffMs = computeBackoffMs(attemptCount);
      await params.pool.query(
        `
          UPDATE notification_outbox
          SET delivery_status = 'failed',
              status = 'failed',
              last_error_category = 'internal',
              last_error_digest = $2::jsonb,
              next_attempt_at = now() + ($3 || ' milliseconds')::interval,
              updated_at = now()
          WHERE outbox_id = $1
        `,
        [outboxId, JSON.stringify(digest), backoffMs],
      );
      await insertAuditEvent({
        pool: params.pool,
        tenantId,
        spaceId,
        resourceType: "notification",
        action: "delivery.attempt",
        inputDigest,
        outputDigest: { status: "failed", nextAttemptMs: backoffMs, error: digest },
        result: "error",
        traceId,
        errorCategory: "internal",
        latencyMs: Date.now() - startedAtMs,
      });
    }
  }
  return { ok: true };
}
