CREATE TABLE IF NOT EXISTS oauth_provider_configs (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  connector_instance_id UUID NOT NULL REFERENCES connector_instances(id),
  provider TEXT NOT NULL,
  authorize_endpoint TEXT NOT NULL,
  token_endpoint TEXT NOT NULL,
  refresh_endpoint TEXT NULL,
  userinfo_endpoint TEXT NULL,
  client_id TEXT NOT NULL,
  client_secret_secret_id UUID NOT NULL REFERENCES secret_records(id),
  scopes TEXT NULL,
  pkce_enabled BOOLEAN NOT NULL DEFAULT true,
  token_auth_method TEXT NOT NULL DEFAULT 'client_secret_post',
  extra_authorize_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  extra_token_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connector_instance_id, provider)
);

CREATE INDEX IF NOT EXISTS oauth_provider_configs_lookup_idx
  ON oauth_provider_configs (tenant_id, connector_instance_id, provider);
