CREATE TABLE IF NOT EXISTS routing_policies (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  purpose TEXT NOT NULL,
  primary_model_ref TEXT NOT NULL,
  fallback_model_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, purpose)
);

CREATE INDEX IF NOT EXISTS routing_policies_lookup_idx
  ON routing_policies (tenant_id, purpose);

CREATE TABLE IF NOT EXISTS quota_limits (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  model_chat_rpm INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS quota_limits_lookup_idx
  ON quota_limits (tenant_id, scope_type, scope_id);

CREATE TABLE IF NOT EXISTS tool_limits (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  tool_ref TEXT NOT NULL,
  default_max_concurrency INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, tool_ref)
);

CREATE INDEX IF NOT EXISTS tool_limits_lookup_idx
  ON tool_limits (tenant_id, tool_ref);
