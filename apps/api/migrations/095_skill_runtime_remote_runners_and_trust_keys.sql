CREATE TABLE IF NOT EXISTS skill_runtime_runners (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  runner_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  auth_secret_id TEXT NULL,
  capabilities JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, runner_id)
);

CREATE INDEX IF NOT EXISTS skill_runtime_runners_enabled_idx
  ON skill_runtime_runners (tenant_id, enabled);

CREATE TABLE IF NOT EXISTS skill_trusted_keys (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  key_id TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  rotated_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key_id)
);

CREATE INDEX IF NOT EXISTS skill_trusted_keys_status_idx
  ON skill_trusted_keys (tenant_id, status);

