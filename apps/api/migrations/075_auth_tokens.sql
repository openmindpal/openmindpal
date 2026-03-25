CREATE TABLE IF NOT EXISTS auth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  subject_id TEXT NOT NULL REFERENCES subjects(id),
  name TEXT NULL,
  token_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS auth_tokens_tenant_subject_created_idx
  ON auth_tokens (tenant_id, subject_id, created_at DESC);

CREATE INDEX IF NOT EXISTS auth_tokens_tenant_space_created_idx
  ON auth_tokens (tenant_id, space_id, created_at DESC);

INSERT INTO permissions (resource_type, action)
VALUES
  ('auth', 'token.self'),
  ('auth', 'token.admin')
ON CONFLICT (resource_type, action) DO NOTHING;

