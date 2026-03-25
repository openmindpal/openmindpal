CREATE TABLE IF NOT EXISTS device_records (
  device_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  owner_scope TEXT NOT NULL,
  owner_subject_id TEXT NULL,
  space_id TEXT NULL REFERENCES spaces(id),
  device_type TEXT NOT NULL,
  os TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  status TEXT NOT NULL,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  device_token_hash TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_records_owner_idx
  ON device_records (tenant_id, owner_scope, owner_subject_id, space_id, enrolled_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS device_records_token_hash_unique
  ON device_records (device_token_hash)
  WHERE device_token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS device_pairings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  device_id UUID NOT NULL REFERENCES device_records(device_id),
  code_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS device_pairings_code_hash_unique
  ON device_pairings (code_hash);

CREATE INDEX IF NOT EXISTS device_pairings_expiry_idx
  ON device_pairings (expires_at);

CREATE TABLE IF NOT EXISTS device_policies (
  device_id UUID PRIMARY KEY REFERENCES device_records(device_id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  allowed_tools JSONB NULL,
  file_policy JSONB NULL,
  network_policy JSONB NULL,
  limits JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

