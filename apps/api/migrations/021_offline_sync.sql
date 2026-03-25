CREATE TABLE IF NOT EXISTS sync_ops (
  cursor BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  op_id TEXT NOT NULL,
  client_id TEXT NULL,
  device_id TEXT NULL,
  schema_name TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  record_id UUID NOT NULL,
  base_revision INT NULL,
  patch JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  conflict_json JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, space_id, op_id)
);

CREATE INDEX IF NOT EXISTS sync_ops_pull_idx
  ON sync_ops (tenant_id, space_id, cursor ASC);

CREATE INDEX IF NOT EXISTS sync_ops_record_idx
  ON sync_ops (tenant_id, space_id, entity_name, record_id, cursor DESC);

CREATE TABLE IF NOT EXISTS sync_watermarks (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  client_id TEXT NOT NULL,
  device_id TEXT NULL,
  last_pushed_cursor BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id, client_id, device_id)
);

CREATE INDEX IF NOT EXISTS sync_watermarks_lookup_idx
  ON sync_watermarks (tenant_id, space_id, updated_at DESC);

