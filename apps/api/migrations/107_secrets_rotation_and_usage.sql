ALTER TABLE secret_records
  ADD COLUMN IF NOT EXISTS credential_version INT NOT NULL DEFAULT 1;

ALTER TABLE secret_records
  ADD COLUMN IF NOT EXISTS rotated_from_id UUID NULL;

ALTER TABLE secret_records
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE secret_records
  ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ NULL;

ALTER TABLE secret_records
  ADD COLUMN IF NOT EXISTS grace_period_sec INT NULL;

UPDATE secret_records
SET activated_at = COALESCE(activated_at, created_at)
WHERE activated_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS secret_records_unique_instance_credential_version
  ON secret_records (tenant_id, connector_instance_id, credential_version);

CREATE UNIQUE INDEX IF NOT EXISTS secret_records_unique_active_per_instance
  ON secret_records (tenant_id, connector_instance_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS secret_usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  connector_instance_id UUID NOT NULL,
  secret_id UUID NOT NULL,
  credential_version INT NOT NULL,
  scene TEXT NOT NULL,
  result TEXT NOT NULL,
  trace_id TEXT NULL,
  request_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS secret_usage_events_by_connector_time
  ON secret_usage_events (tenant_id, connector_instance_id, created_at DESC);

CREATE INDEX IF NOT EXISTS secret_usage_events_by_secret_time
  ON secret_usage_events (tenant_id, secret_id, created_at DESC);

