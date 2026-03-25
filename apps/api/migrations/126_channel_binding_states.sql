-- Channel binding states: QR-code / OAuth-based automatic channel_account mapping
CREATE TABLE IF NOT EXISTS channel_binding_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  provider TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  target_subject_id TEXT NULL,            -- pre-assigned subject; NULL = use logged-in user
  state_hash TEXT NOT NULL,
  label TEXT NULL,                         -- admin-friendly label, e.g. "飞书研发群"
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | consumed | expired
  bound_channel_user_id TEXT NULL,         -- filled after successful binding
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS channel_binding_states_hash_unique
  ON channel_binding_states (state_hash);

CREATE INDEX IF NOT EXISTS channel_binding_states_tenant_status_idx
  ON channel_binding_states (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS channel_binding_states_tenant_provider_idx
  ON channel_binding_states (tenant_id, provider, workspace_id, created_at DESC);
