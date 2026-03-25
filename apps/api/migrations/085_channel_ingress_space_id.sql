ALTER TABLE channel_ingress_events
  ADD COLUMN IF NOT EXISTS space_id TEXT NULL;

CREATE INDEX IF NOT EXISTS channel_ingress_events_space_idx
  ON channel_ingress_events (tenant_id, space_id, created_at DESC);

