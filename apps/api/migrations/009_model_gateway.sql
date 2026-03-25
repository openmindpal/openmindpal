CREATE TABLE IF NOT EXISTS provider_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  model_ref TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  connector_instance_id UUID NOT NULL REFERENCES connector_instances(id),
  secret_id UUID NOT NULL REFERENCES secret_records(id),
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_bindings_unique_scope_model
  ON provider_bindings (tenant_id, scope_type, scope_id, model_ref);

CREATE INDEX IF NOT EXISTS provider_bindings_by_connector
  ON provider_bindings (tenant_id, connector_instance_id);

