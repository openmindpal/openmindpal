CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  type TEXT NOT NULL,
  format TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INT NOT NULL,
  content_text TEXT NOT NULL,
  source JSONB NULL,
  run_id UUID NULL REFERENCES runs(run_id),
  step_id UUID NULL REFERENCES steps(step_id),
  created_by_subject_id TEXT NULL,
  expires_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS artifacts_scope_time_idx
  ON artifacts (tenant_id, space_id, created_at DESC);

CREATE INDEX IF NOT EXISTS artifacts_type_time_idx
  ON artifacts (tenant_id, space_id, type, created_at DESC);

