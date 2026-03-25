CREATE TABLE IF NOT EXISTS collab_envelopes (
  envelope_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  collab_run_id UUID NOT NULL REFERENCES collab_runs(collab_run_id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  from_role TEXT NOT NULL,
  to_role TEXT NULL,
  broadcast BOOLEAN NOT NULL DEFAULT false,
  kind TEXT NOT NULL,
  correlation_id TEXT NULL,
  policy_snapshot_ref TEXT NULL,
  payload_digest JSONB NOT NULL,
  payload_redacted JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE collab_envelopes
  ADD COLUMN IF NOT EXISTS correlation_id TEXT NULL;

ALTER TABLE collab_envelopes
  ADD COLUMN IF NOT EXISTS policy_snapshot_ref TEXT NULL;

CREATE INDEX IF NOT EXISTS collab_envelopes_run_time_idx
  ON collab_envelopes (collab_run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS collab_envelopes_run_to_time_idx
  ON collab_envelopes (collab_run_id, to_role, created_at DESC);

CREATE INDEX IF NOT EXISTS collab_envelopes_run_from_time_idx
  ON collab_envelopes (collab_run_id, from_role, created_at DESC);

CREATE INDEX IF NOT EXISTS collab_envelopes_run_corr_time_idx
  ON collab_envelopes (collab_run_id, correlation_id, created_at DESC);

INSERT INTO permissions (resource_type, action)
VALUES
  ('agent_runtime', 'collab.envelopes.write'),
  ('agent_runtime', 'collab.envelopes.read'),
  ('agent_runtime', 'collab.arbiter.commit')
ON CONFLICT (resource_type, action) DO NOTHING;
