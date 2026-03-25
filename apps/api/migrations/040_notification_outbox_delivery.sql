ALTER TABLE notification_outbox
  ADD COLUMN IF NOT EXISTS connector_instance_id UUID NULL REFERENCES connector_instances(id);

ALTER TABLE notification_outbox
  ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'queued';

ALTER TABLE notification_outbox
  ADD COLUMN IF NOT EXISTS attempt_count INT NOT NULL DEFAULT 0;

ALTER TABLE notification_outbox
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NULL;

ALTER TABLE notification_outbox
  ADD COLUMN IF NOT EXISTS last_error_category TEXT NULL;

ALTER TABLE notification_outbox
  ADD COLUMN IF NOT EXISTS last_error_digest JSONB NULL;

ALTER TABLE notification_outbox
  ADD COLUMN IF NOT EXISTS deadlettered_at TIMESTAMPTZ NULL;

ALTER TABLE notification_outbox
  ADD COLUMN IF NOT EXISTS content_ciphertext JSONB NULL;

UPDATE notification_outbox
SET delivery_status = status
WHERE delivery_status IS NULL;

CREATE INDEX IF NOT EXISTS notification_outbox_delivery_status_idx
  ON notification_outbox (tenant_id, space_id, delivery_status, created_at DESC);

