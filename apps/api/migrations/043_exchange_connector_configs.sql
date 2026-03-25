CREATE TABLE IF NOT EXISTS exchange_connector_configs (
  connector_instance_id UUID PRIMARY KEY REFERENCES connector_instances(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  oauth_grant_id UUID NOT NULL REFERENCES oauth_grants(grant_id),
  mailbox TEXT NOT NULL,
  fetch_window_days INT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS exchange_connector_configs_scope_idx
  ON exchange_connector_configs (tenant_id, mailbox);
