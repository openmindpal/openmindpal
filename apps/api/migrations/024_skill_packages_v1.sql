ALTER TABLE tool_versions
  ADD COLUMN IF NOT EXISTS artifact_ref TEXT NULL;

CREATE INDEX IF NOT EXISTS tool_versions_tenant_artifact_idx
  ON tool_versions (tenant_id, name, artifact_ref);

