CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  schema_name TEXT NOT NULL,
  target_version INT NOT NULL,
  kind TEXT NOT NULL,
  plan_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  created_by_subject_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS schema_migrations_tenant_schema_time_idx
  ON schema_migrations (tenant_id, schema_name, created_at DESC);

CREATE INDEX IF NOT EXISTS schema_migrations_scope_time_idx
  ON schema_migrations (tenant_id, scope_type, scope_id, created_at DESC);

CREATE TABLE IF NOT EXISTS schema_migration_runs (
  migration_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  migration_id UUID NOT NULL REFERENCES schema_migrations(migration_id),
  status TEXT NOT NULL DEFAULT 'queued',
  progress_json JSONB NULL,
  job_id UUID NULL REFERENCES jobs(job_id),
  run_id UUID NULL REFERENCES runs(run_id),
  step_id UUID NULL REFERENCES steps(step_id),
  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  canceled_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS schema_migration_runs_tenant_migration_time_idx
  ON schema_migration_runs (tenant_id, migration_id, created_at DESC);

