CREATE TABLE IF NOT EXISTS partition_keys (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  key_version INT NOT NULL,
  status TEXT NOT NULL,
  encrypted_key JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ NULL,
  PRIMARY KEY (tenant_id, scope_type, scope_id, key_version)
);

CREATE INDEX IF NOT EXISTS partition_keys_active_idx
  ON partition_keys (tenant_id, scope_type, scope_id, status, key_version DESC);

ALTER TABLE secret_records
  ADD COLUMN IF NOT EXISTS enc_format TEXT NOT NULL DEFAULT 'legacy.a256gcm';

ALTER TABLE secret_records
  ADD COLUMN IF NOT EXISTS key_ref JSONB NULL;

