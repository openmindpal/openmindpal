CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  provider TEXT NOT NULL,
  connector_instance_id UUID NULL REFERENCES connector_instances(id),
  status TEXT NOT NULL,
  poll_interval_sec INT NOT NULL,
  watermark JSONB NULL,
  last_run_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscriptions_scope_status_idx
  ON subscriptions (tenant_id, space_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS subscriptions_due_idx
  ON subscriptions (tenant_id, status, last_run_at);

CREATE TABLE IF NOT EXISTS subscription_runs (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES subscriptions(subscription_id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  status TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  watermark_before JSONB NULL,
  watermark_after JSONB NULL,
  event_count INT NOT NULL DEFAULT 0,
  error_category TEXT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscription_runs_by_sub_time_idx
  ON subscription_runs (tenant_id, subscription_id, started_at DESC);

