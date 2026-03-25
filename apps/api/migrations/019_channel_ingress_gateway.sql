CREATE TABLE IF NOT EXISTS channel_webhook_configs (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  provider TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  space_id TEXT NULL,
  secret_env_key TEXT NOT NULL,
  tolerance_sec INT NOT NULL DEFAULT 300,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider, workspace_id)
);

CREATE INDEX IF NOT EXISTS channel_webhook_configs_lookup_idx
  ON channel_webhook_configs (tenant_id, provider, workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS channel_accounts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  provider TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  channel_user_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  space_id TEXT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider, workspace_id, channel_user_id)
);

CREATE INDEX IF NOT EXISTS channel_accounts_lookup_idx
  ON channel_accounts (tenant_id, provider, workspace_id, subject_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS channel_chat_bindings (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  provider TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  channel_chat_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  default_subject_id TEXT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider, workspace_id, channel_chat_id)
);

CREATE INDEX IF NOT EXISTS channel_chat_bindings_lookup_idx
  ON channel_chat_bindings (tenant_id, provider, workspace_id, space_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS channel_ingress_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  provider TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  body_digest TEXT NOT NULL,
  request_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  status TEXT NOT NULL,
  response_status_code INT NULL,
  response_json JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, workspace_id, event_id),
  UNIQUE (tenant_id, provider, workspace_id, nonce)
);

CREATE INDEX IF NOT EXISTS channel_ingress_events_status_idx
  ON channel_ingress_events (tenant_id, provider, workspace_id, status, created_at DESC);

