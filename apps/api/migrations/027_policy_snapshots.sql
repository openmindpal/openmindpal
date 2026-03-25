CREATE TABLE IF NOT EXISTS policy_snapshots (
  snapshot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  subject_id TEXT NOT NULL,
  space_id TEXT NULL,
  resource_type TEXT NOT NULL,
  action TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NULL,
  matched_rules JSONB NULL,
  row_filters JSONB NULL,
  field_rules JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS policy_snapshots_tenant_subject_time_idx
  ON policy_snapshots (tenant_id, subject_id, created_at DESC);

CREATE INDEX IF NOT EXISTS policy_snapshots_tenant_space_time_idx
  ON policy_snapshots (tenant_id, space_id, created_at DESC);

