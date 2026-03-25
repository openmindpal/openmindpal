ALTER TABLE governance_changesets
  ADD COLUMN IF NOT EXISTS canary_targets JSONB NULL;

ALTER TABLE governance_changesets
  ADD COLUMN IF NOT EXISTS canary_released_at TIMESTAMPTZ NULL;

ALTER TABLE governance_changesets
  ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ NULL;

CREATE TABLE IF NOT EXISTS tool_active_overrides (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active_tool_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id, name)
);

CREATE INDEX IF NOT EXISTS tool_active_overrides_lookup_idx
  ON tool_active_overrides (tenant_id, name, space_id);

CREATE INDEX IF NOT EXISTS governance_changesets_canary_idx
  ON governance_changesets (tenant_id, canary_released_at DESC);

