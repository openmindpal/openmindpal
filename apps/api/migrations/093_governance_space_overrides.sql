CREATE TABLE IF NOT EXISTS routing_policies_overrides (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  purpose TEXT NOT NULL,
  primary_model_ref TEXT NOT NULL,
  fallback_model_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id, purpose)
);

CREATE INDEX IF NOT EXISTS routing_policies_overrides_lookup_idx
  ON routing_policies_overrides (tenant_id, space_id, purpose);

CREATE TABLE IF NOT EXISTS tool_limits_overrides (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  tool_ref TEXT NOT NULL,
  default_max_concurrency INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id, tool_ref)
);

CREATE INDEX IF NOT EXISTS tool_limits_overrides_lookup_idx
  ON tool_limits_overrides (tenant_id, space_id, tool_ref);
