CREATE TABLE IF NOT EXISTS backups (
  backup_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  status TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'space',
  schema_name TEXT NOT NULL,
  entity_names JSONB NULL,
  format TEXT NOT NULL,
  backup_artifact_id UUID NULL REFERENCES artifacts(artifact_id),
  report_artifact_id UUID NULL REFERENCES artifacts(artifact_id),
  policy_snapshot_ref TEXT NULL,
  run_id UUID NULL REFERENCES runs(run_id),
  step_id UUID NULL REFERENCES steps(step_id),
  created_by_subject_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS backups_scope_time_idx
  ON backups (tenant_id, space_id, created_at DESC);

CREATE INDEX IF NOT EXISTS backups_status_time_idx
  ON backups (tenant_id, space_id, status, created_at DESC);

