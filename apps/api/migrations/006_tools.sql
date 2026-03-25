CREATE TABLE IF NOT EXISTS tool_definitions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  display_name JSONB NULL,
  description JSONB NULL,
  risk_level TEXT NOT NULL DEFAULT 'low',
  approval_required BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS tool_versions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  version INT NOT NULL,
  tool_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'released',
  deps_digest TEXT NULL,
  input_schema JSONB NULL,
  output_schema JSONB NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, name, version),
  UNIQUE (tenant_id, tool_ref)
);

CREATE INDEX IF NOT EXISTS tool_versions_tenant_name_version_idx
  ON tool_versions (tenant_id, name, version DESC);

ALTER TABLE steps
  ADD COLUMN IF NOT EXISTS input_digest JSONB NULL;

ALTER TABLE steps
  ADD COLUMN IF NOT EXISTS output_digest JSONB NULL;

