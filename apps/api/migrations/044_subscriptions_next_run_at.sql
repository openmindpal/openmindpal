ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS subscriptions_next_run_idx
  ON subscriptions (tenant_id, status, next_run_at);

