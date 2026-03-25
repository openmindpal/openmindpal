CREATE TABLE IF NOT EXISTS workbench_plugins (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  workbench_key TEXT NOT NULL,
  display_name JSONB NULL,
  description JSONB NULL,
  status TEXT NOT NULL DEFAULT 'enabled',
  created_by_subject_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope_type, scope_id, workbench_key)
);

CREATE TABLE IF NOT EXISTS workbench_plugin_versions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  workbench_key TEXT NOT NULL,
  version INT NOT NULL,
  status TEXT NOT NULL,
  artifact_ref TEXT NOT NULL,
  manifest_json JSONB NOT NULL,
  manifest_digest TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_subject_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope_type, scope_id, workbench_key, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS workbench_plugin_versions_one_draft_idx
  ON workbench_plugin_versions (tenant_id, scope_type, scope_id, workbench_key)
  WHERE status = 'draft';

CREATE INDEX IF NOT EXISTS workbench_plugin_versions_latest_released_idx
  ON workbench_plugin_versions (tenant_id, scope_type, scope_id, workbench_key, version DESC)
  WHERE status = 'released';

CREATE TABLE IF NOT EXISTS workbench_active_versions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  workbench_key TEXT NOT NULL,
  active_version INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope_type, scope_id, workbench_key)
);

CREATE TABLE IF NOT EXISTS workbench_canary_configs (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  workbench_key TEXT NOT NULL,
  canary_version INT NOT NULL,
  canary_subject_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope_type, scope_id, workbench_key)
);
