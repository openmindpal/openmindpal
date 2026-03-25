CREATE TABLE IF NOT EXISTS connector_types (
  name TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  auth_method TEXT NOT NULL,
  default_risk_level TEXT NOT NULL,
  default_egress_policy JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS connector_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type_name TEXT NOT NULL REFERENCES connector_types(name),
  status TEXT NOT NULL,
  egress_policy JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS connector_instances_unique_name
  ON connector_instances (tenant_id, scope_type, scope_id, name);

CREATE INDEX IF NOT EXISTS connector_instances_by_type
  ON connector_instances (tenant_id, type_name);

CREATE TABLE IF NOT EXISTS secret_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  connector_instance_id UUID NOT NULL REFERENCES connector_instances(id),
  status TEXT NOT NULL,
  key_version INT NOT NULL DEFAULT 1,
  encrypted_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS secret_records_by_instance
  ON secret_records (tenant_id, connector_instance_id);

CREATE INDEX IF NOT EXISTS secret_records_by_scope
  ON secret_records (tenant_id, scope_type, scope_id);

INSERT INTO connector_types (name, provider, auth_method, default_risk_level, default_egress_policy)
VALUES
  ('generic.api_key', 'generic', 'api_key', 'medium', '{"allowedDomains":[]}'::jsonb),
  ('model.openai', 'openai', 'api_key', 'high', '{"allowedDomains":["api.openai.com"]}'::jsonb)
ON CONFLICT (name) DO NOTHING;

