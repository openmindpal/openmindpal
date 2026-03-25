CREATE TABLE IF NOT EXISTS oauth_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  subject_id TEXT NOT NULL,
  connector_instance_id UUID NOT NULL REFERENCES connector_instances(id),
  provider TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  nonce_hash TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS oauth_states_state_hash_unique
  ON oauth_states (state_hash);

CREATE INDEX IF NOT EXISTS oauth_states_expiry_idx
  ON oauth_states (expires_at);

CREATE TABLE IF NOT EXISTS oauth_grants (
  grant_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  connector_instance_id UUID NOT NULL REFERENCES connector_instances(id),
  provider TEXT NOT NULL,
  secret_record_id UUID NOT NULL REFERENCES secret_records(id),
  scopes TEXT NULL,
  token_expires_at TIMESTAMPTZ NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS oauth_grants_unique_instance_provider
  ON oauth_grants (tenant_id, connector_instance_id, provider);

CREATE INDEX IF NOT EXISTS oauth_grants_by_secret
  ON oauth_grants (tenant_id, secret_record_id);

