CREATE TABLE IF NOT EXISTS trigger_definitions (
  trigger_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'enabled',
  cron_expr TEXT NULL,
  cron_tz TEXT NULL DEFAULT 'UTC',
  cron_misfire_policy TEXT NOT NULL DEFAULT 'skip',
  next_fire_at TIMESTAMPTZ NULL,
  event_source TEXT NULL,
  event_filter_json JSONB NULL,
  event_watermark_json JSONB NULL,
  target_kind TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  input_mapping_json JSONB NULL,
  idempotency_key_template TEXT NULL,
  idempotency_window_sec INT NOT NULL DEFAULT 3600,
  rate_limit_per_min INT NOT NULL DEFAULT 60,
  last_run_at TIMESTAMPTZ NULL,
  created_by_subject_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trigger_definitions_tenant_status_idx
  ON trigger_definitions (tenant_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS trigger_definitions_tenant_type_idx
  ON trigger_definitions (tenant_id, type, updated_at DESC);

CREATE INDEX IF NOT EXISTS trigger_definitions_next_fire_idx
  ON trigger_definitions (tenant_id, next_fire_at ASC)
  WHERE next_fire_at IS NOT NULL AND status = 'enabled' AND type = 'cron';

CREATE TABLE IF NOT EXISTS trigger_runs (
  trigger_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  trigger_id UUID NOT NULL REFERENCES trigger_definitions(trigger_id),
  status TEXT NOT NULL DEFAULT 'queued',
  scheduled_at TIMESTAMPTZ NULL,
  fired_at TIMESTAMPTZ NULL,
  matched BOOLEAN NULL,
  match_reason TEXT NULL,
  match_digest JSONB NULL,
  idempotency_key TEXT NULL,
  event_ref_json JSONB NULL,
  job_id UUID NULL REFERENCES jobs(job_id),
  run_id UUID NULL REFERENCES runs(run_id),
  step_id UUID NULL REFERENCES steps(step_id),
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trigger_runs_trigger_time_idx
  ON trigger_runs (tenant_id, trigger_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS trigger_runs_dedupe_idx
  ON trigger_runs (trigger_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS workflow_step_compensations (
  compensation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  step_id UUID NOT NULL REFERENCES steps(step_id),
  compensation_job_id UUID NOT NULL REFERENCES jobs(job_id),
  compensation_run_id UUID NOT NULL REFERENCES runs(run_id),
  status TEXT NOT NULL DEFAULT 'queued',
  created_by_subject_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_step_compensations_step_time_idx
  ON workflow_step_compensations (tenant_id, step_id, created_at DESC);
