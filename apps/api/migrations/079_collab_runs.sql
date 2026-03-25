CREATE TABLE IF NOT EXISTS collab_runs (
  collab_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  task_id UUID NOT NULL REFERENCES tasks(task_id),
  created_by_subject_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  roles_json JSONB NULL,
  limits_json JSONB NULL,
  primary_run_id UUID NULL REFERENCES runs(run_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collab_runs_tenant_space_time_idx
  ON collab_runs (tenant_id, space_id, created_at DESC);

CREATE INDEX IF NOT EXISTS collab_runs_task_time_idx
  ON collab_runs (task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS collab_run_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  collab_run_id UUID NOT NULL REFERENCES collab_runs(collab_run_id),
  task_id UUID NOT NULL REFERENCES tasks(task_id),
  type TEXT NOT NULL,
  actor_role TEXT NULL,
  run_id UUID NULL REFERENCES runs(run_id),
  step_id UUID NULL REFERENCES steps(step_id),
  payload_digest JSONB NULL,
  policy_snapshot_ref TEXT NULL,
  correlation_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE collab_run_events
  ADD COLUMN IF NOT EXISTS policy_snapshot_ref TEXT NULL;

ALTER TABLE collab_run_events
  ADD COLUMN IF NOT EXISTS correlation_id TEXT NULL;

CREATE INDEX IF NOT EXISTS collab_run_events_run_time_idx
  ON collab_run_events (collab_run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS collab_run_events_run_corr_time_idx
  ON collab_run_events (collab_run_id, correlation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS collab_run_events_task_time_idx
  ON collab_run_events (task_id, created_at DESC);

INSERT INTO permissions (resource_type, action)
VALUES
  ('agent_runtime', 'collab.create'),
  ('agent_runtime', 'collab.read'),
  ('agent_runtime', 'collab.events')
ON CONFLICT (resource_type, action) DO NOTHING;
