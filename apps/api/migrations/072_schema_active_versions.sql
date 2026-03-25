CREATE TABLE IF NOT EXISTS schema_active_versions (
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active_version INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS schema_active_overrides (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active_version INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id, name)
);

