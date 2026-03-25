CREATE TABLE IF NOT EXISTS policy_cache_epochs (
  tenant_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('tenant','space')),
  scope_id TEXT NOT NULL,
  epoch BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS policy_cache_epochs_tenant_idx
  ON policy_cache_epochs (tenant_id, updated_at DESC);
