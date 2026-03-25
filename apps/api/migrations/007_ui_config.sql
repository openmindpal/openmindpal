CREATE TABLE IF NOT EXISTS page_templates (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope_type, scope_id, name)
);

CREATE TABLE IF NOT EXISTS page_template_versions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version INT NOT NULL,
  status TEXT NOT NULL,
  page_type TEXT NOT NULL,
  title JSONB NULL,
  params JSONB NULL,
  data_bindings JSONB NULL,
  action_bindings JSONB NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope_type, scope_id, name, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS page_template_versions_one_draft_idx
  ON page_template_versions (tenant_id, scope_type, scope_id, name)
  WHERE status = 'draft';

CREATE INDEX IF NOT EXISTS page_template_versions_latest_released_idx
  ON page_template_versions (tenant_id, scope_type, scope_id, name, version DESC)
  WHERE status = 'released';

