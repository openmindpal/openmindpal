CREATE TABLE IF NOT EXISTS ui_component_registry_versions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  version INT NOT NULL,
  status TEXT NOT NULL,
  component_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by_subject_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (scope_type IN ('tenant', 'space')),
  CHECK (status IN ('draft', 'released')),
  CHECK ((status = 'draft' AND version = 0) OR (status = 'released' AND version > 0)),
  PRIMARY KEY (tenant_id, scope_type, scope_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS ui_component_registry_versions_one_draft_idx
  ON ui_component_registry_versions (tenant_id, scope_type, scope_id)
  WHERE status = 'draft';

CREATE INDEX IF NOT EXISTS ui_component_registry_versions_latest_released_idx
  ON ui_component_registry_versions (tenant_id, scope_type, scope_id, version DESC)
  WHERE status = 'released';

INSERT INTO permissions (resource_type, action)
VALUES
  ('governance', 'ui.component_registry.read'),
  ('governance', 'ui.component_registry.write'),
  ('governance', 'ui.component_registry.publish'),
  ('governance', 'ui.component_registry.rollback')
ON CONFLICT (resource_type, action) DO NOTHING;
