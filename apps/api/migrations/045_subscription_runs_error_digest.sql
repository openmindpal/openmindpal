ALTER TABLE subscription_runs
  ADD COLUMN IF NOT EXISTS error_digest JSONB NULL;

ALTER TABLE subscription_runs
  ADD COLUMN IF NOT EXISTS backoff_ms INT NULL;

