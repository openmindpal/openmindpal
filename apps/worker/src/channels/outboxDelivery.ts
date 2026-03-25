import crypto from "node:crypto";
import type { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";
import { normalizeAuditErrorCategory } from "@openslin/shared";
import { decryptSecretPayload } from "../secrets/envelope";
import { invokeFirstPartySkill } from "../lib/skillInvoke";

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

function hmacHex(secret: string, input: string) {
  return crypto.createHmac("sha256", secret).update(input, "utf8").digest("hex");
}

function pickSecret(payload: Record<string, unknown>, key: string) {
  const v = payload[key];
  return typeof v === "string" ? String(v) : "";
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

async function claimOne(params: { pool: Pool }) {
  await params.pool.query("BEGIN");
  try {
    const res = await params.pool.query(
      `
        SELECT
          m.*,
          c.space_id AS cfg_space_id,
          c.secret_env_key AS cfg_secret_env_key,
          c.secret_id AS cfg_secret_id,
          c.delivery_mode AS cfg_delivery_mode,
          c.max_attempts AS cfg_max_attempts,
          c.backoff_ms_base AS cfg_backoff_ms_base
        FROM channel_outbox_messages m
        JOIN channel_webhook_configs c
          ON c.tenant_id = m.tenant_id AND c.provider = m.provider AND c.workspace_id = m.workspace_id
        WHERE m.status IN ('queued','failed')
          AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= now())
          AND m.attempt_count < c.max_attempts
          AND c.delivery_mode = 'async'
          AND m.provider <> 'mock'
        ORDER BY m.created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `,
    );
    if (!res.rowCount) {
      await params.pool.query("COMMIT");
      return null;
    }
    const row = res.rows[0] as any;
    const upd = await params.pool.query(
      `
        UPDATE channel_outbox_messages
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
    return {
      msg: upd.rows[0] as any,
      cfg: {
        spaceId: row.cfg_space_id ?? null,
        secretEnvKey: row.cfg_secret_env_key ?? null,
        secretId: row.cfg_secret_id ?? null,
        deliveryMode: row.cfg_delivery_mode ?? "sync",
        maxAttempts: Number(row.cfg_max_attempts ?? 8),
        backoffMsBase: Number(row.cfg_backoff_ms_base ?? 500),
      },
    };
  } catch (e) {
    await params.pool.query("ROLLBACK");
    throw e;
  }
}

async function loadSecretPayload(params: { pool: Pool; tenantId: string; secretId: string; masterKey: string }) {
  const res = await params.pool.query(
    `
      SELECT id, tenant_id, scope_type, scope_id, connector_instance_id, status, key_version, enc_format, encrypted_payload
      FROM secret_records
      WHERE tenant_id = $1 AND id = $2
      LIMIT 1
    `,
    [params.tenantId, params.secretId],
  );
  if (!res.rowCount) return null;
  const r = res.rows[0] as any;
  if (String(r.status ?? "") !== "active") return null;
  const payload = await decryptSecretPayload({
    pool: params.pool,
    tenantId: params.tenantId,
    masterKey: params.masterKey,
    scopeType: String(r.scope_type ?? ""),
    scopeId: String(r.scope_id ?? ""),
    keyVersion: Number(r.key_version ?? 1),
    encFormat: String(r.enc_format ?? "legacy.a256gcm"),
    encryptedPayload: r.encrypted_payload,
  });
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

/* ─── 第三方 API 发送逻辑已提取为 skill ─── */

async function bridgeSend(params: {
  baseUrl: string;
  secret: string;
  provider: string;
  workspaceId: string;
  requestId: string;
  traceId: string;
  to: { channelChatId: string };
  message: { text: string };
  idempotencyKey: string;
}) {
  await invokeFirstPartySkill({
    skillDir: "bridge-send-skill",
    input: {
      baseUrl: params.baseUrl,
      secret: params.secret,
      provider: params.provider,
      workspaceId: params.workspaceId,
      requestId: params.requestId,
      traceId: params.traceId,
      to: params.to,
      message: params.message,
      idempotencyKey: params.idempotencyKey,
    },
  });
}

async function sendViaWebhook(params: { webhookUrl: string; text: string }) {
  await invokeFirstPartySkill({
    skillDir: "webhook-send-skill",
    input: { webhookUrl: params.webhookUrl, text: params.text },
  });
}

async function sendViaSlack(params: { botToken: string; channel: string; text: string }) {
  await invokeFirstPartySkill({
    skillDir: "slack-send-skill",
    input: { botToken: params.botToken, channel: params.channel, text: params.text },
  });
}

export async function tickChannelOutboxDeliveries(params: { pool: Pool; masterKey: string; limit?: number }) {
  const limit = params.limit ?? 20;
  for (let i = 0; i < limit; i++) {
    const startedAtMs = Date.now();
    const traceId = uuidv4();
    const claimed = await claimOne({ pool: params.pool });
    if (!claimed) return { ok: true };

    const m = claimed.msg;
    const cfg = claimed.cfg;

    const tenantId = String(m.tenant_id ?? "");
    const provider = String(m.provider ?? "");
    const workspaceId = String(m.workspace_id ?? "");
    const outboxId = String(m.id ?? "");
    const requestId = String(m.request_id ?? "");
    const msgJson = m.message_json ?? {};
    const attemptCount = Number(m.attempt_count ?? 0);

    const inputDigest = { outboxId, provider, workspaceId, attemptCount };

    try {
      const text = typeof msgJson?.text === "string" ? msgJson.text : typeof msgJson?.message?.text === "string" ? msgJson.message.text : "";
      if (!text) throw new Error("invalid_message");

      const envSecret = cfg.secretEnvKey ? String(process.env[String(cfg.secretEnvKey)] ?? "") : "";
      const secretPayload = cfg.secretId ? await loadSecretPayload({ pool: params.pool, tenantId, secretId: String(cfg.secretId), masterKey: params.masterKey }) : null;
      const secretObj = secretPayload ?? {};
      const webhookSecret = envSecret || pickSecret(secretObj, "webhookSecret");
      const bridgeBaseUrl = pickSecret(secretObj, "bridgeBaseUrl");
      const webhookUrl = pickSecret(secretObj, "webhookUrl");
      const slackBotToken = pickSecret(secretObj, "slackBotToken");

      if (!webhookSecret && (provider === "qq.onebot" || provider === "imessage.bridge")) throw new Error("config_missing");
      if (provider === "qq.onebot" || provider === "imessage.bridge") {
        if (!bridgeBaseUrl) throw new Error("config_missing");
        await bridgeSend({
          baseUrl: bridgeBaseUrl,
          secret: webhookSecret,
          provider,
          workspaceId,
          requestId,
          traceId,
          to: { channelChatId: String(m.channel_chat_id ?? "") },
          message: { text },
          idempotencyKey: `outbox_${outboxId}`,
        });
      } else if (slackBotToken) {
        await sendViaSlack({ botToken: slackBotToken, channel: String(m.channel_chat_id ?? ""), text });
      } else if (webhookUrl) {
        await sendViaWebhook({ webhookUrl, text });
      } else {
        throw new Error("config_missing");
      }

      await params.pool.query(
        `
          UPDATE channel_outbox_messages
          SET status = 'delivered',
              delivered_at = COALESCE(delivered_at, now()),
              updated_at = now()
          WHERE id = $1
        `,
        [outboxId],
      );
      await insertAuditEvent({ pool: params.pool, tenantId, spaceId: cfg.spaceId, resourceType: "channel", action: "outbox.delivered", inputDigest, outputDigest: { status: "delivered" }, result: "success", traceId, latencyMs: Date.now() - startedAtMs });
    } catch (err: any) {
      const backoffMs = computeBackoffMs(cfg.backoffMsBase, attemptCount);
      const digest = { message: String(err?.message ?? "unknown"), sha256_8: sha256Hex(String(err?.message ?? "unknown")).slice(0, 8) };
      const category = String(err?.message ?? "").includes("config_missing") ? "policy_violation" : "internal";
      const willDeadletter = attemptCount >= cfg.maxAttempts;
      if (willDeadletter) {
        await params.pool.query(
          `
            UPDATE channel_outbox_messages
            SET status = 'deadletter',
                last_error_category = $2,
                last_error_digest = $3::jsonb,
                deadlettered_at = now(),
                updated_at = now()
            WHERE id = $1
          `,
          [outboxId, category, JSON.stringify(digest)],
        );
        await insertAuditEvent({ pool: params.pool, tenantId, spaceId: cfg.spaceId, resourceType: "channel", action: "outbox.deadletter", inputDigest, outputDigest: digest, result: "error", traceId, errorCategory: category, latencyMs: Date.now() - startedAtMs });
        continue;
      }
      await params.pool.query(
        `
          UPDATE channel_outbox_messages
          SET status = 'failed',
              last_error_category = $2,
              last_error_digest = $3::jsonb,
              next_attempt_at = now() + ($4 || ' milliseconds')::interval,
              updated_at = now()
          WHERE id = $1
        `,
        [outboxId, category, JSON.stringify(digest), backoffMs],
      );
      await insertAuditEvent({ pool: params.pool, tenantId, spaceId: cfg.spaceId, resourceType: "channel", action: "outbox.attempt", inputDigest, outputDigest: { status: "failed", error: digest, nextAttemptMs: backoffMs }, result: "error", traceId, errorCategory: category, latencyMs: Date.now() - startedAtMs });
    }
  }
  return { ok: true };
}
