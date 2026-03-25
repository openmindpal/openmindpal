CREATE TABLE IF NOT EXISTS policy_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  version INT NOT NULL,
  status TEXT NOT NULL,
  policy_json JSONB NOT NULL,
  digest TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ NULL,
  UNIQUE (tenant_id, name, version)
);

CREATE INDEX IF NOT EXISTS policy_versions_tenant_name_status_version_idx
  ON policy_versions (tenant_id, name, status, version DESC);

ALTER TABLE policy_snapshots
  ADD COLUMN IF NOT EXISTS policy_name TEXT NOT NULL DEFAULT 'default';

ALTER TABLE policy_snapshots
  ADD COLUMN IF NOT EXISTS policy_version INT NOT NULL DEFAULT 1;

ALTER TABLE policy_snapshots
  ADD COLUMN IF NOT EXISTS policy_cache_epoch JSONB NULL;

ALTER TABLE policy_snapshots
  ADD COLUMN IF NOT EXISTS explain_v1 JSONB NULL;

CREATE INDEX IF NOT EXISTS policy_snapshots_tenant_policyref_time_idx
  ON policy_snapshots (tenant_id, policy_name, policy_version, created_at DESC, snapshot_id DESC);

