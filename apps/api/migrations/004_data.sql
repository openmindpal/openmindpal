CREATE TABLE IF NOT EXISTS entity_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NULL REFERENCES spaces(id),
  entity_name TEXT NOT NULL,
  schema_name TEXT NOT NULL,
  schema_version INT NOT NULL,
  payload JSONB NOT NULL,
  revision INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS entity_records_scope_entity_idx
  ON entity_records (tenant_id, space_id, entity_name, updated_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  record_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key, operation, entity_name)
);

