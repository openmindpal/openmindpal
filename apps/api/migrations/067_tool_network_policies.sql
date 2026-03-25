CREATE TABLE IF NOT EXISTS tool_network_policies (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  tool_ref TEXT NOT NULL,
  allowed_domains JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope_type, scope_id, tool_ref)
);

CREATE INDEX IF NOT EXISTS tool_network_policies_lookup_idx
  ON tool_network_policies (tenant_id, scope_type, scope_id, tool_ref);

