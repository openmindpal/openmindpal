import type { Pool } from "pg";

export type ChannelWebhookConfigRow = {
  tenantId: string;
  provider: string;
  workspaceId: string;
  spaceId: string | null;
  secretEnvKey: string | null;
  secretId: string | null;
  providerConfig: any;
  toleranceSec: number;
  deliveryMode: string;
  maxAttempts: number;
  backoffMsBase: number;
  createdAt: string;
  updatedAt: string;
};

export type ChannelAccountRow = {
  tenantId: string;
  provider: string;
  workspaceId: string;
  channelUserId: string;
  subjectId: string;
  spaceId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type ChannelChatBindingRow = {
  tenantId: string;
  provider: string;
  workspaceId: string;
  channelChatId: string;
  spaceId: string;
  defaultSubjectId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type ChannelIngressEventRow = {
  id: string;
  tenantId: string;
  provider: string;
  workspaceId: string;
  eventId: string;
  nonce: string;
  bodyDigest: string;
  bodyJson: any;
  requestId: string;
  traceId: string;
  status: string;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastErrorCategory: string | null;
  lastErrorDigest: any;
  deadletteredAt: string | null;
  responseStatusCode: number | null;
  responseJson: any;
  createdAt: string;
  updatedAt: string;
};

export type ChannelOutboxMessageRow = {
  id: string;
  tenantId: string;
  provider: string;
  workspaceId: string;
  channelChatId: string;
  toUserId: string | null;
  requestId: string;
  traceId: string;
  status: string;
  messageJson: any;
  deliveredAt: string | null;
  ackedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function toWebhookConfig(r: any): ChannelWebhookConfigRow {
  return {
    tenantId: r.tenant_id,
    provider: r.provider,
    workspaceId: r.workspace_id,
    spaceId: r.space_id,
    secretEnvKey: r.secret_env_key ?? null,
    secretId: r.secret_id ?? null,
    providerConfig: r.provider_config ?? null,
    toleranceSec: r.tolerance_sec,
    deliveryMode: r.delivery_mode,
    maxAttempts: Number(r.max_attempts ?? 8),
    backoffMsBase: Number(r.backoff_ms_base ?? 500),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toAccount(r: any): ChannelAccountRow {
  return {
    tenantId: r.tenant_id,
    provider: r.provider,
    workspaceId: r.workspace_id,
    channelUserId: r.channel_user_id,
    subjectId: r.subject_id,
    spaceId: r.space_id,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toChatBinding(r: any): ChannelChatBindingRow {
  return {
    tenantId: r.tenant_id,
    provider: r.provider,
    workspaceId: r.workspace_id,
    channelChatId: r.channel_chat_id,
    spaceId: r.space_id,
    defaultSubjectId: r.default_subject_id,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toIngressEvent(r: any): ChannelIngressEventRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    provider: r.provider,
    workspaceId: r.workspace_id,
    eventId: r.event_id,
    nonce: r.nonce,
    bodyDigest: r.body_digest,
    bodyJson: r.body_json ?? null,
    requestId: r.request_id,
    traceId: r.trace_id,
    status: r.status,
    attemptCount: Number(r.attempt_count ?? 0),
    nextAttemptAt: r.next_attempt_at ?? null,
    lastErrorCategory: r.last_error_category ?? null,
    lastErrorDigest: r.last_error_digest ?? null,
    deadletteredAt: r.deadlettered_at ?? null,
    responseStatusCode: r.response_status_code,
    responseJson: r.response_json,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toOutboxMessage(r: any): ChannelOutboxMessageRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    provider: r.provider,
    workspaceId: r.workspace_id,
    channelChatId: r.channel_chat_id,
    toUserId: r.to_user_id,
    requestId: r.request_id,
    traceId: r.trace_id,
    status: r.status,
    messageJson: r.message_json ?? {},
    deliveredAt: r.delivered_at,
    ackedAt: r.acked_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function upsertWebhookConfig(params: {
  pool: Pool;
  tenantId: string;
  provider: string;
  workspaceId: string;
  spaceId?: string | null;
  secretEnvKey?: string | null;
  secretId?: string | null;
  providerConfig?: any;
  toleranceSec?: number;
  deliveryMode?: "sync" | "async";
  maxAttempts?: number;
  backoffMsBase?: number;
}) {
  const providerConfig = params.providerConfig == null ? null : JSON.stringify(params.providerConfig);
  const secretEnvKey = params.secretEnvKey == null ? null : String(params.secretEnvKey);
  const secretId = params.secretId == null ? null : String(params.secretId);
  const res = await params.pool.query(
    `
      INSERT INTO channel_webhook_configs (tenant_id, provider, workspace_id, space_id, secret_env_key, secret_id, provider_config, tolerance_sec, delivery_mode, max_attempts, backoff_ms_base)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)
      ON CONFLICT (tenant_id, provider, workspace_id)
      DO UPDATE SET
        space_id = EXCLUDED.space_id,
        secret_env_key = EXCLUDED.secret_env_key,
        secret_id = EXCLUDED.secret_id,
        provider_config = EXCLUDED.provider_config,
        tolerance_sec = EXCLUDED.tolerance_sec,
        delivery_mode = EXCLUDED.delivery_mode,
        max_attempts = EXCLUDED.max_attempts,
        backoff_ms_base = EXCLUDED.backoff_ms_base,
        updated_at = now()
      RETURNING *
    `,
    [
      params.tenantId,
      params.provider,
      params.workspaceId,
      params.spaceId ?? null,
      secretEnvKey,
      secretId,
      providerConfig,
      params.toleranceSec ?? 300,
      params.deliveryMode ?? "sync",
      params.maxAttempts ?? 8,
      params.backoffMsBase ?? 500,
    ],
  );
  return toWebhookConfig(res.rows[0]);
}

export async function getWebhookConfig(params: { pool: Pool; tenantId: string; provider: string; workspaceId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM channel_webhook_configs
      WHERE tenant_id = $1 AND provider = $2 AND workspace_id = $3
      LIMIT 1
    `,
    [params.tenantId, params.provider, params.workspaceId],
  );
  if (!res.rowCount) return null;
  return toWebhookConfig(res.rows[0]);
}

export async function listWebhookConfigs(params: { pool: Pool; tenantId: string; provider?: string; workspaceId?: string; limit: number }) {
  const limit = Math.max(1, Math.min(200, params.limit));
  const where: string[] = ["tenant_id = $1"];
  const values: any[] = [params.tenantId];
  if (params.provider) {
    values.push(params.provider);
    where.push(`provider = $${values.length}`);
  }
  if (params.workspaceId) {
    values.push(params.workspaceId);
    where.push(`workspace_id = $${values.length}`);
  }
  values.push(limit);
  const res = await params.pool.query(
    `
      SELECT *
      FROM channel_webhook_configs
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT $${values.length}
    `,
    values,
  );
  return res.rows.map(toWebhookConfig);
}

export async function upsertChannelAccount(params: {
  pool: Pool;
  tenantId: string;
  provider: string;
  workspaceId: string;
  channelUserId: string;
  subjectId: string;
  spaceId?: string | null;
  status?: string;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO channel_accounts (tenant_id, provider, workspace_id, channel_user_id, subject_id, space_id, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (tenant_id, provider, workspace_id, channel_user_id)
      DO UPDATE SET subject_id = EXCLUDED.subject_id, space_id = EXCLUDED.space_id, status = EXCLUDED.status, updated_at = now()
      RETURNING *
    `,
    [params.tenantId, params.provider, params.workspaceId, params.channelUserId, params.subjectId, params.spaceId ?? null, params.status ?? "active"],
  );
  return toAccount(res.rows[0]);
}

export async function getChannelAccount(params: { pool: Pool; tenantId: string; provider: string; workspaceId: string; channelUserId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM channel_accounts
      WHERE tenant_id = $1 AND provider = $2 AND workspace_id = $3 AND channel_user_id = $4
      LIMIT 1
    `,
    [params.tenantId, params.provider, params.workspaceId, params.channelUserId],
  );
  if (!res.rowCount) return null;
  return toAccount(res.rows[0]);
}

export async function upsertChannelChatBinding(params: {
  pool: Pool;
  tenantId: string;
  provider: string;
  workspaceId: string;
  channelChatId: string;
  spaceId: string;
  defaultSubjectId?: string | null;
  status?: string;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO channel_chat_bindings (tenant_id, provider, workspace_id, channel_chat_id, space_id, default_subject_id, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (tenant_id, provider, workspace_id, channel_chat_id)
      DO UPDATE SET space_id = EXCLUDED.space_id, default_subject_id = EXCLUDED.default_subject_id, status = EXCLUDED.status, updated_at = now()
      RETURNING *
    `,
    [params.tenantId, params.provider, params.workspaceId, params.channelChatId, params.spaceId, params.defaultSubjectId ?? null, params.status ?? "active"],
  );
  return toChatBinding(res.rows[0]);
}

export async function getChannelChatBinding(params: { pool: Pool; tenantId: string; provider: string; workspaceId: string; channelChatId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM channel_chat_bindings
      WHERE tenant_id = $1 AND provider = $2 AND workspace_id = $3 AND channel_chat_id = $4
      LIMIT 1
    `,
    [params.tenantId, params.provider, params.workspaceId, params.channelChatId],
  );
  if (!res.rowCount) return null;
  return toChatBinding(res.rows[0]);
}

export async function insertIngressEvent(params: {
  pool: Pool;
  tenantId: string;
  provider: string;
  workspaceId: string;
  eventId: string;
  nonce: string;
  bodyDigest: string;
  bodyJson?: any;
  requestId: string;
  traceId: string;
  status: string;
}) {
  const res = await params.pool.query(
    `
      INSERT INTO channel_ingress_events (tenant_id, provider, workspace_id, event_id, nonce, body_digest, body_json, request_id, trace_id, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
      ON CONFLICT DO NOTHING
      RETURNING *
    `,
    [
      params.tenantId,
      params.provider,
      params.workspaceId,
      params.eventId,
      params.nonce,
      params.bodyDigest,
      params.bodyJson ? JSON.stringify(params.bodyJson) : null,
      params.requestId,
      params.traceId,
      params.status,
    ],
  );
  if (!res.rowCount) return null;
  return toIngressEvent(res.rows[0]);
}

export async function getIngressEventById(params: { pool: Pool; tenantId: string; id: string }) {
  const res = await params.pool.query("SELECT * FROM channel_ingress_events WHERE tenant_id = $1 AND id = $2 LIMIT 1", [params.tenantId, params.id]);
  if (!res.rowCount) return null;
  return toIngressEvent(res.rows[0]);
}

export async function markIngressQueued(params: { pool: Pool; tenantId: string; id: string }) {
  const res = await params.pool.query(
    `
      UPDATE channel_ingress_events
      SET status = 'queued', next_attempt_at = NULL, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status <> 'succeeded'
      RETURNING *
    `,
    [params.tenantId, params.id],
  );
  if (!res.rowCount) return null;
  return toIngressEvent(res.rows[0]);
}

export async function listIngressEventsByStatus(params: { pool: Pool; tenantId: string; status: string; limit: number; provider?: string; workspaceId?: string }) {
  const where: string[] = ["tenant_id = $1", "status = $2"];
  const args: any[] = [params.tenantId, params.status];
  let idx = 3;
  if (params.provider) {
    where.push(`provider = $${idx++}`);
    args.push(params.provider);
  }
  if (params.workspaceId) {
    where.push(`workspace_id = $${idx++}`);
    args.push(params.workspaceId);
  }
  args.push(params.limit);
  const res = await params.pool.query(
    `
      SELECT *
      FROM channel_ingress_events
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${idx++}
    `,
    args,
  );
  return res.rows.map(toIngressEvent);
}

export async function getIngressEvent(params: { pool: Pool; tenantId: string; provider: string; workspaceId: string; eventId?: string; nonce?: string }) {
  const where: string[] = ["tenant_id = $1", "provider = $2", "workspace_id = $3"];
  const args: any[] = [params.tenantId, params.provider, params.workspaceId];
  let idx = 4;
  if (params.eventId) {
    where.push(`event_id = $${idx++}`);
    args.push(params.eventId);
  }
  if (params.nonce) {
    where.push(`nonce = $${idx++}`);
    args.push(params.nonce);
  }
  const res = await params.pool.query(
    `
      SELECT *
      FROM channel_ingress_events
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT 1
    `,
    args,
  );
  if (!res.rowCount) return null;
  return toIngressEvent(res.rows[0]);
}

export async function finalizeIngressEvent(params: { pool: Pool; id: string; status: string; responseStatusCode: number; responseJson: any }) {
  const responseJson = params.responseJson ? JSON.stringify(params.responseJson) : null;
  const res = await params.pool.query(
    `
      UPDATE channel_ingress_events
      SET status = $2, response_status_code = $3, response_json = $4::jsonb, updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [params.id, params.status, params.responseStatusCode, responseJson],
  );
  return toIngressEvent(res.rows[0]);
}

export async function insertOutboxMessage(params: {
  pool: Pool;
  tenantId: string;
  provider: string;
  workspaceId: string;
  channelChatId: string;
  toUserId?: string | null;
  requestId: string;
  traceId: string;
  status: string;
  messageJson: any;
}) {
  const messageJson = JSON.stringify(params.messageJson ?? {});
  const res = await params.pool.query(
    `
      INSERT INTO channel_outbox_messages (tenant_id, provider, workspace_id, channel_chat_id, to_user_id, request_id, trace_id, status, message_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
      RETURNING *
    `,
    [params.tenantId, params.provider, params.workspaceId, params.channelChatId, params.toUserId ?? null, params.requestId, params.traceId, params.status, messageJson],
  );
  return toOutboxMessage(res.rows[0]);
}

export async function listUndeliveredOutboxMessages(params: { pool: Pool; tenantId: string; provider: string; workspaceId: string; channelChatId: string; limit: number }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM channel_outbox_messages
      WHERE tenant_id = $1 AND provider = $2 AND workspace_id = $3 AND channel_chat_id = $4 AND delivered_at IS NULL
      ORDER BY created_at ASC
      LIMIT $5
    `,
    [params.tenantId, params.provider, params.workspaceId, params.channelChatId, params.limit],
  );
  return res.rows.map(toOutboxMessage);
}

export async function markOutboxDelivered(params: { pool: Pool; tenantId: string; ids: string[] }) {
  if (params.ids.length === 0) return [];
  const res = await params.pool.query(
    `
      UPDATE channel_outbox_messages
      SET delivered_at = COALESCE(delivered_at, now()), updated_at = now()
      WHERE tenant_id = $1 AND id = ANY($2::uuid[])
      RETURNING *
    `,
    [params.tenantId, params.ids],
  );
  return res.rows.map(toOutboxMessage);
}

export async function markOutboxAcked(params: { pool: Pool; tenantId: string; ids: string[] }) {
  if (params.ids.length === 0) return [];
  const res = await params.pool.query(
    `
      UPDATE channel_outbox_messages
      SET acked_at = COALESCE(acked_at, now()), updated_at = now()
      WHERE tenant_id = $1 AND id = ANY($2::uuid[])
      RETURNING *
    `,
    [params.tenantId, params.ids],
  );
  return res.rows.map(toOutboxMessage);
}

export async function getLatestOutboxByRequestId(params: { pool: Pool; tenantId: string; requestId: string }) {
  const res = await params.pool.query(
    `
      SELECT *
      FROM channel_outbox_messages
      WHERE tenant_id = $1 AND request_id = $2
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [params.tenantId, params.requestId],
  );
  if (!res.rowCount) return null;
  return toOutboxMessage(res.rows[0]);
}
