ALTER TABLE channel_outbox_messages
  ADD COLUMN IF NOT EXISTS attempt_count INT NOT NULL DEFAULT 0;

ALTER TABLE channel_outbox_messages
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NULL;

ALTER TABLE channel_outbox_messages
  ADD COLUMN IF NOT EXISTS last_error_category TEXT NULL;

ALTER TABLE channel_outbox_messages
  ADD COLUMN IF NOT EXISTS last_error_digest JSONB NULL;

ALTER TABLE channel_outbox_messages
  ADD COLUMN IF NOT EXISTS deadlettered_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS channel_outbox_status_attempt_idx
  ON channel_outbox_messages (tenant_id, status, next_attempt_at, created_at ASC);

CREATE INDEX IF NOT EXISTS channel_outbox_chat_time_idx
  ON channel_outbox_messages (tenant_id, provider, workspace_id, channel_chat_id, created_at DESC);

