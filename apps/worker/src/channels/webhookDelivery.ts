import crypto from "node:crypto";
import type { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";
import { normalizeAuditErrorCategory } from "@openslin/shared";
import { callDataPlaneJson } from "../workflow/processor/dataPlaneGateway";

function stable(v: any): any {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(stable);
  const keys = Object.keys(v).sort();
  const out: any = {};
  for (const k of keys) out[k] = stable(v[k]);
  return out;
}

function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function sha256_24(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 24);
}

function channelConversationId(params: { provider: string; workspaceId: string; channelChatId: string; threadId?: string | null }) {
  const input = `${params.provider}|${params.workspaceId}|${params.channelChatId}|${params.threadId ?? ""}`;
  const h = sha256_24(input);
  const p = params.provider.replaceAll(":", "_").replaceAll("/", "_");
  return `ch:${p}:${h}`;
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

function computeBackoffMs(base: number, attemptCount: number) {
  const b = Math.max(0, Number(base) || 0);
  const exp = Math.max(0, attemptCount - 1);
  const ms = b * Math.pow(2, exp);
  return Math.min(ms, 60_000);
}

async function resolveMapping(params: {
  pool: Pool;
  tenantId: string;
  provider: string;
  workspaceId: string;
  channelUserId?: string | null;
  channelChatId?: string | null;
}) {
  if (params.channelUserId) {
    const res = await params.pool.query(
      "SELECT subject_id, space_id FROM channel_accounts WHERE tenant_id = $1 AND provider = $2 AND workspace_id = $3 AND channel_user_id = $4 AND status = 'active' LIMIT 1",
      [params.tenantId, params.provider, params.workspaceId, params.channelUserId],
    );
    if (res.rowCount) {
      const r = res.rows[0] as any;
      const subjectId = String(r.subject_id ?? "");
      const spaceId = r.space_id != null ? String(r.space_id) : null;
      if (subjectId && spaceId) return { subjectId, spaceId, channelChatId: params.channelChatId ?? null };
    }
  }
  if (params.channelChatId) {
    const res = await params.pool.query(
      "SELECT space_id, default_subject_id FROM channel_chat_bindings WHERE tenant_id = $1 AND provider = $2 AND workspace_id = $3 AND channel_chat_id = $4 AND status = 'active' LIMIT 1",
      [params.tenantId, params.provider, params.workspaceId, params.channelChatId],
    );
    if (res.rowCount) {
      const r = res.rows[0] as any;
      const subjectId = r.default_subject_id != null ? String(r.default_subject_id) : "";
      const spaceId = String(r.space_id ?? "");
      if (subjectId && spaceId) return { subjectId, spaceId, channelChatId: params.channelChatId };
    }
  }
  return null;
}

function pickReplyText(locale: string, v: unknown) {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object") return "";
  const o: any = v as any;
  const direct = typeof o[locale] === "string" ? o[locale] : "";
  if (direct) return direct;
  const zh = typeof o["zh-CN"] === "string" ? o["zh-CN"] : "";
  if (zh) return zh;
  const vals = Object.values(o).filter((x) => typeof x === "string") as string[];
  return vals[0] ?? "";
}

async function claimOne(params: { pool: Pool }) {
  await params.pool.query("BEGIN");
  try {
    const res = await params.pool.query(
      `
        SELECT
          e.*,
          c.space_id AS cfg_space_id,
          c.max_attempts AS cfg_max_attempts,
          c.backoff_ms_base AS cfg_backoff_ms_base
        FROM channel_ingress_events e
        JOIN channel_webhook_configs c
          ON c.tenant_id = e.tenant_id AND c.provider = e.provider AND c.workspace_id = e.workspace_id
        WHERE e.status IN ('queued','failed')
          AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= now())
          AND e.attempt_count < c.max_attempts
          AND c.delivery_mode = 'async'
        ORDER BY e.created_at ASC
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
        UPDATE channel_ingress_events
        SET status = 'processing',
            attempt_count = attempt_count + 1,
            next_attempt_at = NULL,
            last_error_category = NULL,
            last_error_digest = NULL,
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [row.id],
    );
    await params.pool.query("COMMIT");
    return { event: upd.rows[0], cfg: { spaceId: row.cfg_space_id ?? null, maxAttempts: Number(row.cfg_max_attempts ?? 8), backoffMsBase: Number(row.cfg_backoff_ms_base ?? 500) } };
  } catch (e) {
    await params.pool.query("ROLLBACK");
    throw e;
  }
}

async function hasMapping(params: { pool: Pool; tenantId: string; provider: string; workspaceId: string; channelUserId?: string | null; channelChatId?: string | null }) {
  if (params.channelUserId) {
    const res = await params.pool.query(
      "SELECT 1 FROM channel_accounts WHERE tenant_id = $1 AND provider = $2 AND workspace_id = $3 AND channel_user_id = $4 AND status = 'active' LIMIT 1",
      [params.tenantId, params.provider, params.workspaceId, params.channelUserId],
    );
    if (res.rowCount) return true;
  }
  if (params.channelChatId) {
    const res = await params.pool.query(
      "SELECT 1 FROM channel_chat_bindings WHERE tenant_id = $1 AND provider = $2 AND workspace_id = $3 AND channel_chat_id = $4 AND status = 'active' LIMIT 1",
      [params.tenantId, params.provider, params.workspaceId, params.channelChatId],
    );
    if (res.rowCount) return true;
  }
  return false;
}

export async function tickWebhookDeliveries(params: { pool: Pool; limit?: number }) {
  const limit = params.limit ?? 20;
  for (let i = 0; i < limit; i++) {
    const startedAtMs = Date.now();
    const traceId = uuidv4();
    const claimed = await claimOne({ pool: params.pool });
    if (!claimed) return { ok: true };

    const e = claimed.event;
    const cfg = claimed.cfg;

    const tenantId = e.tenant_id as string;
    const provider = e.provider as string;
    const workspaceId = e.workspace_id as string;
    const eventId = e.event_id as string;
    const attemptCount = Number(e.attempt_count ?? 0);
    const body = e.body_json ?? null;
    const text = typeof body?.text === "string" ? body.text : "";
    const channelUserId = typeof body?.channelUserId === "string" ? body.channelUserId : null;
    const channelChatId = typeof body?.channelChatId === "string" ? body.channelChatId : null;

    const inputDigest = { id: e.id, provider, workspaceId, eventId, attemptCount };

    try {
      const mapped = await hasMapping({ pool: params.pool, tenantId, provider, workspaceId, channelUserId, channelChatId });
      if (!mapped) {
        const errDigest = { reason: "mapping_missing", bodyDigest: e.body_digest };
        const backoffMs = computeBackoffMs(cfg.backoffMsBase, attemptCount);
        const willDeadletter = attemptCount >= cfg.maxAttempts;
        if (willDeadletter) {
          await params.pool.query(
            `
              UPDATE channel_ingress_events
              SET status = 'deadletter',
                  last_error_category = 'mapping_missing',
                  last_error_digest = $2::jsonb,
                  deadlettered_at = now(),
                  updated_at = now()
              WHERE id = $1
            `,
            [e.id, JSON.stringify(errDigest)],
          );
          await insertAuditEvent({ pool: params.pool, tenantId, spaceId: cfg.spaceId, resourceType: "channel", action: "webhook.deadletter", inputDigest, outputDigest: errDigest, result: "denied", traceId, errorCategory: "policy_violation", latencyMs: Date.now() - startedAtMs });
          continue;
        }
        await params.pool.query(
          `
            UPDATE channel_ingress_events
            SET status = 'failed',
                last_error_category = 'mapping_missing',
                last_error_digest = $2::jsonb,
                next_attempt_at = now() + ($3 || ' milliseconds')::interval,
                updated_at = now()
            WHERE id = $1
          `,
          [e.id, JSON.stringify(errDigest), backoffMs],
        );
        await insertAuditEvent({ pool: params.pool, tenantId, spaceId: cfg.spaceId, resourceType: "channel", action: "webhook.attempt", inputDigest, outputDigest: { status: "failed", error: errDigest, nextAttemptMs: backoffMs }, result: "denied", traceId, errorCategory: "policy_violation", latencyMs: Date.now() - startedAtMs });
        continue;
      }

      const mapping = await resolveMapping({ pool: params.pool, tenantId, provider, workspaceId, channelUserId, channelChatId });
      if (!mapping) throw new Error("mapping_missing");
      const resolvedChatId = mapping.channelChatId;
      if (!resolvedChatId) throw new Error("policy_violation:missing_channel_chat_id");

      const convId = channelConversationId({ provider, workspaceId, channelChatId: resolvedChatId, threadId: null });
      const orch = await callDataPlaneJson({
        pool: params.pool,
        tenantId,
        spaceId: mapping.spaceId,
        subjectId: mapping.subjectId,
        traceId,
        method: "POST",
        path: "/orchestrator/turn",
        body: { message: text, locale: "zh-CN", conversationId: convId },
      });
      const replyText = pickReplyText("zh-CN", orch?.replyText);
      if (!replyText.trim()) throw new Error("invalid_reply");

      const outbox = await params.pool.query(
        `
          INSERT INTO channel_outbox_messages (tenant_id, provider, workspace_id, channel_chat_id, to_user_id, request_id, trace_id, status, message_json)
          VALUES ($1,$2,$3,$4,NULL,$5,$6,'queued',$7::jsonb)
          RETURNING id
        `,
        [tenantId, provider, workspaceId, resolvedChatId, String(e.request_id ?? ""), String(e.trace_id ?? ""), JSON.stringify({ text: replyText })],
      );
      const outboxId = outbox.rows[0]?.id ? String(outbox.rows[0].id) : "";

      const resp = { correlation: { requestId: e.request_id, traceId: e.trace_id }, status: "succeeded" as const, outboxId };
      await params.pool.query(
        `
          UPDATE channel_ingress_events
          SET status = 'succeeded',
              response_status_code = 200,
              response_json = $2::jsonb,
              updated_at = now()
          WHERE id = $1
        `,
        [e.id, JSON.stringify(resp)],
      );
      await insertAuditEvent({
        pool: params.pool,
        tenantId,
        spaceId: cfg.spaceId,
        resourceType: "channel",
        action: "webhook.delivered",
        inputDigest,
        outputDigest: { status: "succeeded", outboxId },
        result: "success",
        traceId,
        latencyMs: Date.now() - startedAtMs,
      });
    } catch (err: any) {
      const backoffMs = computeBackoffMs(cfg.backoffMsBase, attemptCount);
      const digest = { message: String(err?.message ?? "unknown"), messageLen: String(err?.message ?? "").length, sha256_8: sha256Hex(String(err?.message ?? "unknown")).slice(0, 8) };
      const willDeadletter = attemptCount >= cfg.maxAttempts;
      const msg = String(err?.message ?? "");
      const isPolicy = msg === "mapping_missing" || msg.startsWith("policy_violation:");
      const category = isPolicy ? "policy_violation" : "internal";
      if (willDeadletter) {
        await params.pool.query(
          `
            UPDATE channel_ingress_events
            SET status = 'deadletter',
                last_error_category = $3,
                last_error_digest = $2::jsonb,
                deadlettered_at = now(),
                updated_at = now()
            WHERE id = $1
          `,
          [e.id, JSON.stringify(digest), category],
        );
        await insertAuditEvent({
          pool: params.pool,
          tenantId,
          spaceId: cfg.spaceId,
          resourceType: "channel",
          action: "webhook.deadletter",
          inputDigest,
          outputDigest: digest,
          result: isPolicy ? "denied" : "error",
          traceId,
          errorCategory: category,
          latencyMs: Date.now() - startedAtMs,
        });
        continue;
      }
      await params.pool.query(
        `
          UPDATE channel_ingress_events
          SET status = 'failed',
              last_error_category = $4,
              last_error_digest = $2::jsonb,
              next_attempt_at = now() + ($3 || ' milliseconds')::interval,
              updated_at = now()
          WHERE id = $1
        `,
        [e.id, JSON.stringify(digest), backoffMs, category],
      );
      await insertAuditEvent({
        pool: params.pool,
        tenantId,
        spaceId: cfg.spaceId,
        resourceType: "channel",
        action: "webhook.attempt",
        inputDigest,
        outputDigest: { status: "failed", error: digest, nextAttemptMs: backoffMs },
        result: isPolicy ? "denied" : "error",
        traceId,
        errorCategory: category,
        latencyMs: Date.now() - startedAtMs,
      });
    }
  }
  return { ok: true };
}
