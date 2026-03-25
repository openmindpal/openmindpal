ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS sealed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS sealed_schema_version INT NULL,
  ADD COLUMN IF NOT EXISTS sealed_input_digest JSONB NULL,
  ADD COLUMN IF NOT EXISTS sealed_output_digest JSONB NULL,
  ADD COLUMN IF NOT EXISTS nondeterminism_policy JSONB NULL,
  ADD COLUMN IF NOT EXISTS supply_chain JSONB NULL,
  ADD COLUMN IF NOT EXISTS isolation JSONB NULL;

ALTER TABLE steps
  ADD COLUMN IF NOT EXISTS sealed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS sealed_schema_version INT NULL,
  ADD COLUMN IF NOT EXISTS sealed_input_digest JSONB NULL,
  ADD COLUMN IF NOT EXISTS sealed_output_digest JSONB NULL,
  ADD COLUMN IF NOT EXISTS nondeterminism_policy JSONB NULL,
  ADD COLUMN IF NOT EXISTS supply_chain JSONB NULL,
  ADD COLUMN IF NOT EXISTS isolation JSONB NULL;

ALTER TABLE tool_versions
  ADD COLUMN IF NOT EXISTS sbom_summary JSONB NULL,
  ADD COLUMN IF NOT EXISTS sbom_digest TEXT NULL;

CREATE INDEX IF NOT EXISTS runs_tenant_sealed_at_idx
  ON runs (tenant_id, sealed_at DESC)
  WHERE sealed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS steps_run_sealed_at_idx
  ON steps (run_id, sealed_at DESC)
  WHERE sealed_at IS NOT NULL;

