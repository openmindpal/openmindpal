import crypto from "node:crypto";
import type { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";
import { normalizeAuditErrorCategory } from "@openslin/shared";
import { ExchangePollError, pollExchangeDelta } from "./exchangeGraph";
import { invokeFirstPartySkill } from "../lib/skillInvoke";

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

function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function sha256HexBytes(bytes: Buffer) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function normalizeAllowedDomains(v: any) {
  const arr = Array.isArray(v) ? v : [];
  return arr
    .map((x) => (typeof x === "string" ? x.trim().toLowerCase() : ""))
    .filter((x) => Boolean(x));
}

async function loadImapConfig(params: { pool: Pool; tenantId: string; connectorInstanceId: string }) {
  const res = await params.pool.query(
    `
      SELECT
        c.connector_instance_id,
        c.tenant_id,
        c.host,
        c.port,
        c.use_tls,
        c.username,
        c.password_secret_id,
        c.mailbox,
        c.fetch_window_days,
        i.status AS instance_status,
        i.egress_policy,
        t.default_egress_policy
      FROM imap_connector_configs c
      JOIN connector_instances i ON i.id = c.connector_instance_id AND i.tenant_id = c.tenant_id
      JOIN connector_types t ON t.name = i.type_name
      WHERE c.tenant_id = $1 AND c.connector_instance_id = $2
      LIMIT 1
    `,
    [params.tenantId, params.connectorInstanceId],
  );
  if (!res.rowCount) return null;
  const r = res.rows[0];
  return {
    connectorInstanceId: r.connector_instance_id as string,
    tenantId: r.tenant_id as string,
    host: r.host as string,
    port: Number(r.port),
    useTls: Boolean(r.use_tls),
    username: r.username as string,
    passwordSecretId: r.password_secret_id as string,
    mailbox: r.mailbox as string,
    fetchWindowDays: r.fetch_window_days ?? null,
    instanceStatus: r.instance_status as string,
    egressPolicy: r.egress_policy,
    defaultEgressPolicy: r.default_egress_policy,
  };
}

async function ensureImapSecretActive(params: { pool: Pool; tenantId: string; connectorInstanceId: string; secretId: string }) {
  const res = await params.pool.query(
    `
      SELECT status
      FROM secret_records
      WHERE tenant_id = $1 AND id = $2 AND connector_instance_id = $3
      LIMIT 1
    `,
    [params.tenantId, params.secretId, params.connectorInstanceId],
  );
  if (!res.rowCount) return false;
  return res.rows[0].status === "active";
}

async function runMockPoll(params: { pool: Pool; sub: any; runId: string; traceId: string; watermarkBefore: any }) {
  const seq = typeof params.watermarkBefore?.seq === "number" ? params.watermarkBefore.seq : 0;
  const nextSeq = seq + 1;
  const eventId = `mock:${params.sub.subscription_id}:${nextSeq}`;
  const payload = { provider: params.sub.provider, subscriptionId: params.sub.subscription_id, seq: nextSeq, text: "mock" };
  const bodyDigest = `sha256:${sha256Hex(stableStringify(payload))}`;
  const workspaceId = `subscription:${params.sub.subscription_id}`;

  const inserted = await params.pool.query(
    `
      INSERT INTO channel_ingress_events (
        tenant_id, provider, workspace_id, event_id, nonce, body_digest, body_json, request_id, trace_id, space_id, status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,'received')
      ON CONFLICT DO NOTHING
      RETURNING id
    `,
    [params.sub.tenant_id, params.sub.provider, workspaceId, eventId, params.runId, bodyDigest, JSON.stringify(payload), params.runId, params.traceId, params.sub.space_id ?? null],
  );

  const eventCount = inserted.rowCount ? 1 : 0;
  const watermarkAfter = { seq: nextSeq };
  return { eventCount, watermarkAfter };
}

async function runImapPoll(params: { pool: Pool; sub: any; runId: string; traceId: string; watermarkBefore: any }) {
  const connectorInstanceId = params.sub.connector_instance_id as string | null;
  if (!connectorInstanceId) throw new Error("connector_instance_missing");

  const cfg = await loadImapConfig({ pool: params.pool, tenantId: params.sub.tenant_id, connectorInstanceId });
  if (!cfg) throw new Error("imap_config_missing");
  if (cfg.instanceStatus !== "enabled") throw new Error("connector_instance_disabled");

  const allowed = normalizeAllowedDomains(cfg.egressPolicy?.allowedDomains ?? cfg.defaultEgressPolicy?.allowedDomains ?? []);
  if (!allowed.includes(String(cfg.host).trim().toLowerCase())) throw new Error("egress_host_not_allowed");

  const secretOk = await ensureImapSecretActive({ pool: params.pool, tenantId: cfg.tenantId, connectorInstanceId: cfg.connectorInstanceId, secretId: cfg.passwordSecretId });
  if (!secretOk) throw new Error("imap_secret_missing_or_revoked");

  const spaceId = params.sub.space_id as string | null;
  if (!spaceId) throw new Error("subscription_space_missing");

  const uidNext = typeof params.watermarkBefore?.uidNext === "number" ? params.watermarkBefore.uidNext : 1;
  const workspaceId = `imap:${cfg.connectorInstanceId}:${cfg.mailbox}`;
  const uid = uidNext;
  const eventId = `imap:${cfg.connectorInstanceId}:${cfg.mailbox}:${uid}`;

  const exists = await params.pool.query(
    `SELECT 1 FROM channel_ingress_events WHERE tenant_id = $1 AND provider = 'imap' AND workspace_id = $2 AND event_id = $3 LIMIT 1`,
    [cfg.tenantId, workspaceId, eventId],
  );
  if (exists.rowCount) {
    const watermarkAfter = { uidNext: uid + 1 };
    return { eventCount: 0, watermarkAfter };
  }

  /* ─── 委托 imap-poll-skill 生成邮件数据（当前为 mock） ─── */
  const skillResult = await invokeFirstPartySkill({
    skillDir: "imap-poll-skill",
    input: { mailbox: cfg.mailbox, uidNext },
    traceId: params.traceId,
    tenantId: cfg.tenantId,
    spaceId,
  });

  /* ─── 平台层：将 skill 返回的数据写入 DB ─── */
  const bodyMeta = skillResult.body;
  const attMeta = (skillResult.attachments ?? [])[0];
  const isOversize = Boolean(skillResult.isOversize);
  const internalDate = skillResult.internalDate;

  const initialPayload = {
    provider: "imap",
    workspaceId,
    eventId,
    mailbox: cfg.mailbox,
    uid,
    internalDate,
    message: skillResult.summary,
    body: { ...bodyMeta },
    attachments: attMeta ? [{ ...attMeta }] : [],
  };
  const initialDigest = `sha256:${sha256Hex(stableStringify(initialPayload))}`;

  const inserted = await params.pool.query(
    `
      INSERT INTO channel_ingress_events (
        tenant_id, provider, workspace_id, event_id, nonce, body_digest, body_json, request_id, trace_id, space_id, status
      )
      VALUES ($1,'imap',$2,$3,$4,$5,$6::jsonb,$7,$8,$9,'received')
      ON CONFLICT DO NOTHING
      RETURNING id
    `,
    [cfg.tenantId, workspaceId, eventId, `uid:${uid}`, initialDigest, JSON.stringify(initialPayload), params.runId, params.traceId, spaceId],
  );

  const eventCount = inserted.rowCount ? 1 : 0;
  const watermarkAfter = skillResult.watermarkAfter;
  if (!eventCount) return { eventCount, watermarkAfter };

  const singleMax = 5 * 1024 * 1024;
  const totalMax = 10 * 1024 * 1024;
  const bodyBytesLen = bodyMeta.byteSize;
  const attBytesLen = attMeta ? attMeta.byteSize : 0;
  const totalSize = bodyBytesLen + attBytesLen;
  const allowBody = bodyBytesLen <= singleMax && totalSize <= totalMax;
  const allowAttachment = attBytesLen <= singleMax && totalSize <= totalMax;

  const evId = inserted.rows[0].id as string;
  const created: { body?: string; attachments?: string[] } = {};

  if (allowBody && skillResult.bodyContent) {
    const bodyBytes = Buffer.from(skillResult.bodyContent, "utf8");
    const bRes = await params.pool.query(
      `
        INSERT INTO media_objects (
          tenant_id, space_id, content_type, byte_size, sha256, status, source, provenance, safety_digest, content_bytes, created_by_subject_id
        )
        VALUES ($1,$2,$3,$4,$5,'uploaded',$6,$7,$8,$9,$10)
        RETURNING media_id
      `,
      [
        cfg.tenantId, spaceId, bodyMeta.contentType, bodyMeta.byteSize, bodyMeta.sha256,
        { provider: "imap", workspaceId, eventId, kind: "body" }, null, null, bodyBytes, null,
      ],
    );
    created.body = `media:${bRes.rows[0].media_id as string}`;
  }
  if (allowAttachment && attMeta) {
    const attachmentBytes = isOversize
      ? Buffer.alloc(6 * 1024 * 1024, 0x61)
      : Buffer.from(skillResult.attachmentContent ?? "", "utf8");
    const aRes = await params.pool.query(
      `
        INSERT INTO media_objects (
          tenant_id, space_id, content_type, byte_size, sha256, status, source, provenance, safety_digest, content_bytes, created_by_subject_id
        )
        VALUES ($1,$2,$3,$4,$5,'uploaded',$6,$7,$8,$9,$10)
        RETURNING media_id
      `,
      [
        cfg.tenantId, spaceId, attMeta.contentType, attMeta.byteSize, attMeta.sha256,
        { provider: "imap", workspaceId, eventId, kind: "attachment", fileName: attMeta.fileName }, null, null, attachmentBytes, null,
      ],
    );
    created.attachments = [`media:${aRes.rows[0].media_id as string}`];
  }

  const finalPayload = {
    ...initialPayload,
    body: allowBody && created.body ? { ...bodyMeta, mediaRef: created.body } : { ...bodyMeta },
    attachments: attMeta ? [
      allowAttachment && created.attachments ? { ...attMeta, mediaRef: (created.attachments ?? [])[0] } : { ...attMeta },
    ] : [],
    limits: { singleMax, totalMax },
  };
  const finalDigest = `sha256:${sha256Hex(stableStringify(finalPayload))}`;
  await params.pool.query(
    `UPDATE channel_ingress_events SET body_json = $2::jsonb, body_digest = $3, updated_at = now() WHERE id = $1`,
    [evId, JSON.stringify(finalPayload), finalDigest],
  );

  return { eventCount, watermarkAfter };
}

async function loadExchangeConfig(params: { pool: Pool; tenantId: string; connectorInstanceId: string }) {
  const res = await params.pool.query(
    `
      SELECT
        c.connector_instance_id,
        c.tenant_id,
        c.oauth_grant_id,
        c.mailbox,
        c.fetch_window_days,
        i.status AS instance_status,
        i.egress_policy,
        t.default_egress_policy,
        g.status AS grant_status,
        g.token_expires_at,
        g.secret_record_id,
        s.status AS secret_status,
        s.scope_type AS secret_scope_type,
        s.scope_id AS secret_scope_id,
        s.key_version AS secret_key_version,
        s.enc_format AS secret_enc_format,
        s.key_ref AS secret_key_ref,
        s.encrypted_payload
      FROM exchange_connector_configs c
      JOIN connector_instances i ON i.id = c.connector_instance_id AND i.tenant_id = c.tenant_id
      JOIN connector_types t ON t.name = i.type_name
      JOIN oauth_grants g ON g.tenant_id = c.tenant_id AND g.grant_id = c.oauth_grant_id
      JOIN secret_records s ON s.tenant_id = g.tenant_id AND s.id = g.secret_record_id AND s.connector_instance_id = g.connector_instance_id
      WHERE c.tenant_id = $1 AND c.connector_instance_id = $2
      LIMIT 1
    `,
    [params.tenantId, params.connectorInstanceId],
  );
  if (!res.rowCount) return null;
  const r = res.rows[0];
  return {
    connectorInstanceId: r.connector_instance_id as string,
    tenantId: r.tenant_id as string,
    oauthGrantId: r.oauth_grant_id as string,
    mailbox: r.mailbox as string,
    fetchWindowDays: r.fetch_window_days ?? null,
    instanceStatus: r.instance_status as string,
    egressPolicy: r.egress_policy,
    defaultEgressPolicy: r.default_egress_policy,
    grantStatus: r.grant_status as string,
    tokenExpiresAt: r.token_expires_at ?? null,
    secretRecordId: r.secret_record_id as string,
    secretStatus: r.secret_status as string,
    secretScopeType: r.secret_scope_type as string,
    secretScopeId: r.secret_scope_id as string,
    secretKeyVersion: Number(r.secret_key_version),
    secretEncFormat: (r.secret_enc_format as string) ?? "legacy.a256gcm",
    secretKeyRef: r.secret_key_ref ?? null,
    encryptedPayload: r.encrypted_payload,
  };
}

async function runExchangePoll(params: { pool: Pool; sub: any; runId: string; traceId: string; watermarkBefore: any; masterKey: string }) {
  const connectorInstanceId = params.sub.connector_instance_id as string | null;
  if (!connectorInstanceId) throw new Error("connector_instance_missing");

  const spaceId = params.sub.space_id as string | null;
  if (!spaceId) throw new Error("subscription_space_missing");

  const cfg = await loadExchangeConfig({ pool: params.pool, tenantId: params.sub.tenant_id, connectorInstanceId });
  if (!cfg) throw new Error("exchange_config_missing");
  const allowed = normalizeAllowedDomains(cfg.egressPolicy?.allowedDomains ?? cfg.defaultEgressPolicy?.allowedDomains ?? []);

  const result = await pollExchangeDelta({
    pool: params.pool,
    masterKey: params.masterKey,
    cfg: {
      tenantId: cfg.tenantId,
      spaceId,
      connectorInstanceId: cfg.connectorInstanceId,
      oauthGrantId: cfg.oauthGrantId,
      mailbox: cfg.mailbox,
      instanceStatus: cfg.instanceStatus,
      allowedDomains: allowed,
      grantStatus: cfg.grantStatus,
      tokenExpiresAt: cfg.tokenExpiresAt,
      secretRecordId: cfg.secretRecordId,
      secretStatus: cfg.secretStatus,
      secretScopeType: cfg.secretScopeType,
      secretScopeId: cfg.secretScopeId,
      secretKeyVersion: cfg.secretKeyVersion,
      secretEncFormat: cfg.secretEncFormat,
      secretKeyRef: cfg.secretKeyRef,
      encryptedPayload: cfg.encryptedPayload,
    },
    runId: params.runId,
    traceId: params.traceId,
    watermarkBefore: params.watermarkBefore,
    attemptCount: 1,
  });

  return {
    eventCount: result.summary.insertedCount,
    dedupCount: result.summary.dedupCount,
    watermarkAfter: result.summary.watermarkAfter,
    watermarkDigest: result.watermarkDigest,
    watermarkNote: result.summary.watermarkNote,
  };
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

export async function processSubscriptionPoll(params: { pool: Pool; subscriptionId: string; masterKey: string }) {
  const startedAtMs = Date.now();
  const traceId = uuidv4();

  let sub: any;
  await params.pool.query("BEGIN");
  try {
    const res = await params.pool.query("SELECT * FROM subscriptions WHERE subscription_id = $1 FOR UPDATE", [params.subscriptionId]);
    if (!res.rowCount) {
      await params.pool.query("ROLLBACK");
      return { ok: false, skipped: true, reason: "not_found" };
    }
    sub = res.rows[0];
    if (sub.status !== "enabled") {
      await params.pool.query("COMMIT");
      return { ok: true, skipped: true, reason: "disabled" };
    }
    const nextRunAt = sub.next_run_at ? new Date(sub.next_run_at).getTime() : null;
    if (nextRunAt && Date.now() < nextRunAt) {
      await params.pool.query("COMMIT");
      return { ok: true, skipped: true, reason: "backoff" };
    }

    const lastRunAt = sub.last_run_at ? new Date(sub.last_run_at).getTime() : null;
    const due = !lastRunAt || Date.now() - lastRunAt >= Number(sub.poll_interval_sec) * 1000;
    if (!due) {
      await params.pool.query("COMMIT");
      return { ok: true, skipped: true, reason: "not_due" };
    }
    await params.pool.query("UPDATE subscriptions SET last_run_at = now(), next_run_at = NULL, updated_at = now() WHERE subscription_id = $1", [params.subscriptionId]);
    await params.pool.query("COMMIT");
  } catch (e) {
    await params.pool.query("ROLLBACK");
    throw e;
  }

  const watermarkBefore = sub.watermark ?? null;
  const runRes = await params.pool.query(
    `
      INSERT INTO subscription_runs (subscription_id, tenant_id, status, trace_id, watermark_before)
      VALUES ($1,$2,'running',$3,$4)
      RETURNING run_id
    `,
    [sub.subscription_id, sub.tenant_id, traceId, watermarkBefore],
  );
  const runId = runRes.rows[0].run_id as string;

  try {
    const r =
      sub.provider === "imap"
        ? await runImapPoll({ pool: params.pool, sub, runId, traceId, watermarkBefore })
        : sub.provider === "exchange"
          ? await runExchangePoll({ pool: params.pool, sub, runId, traceId, watermarkBefore, masterKey: params.masterKey })
          : await runMockPoll({ pool: params.pool, sub, runId, traceId, watermarkBefore });

    const eventCount = r.eventCount;
    const watermarkAfter = r.watermarkAfter;
    const dedupCount = (r as any).dedupCount ?? 0;
    const watermarkDigest = (r as any).watermarkDigest ?? null;
    const watermarkNote = (r as any).watermarkNote ?? null;

    await params.pool.query("UPDATE subscriptions SET watermark = $2, next_run_at = NULL, updated_at = now() WHERE subscription_id = $1", [sub.subscription_id, watermarkAfter]);
    await params.pool.query(
      `
        UPDATE subscription_runs
        SET status = 'succeeded', watermark_after = $2, event_count = $3, finished_at = now()
        WHERE run_id = $1
      `,
      [runId, watermarkAfter, eventCount],
    );

    await insertAuditEvent({
      pool: params.pool,
      tenantId: sub.tenant_id,
      spaceId: sub.space_id ?? null,
      resourceType: "subscription",
      action: "poll",
      inputDigest:
        sub.provider === "exchange"
          ? { subscriptionId: sub.subscription_id, provider: sub.provider }
          : { subscriptionId: sub.subscription_id, watermarkBefore },
      outputDigest:
        sub.provider === "exchange"
          ? { subscriptionId: sub.subscription_id, provider: sub.provider, eventCount, dedupCount: dedupCount ?? 0, watermark: watermarkDigest ?? null, watermarkNote: watermarkNote ?? null }
          : { subscriptionId: sub.subscription_id, eventCount, watermarkAfter },
      result: "success",
      traceId,
      latencyMs: Date.now() - startedAtMs,
    });

    return { ok: true, skipped: false, runId, traceId, eventCount, watermarkAfter };
  } catch (e: any) {
    const isExchangePollError = e instanceof ExchangePollError;
    const errorCategory = isExchangePollError ? e.category : "internal";
    const errorDigest = isExchangePollError ? e.digest : { messageLen: String(e?.message ?? "unknown").length };
    const backoffMs = isExchangePollError ? e.backoffMs ?? null : null;
    await params.pool.query(
      `
        UPDATE subscription_runs
        SET status = 'failed', error_category = $2, error_digest = $3::jsonb, backoff_ms = $4, finished_at = now()
        WHERE run_id = $1
      `,
      [runId, errorCategory, JSON.stringify(errorDigest), backoffMs],
    );
    if (backoffMs && backoffMs > 0) {
      await params.pool.query("UPDATE subscriptions SET next_run_at = now() + ($2 || ' milliseconds')::interval, updated_at = now() WHERE subscription_id = $1", [sub.subscription_id, backoffMs]);
    }
    await insertAuditEvent({
      pool: params.pool,
      tenantId: sub.tenant_id,
      spaceId: sub.space_id ?? null,
      resourceType: "subscription",
      action: "poll",
      inputDigest: { subscriptionId: sub.subscription_id, provider: sub.provider },
      outputDigest: { subscriptionId: sub.subscription_id, provider: sub.provider, errorCategory, errorDigest, backoffMs },
      result: "error",
      traceId,
      errorCategory,
      latencyMs: Date.now() - startedAtMs,
    });
    throw e;
  }
}
