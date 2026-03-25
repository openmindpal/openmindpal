CREATE TABLE IF NOT EXISTS smtp_connector_configs (
  connector_instance_id UUID PRIMARY KEY REFERENCES connector_instances(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  host TEXT NOT NULL,
  port INT NOT NULL,
  use_tls BOOLEAN NOT NULL,
  username TEXT NOT NULL,
  password_secret_id UUID NOT NULL REFERENCES secret_records(id),
  from_address TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS smtp_connector_configs_scope_idx
  ON smtp_connector_configs (tenant_id, host);

