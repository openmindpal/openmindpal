CREATE TABLE IF NOT EXISTS channel_outbox_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  provider TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  channel_chat_id TEXT NOT NULL,
  to_user_id TEXT NULL,
  request_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  status TEXT NOT NULL,
  message_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  delivered_at TIMESTAMPTZ NULL,
  acked_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS channel_outbox_poll_idx
  ON channel_outbox_messages (tenant_id, provider, workspace_id, channel_chat_id, delivered_at, created_at ASC);

CREATE INDEX IF NOT EXISTS channel_outbox_request_idx
  ON channel_outbox_messages (tenant_id, request_id, created_at DESC);

