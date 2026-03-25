ALTER TABLE channel_webhook_configs
  ADD COLUMN IF NOT EXISTS delivery_mode TEXT NOT NULL DEFAULT 'sync';

ALTER TABLE channel_webhook_configs
  ADD COLUMN IF NOT EXISTS max_attempts INT NOT NULL DEFAULT 8;

ALTER TABLE channel_webhook_configs
  ADD COLUMN IF NOT EXISTS backoff_ms_base INT NOT NULL DEFAULT 500;

ALTER TABLE channel_ingress_events
  ADD COLUMN IF NOT EXISTS body_json JSONB NULL;

ALTER TABLE channel_ingress_events
  ADD COLUMN IF NOT EXISTS attempt_count INT NOT NULL DEFAULT 0;

ALTER TABLE channel_ingress_events
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NULL;

ALTER TABLE channel_ingress_events
  ADD COLUMN IF NOT EXISTS last_error_category TEXT NULL;

ALTER TABLE channel_ingress_events
  ADD COLUMN IF NOT EXISTS last_error_digest JSONB NULL;

ALTER TABLE channel_ingress_events
  ADD COLUMN IF NOT EXISTS deadlettered_at TIMESTAMPTZ NULL;

