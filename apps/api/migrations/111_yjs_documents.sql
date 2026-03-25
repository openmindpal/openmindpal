CREATE TABLE IF NOT EXISTS yjs_documents (
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  state_b64 TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, space_id, entity_name, entity_id)
);

CREATE INDEX IF NOT EXISTS yjs_documents_updated_at_idx
  ON yjs_documents (tenant_id, space_id, entity_name, updated_at DESC);

